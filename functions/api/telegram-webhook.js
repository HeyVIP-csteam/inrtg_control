/**
 * telegram-webhook.js
 *
 * Register this URL with Telegram once (from your own machine, not this
 * app — Telegram calls it, we don't call ourselves):
 *
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *     -d "url=https://inrtg-control.pages.dev/api/telegram-webhook" \
 *     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
 *     -d "allowed_updates=[\"message\",\"edited_message\"]"
 *
 * NOTE the "edited_message" entry above — if this webhook was registered
 * with an earlier version of this file (before edit-tracking existed),
 * Telegram is still only configured to send plain "message" updates and
 * won't call this endpoint at all when someone edits a message, no matter
 * what the code below does. Re-run setWebhook with the command above
 * (once, from your own machine) to pick up edits going forward — nothing
 * else needs to change server-side.
 *
 * `TELEGRAM_WEBHOOK_SECRET` is a string you make up yourself (any random
 * value works) and set as a Cloudflare secret with that same name — it's
 * how we verify a request genuinely came from Telegram and not some rando
 * hitting this URL directly.
 *
 * Every message posted in the bot's groups (agent replies included) is
 * delivered here. Only a genuine, explicit reply gets matched — but that
 * now includes chains: a reply to our root ticket message, a reply to
 * THAT reply (e.g. someone @-tags another team who then replies), and so
 * on, as long as each link in the chain is an explicit reply to a message
 * we've already recorded. If that ticket was already marked Solved, an
 * explicit reply reopens it, since replying to it on purpose is a
 * deliberate signal. Anything else — a plain message typed in the topic
 * with no reply, Telegram's auto-attached "reply to the topic root" that
 * isn't a real reply, or a reply to some message outside this chain — is
 * intentionally ignored rather than guessed at, so a message never lands
 * on the wrong ticket.
 *
 * edited_message updates (someone editing a reply they already sent,
 * directly inside Telegram) are handled separately, below — see
 * handleEditedMessage(). This only ever applies to a message a HUMAN
 * sent: our own bot-sent messages can only be changed through the Bot
 * API (the dashboard's ✏️ edit buttons — see functions/api/threads/
 * [id].js), which write straight to storage themselves and never go
 * through this webhook either way, so there's no risk of double-handling
 * the same edit from two different paths.
 */
import { findThreadIdByMessage, appendMessage, editIncomingMessageInThread } from "../_shared/threads.js";

export async function onRequestPost({ request, env }) {
  // Verify the request really came from Telegram.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok"); // Always 200 quickly — Telegram retries on non-2xx.
  }

  try {
    await handleUpdate(env, update);
  } catch {
    // Swallow errors — a broken reply-sync should never make Telegram think
    // the webhook is unhealthy and start retrying/backing off.
  }
  return new Response("ok");
}

async function handleUpdate(env, update) {
  if (!env.THREADS_KV) return;
  if (update.edited_message) return handleEditedMessage(env, update.edited_message);
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const hasContent = msg.text || msg.caption || msg.photo || msg.document || msg.video || msg.voice || msg.sticker;
  if (!hasContent) return; // Nothing worth recording (join/leave/pin service messages, etc.)

  const replyTarget = msg.reply_to_message;
  const isAutoTopicReply = replyTarget && msg.is_topic_message && msg.message_thread_id === replyTarget.message_id;
  const isGenuineReply = replyTarget && !isAutoTopicReply;
  if (!isGenuineReply) return; // Not a deliberate reply — ignore, don't guess.

  const threadId = await findThreadIdByMessage(env, msg.chat.id, replyTarget.message_id);
  if (!threadId) return; // Reply to something we're not tracking.

  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Unknown";

  // Incoming photo/document/video/voice/sticker from someone replying
  // IN Telegram itself (not from our own website's reply box — that's a
  // separate path, see functions/api/threads/[id].js's "reply" action).
  // This used to just hardcode the literal text "(attachment)" with
  // nothing else recorded — no file_id, nothing — so there was never any
  // way to actually view what was sent, even after the dashboard grew
  // the ability to preview OUR OWN outgoing attachments. Same fix,
  // applied to the other direction: capture Telegram's own file_id here
  // too, so the same /api/attachment/[fileId].js live-proxy + lightbox
  // (public/threads.html's viewAttachment()) can show it.
  let attachmentFileId = null;
  let attachmentName = null;
  if (msg.photo && msg.photo.length) {
    attachmentFileId = msg.photo[msg.photo.length - 1].file_id; // largest size
    attachmentName = "photo.jpg";
  } else if (msg.document) {
    attachmentFileId = msg.document.file_id;
    attachmentName = msg.document.file_name || "document";
  } else if (msg.video) {
    attachmentFileId = msg.video.file_id;
    attachmentName = msg.video.file_name || "video.mp4";
  } else if (msg.voice) {
    attachmentFileId = msg.voice.file_id;
    attachmentName = "voice message";
  } else if (msg.sticker) {
    attachmentFileId = msg.sticker.file_id;
    attachmentName = "sticker";
  }

  await appendMessage(env, threadId, {
    from: name,
    handle: msg.from?.username ? `@${msg.from.username}` : null,
    text: msg.text || msg.caption || (attachmentFileId ? `📎 ${attachmentName}` : "(attachment)"),
    hasAttachment: !!attachmentFileId,
    attachmentName,
    attachmentFileId,
    ts: new Date((msg.date || Date.now() / 1000) * 1000).toISOString(),
    self: false,
    messageId: msg.message_id,
    replyToMessageId: replyTarget.message_id,
  });
}

// Someone edited a message directly inside Telegram — message_id stays
// the same as the original send, only the content and edit_date change,
// so we can look it up in msgid: the exact same way a brand-new reply
// does (findThreadIdByMessage). Only ever fires for a message a HUMAN
// sent (see the is_bot check below) — our own bot-sent messages are only
// ever edited through the dashboard's own ✏️ buttons, a completely
// separate path (functions/api/threads/[id].js) that never touches this
// webhook, so there's no double-handling risk between the two.
async function handleEditedMessage(env, msg) {
  if (!msg || msg.from?.is_bot) return;

  // Same attachment extraction as a brand-new incoming message (see
  // handleUpdate above) — an edit can add, swap, or (via Telegram's
  // editMessageMedia) remove the attached photo/document/video/voice/
  // sticker independently of whether the caption changed at all. This
  // used to only be captured on first send, never on edit, so someone
  // attaching a photo to an already-sent message (or replacing one)
  // never showed up here — the edit was either dropped entirely (no
  // caption change) or landed as a text-only update with the image
  // missing.
  let attachmentFileId = null;
  let attachmentName = null;
  if (msg.photo && msg.photo.length) {
    attachmentFileId = msg.photo[msg.photo.length - 1].file_id;
    attachmentName = "photo.jpg";
  } else if (msg.document) {
    attachmentFileId = msg.document.file_id;
    attachmentName = msg.document.file_name || "document";
  } else if (msg.video) {
    attachmentFileId = msg.video.file_id;
    attachmentName = msg.video.file_name || "video.mp4";
  } else if (msg.voice) {
    attachmentFileId = msg.voice.file_id;
    attachmentName = "voice message";
  } else if (msg.sticker) {
    attachmentFileId = msg.sticker.file_id;
    attachmentName = "sticker";
  }

  const hasContent = msg.text || msg.caption || attachmentFileId;
  if (!hasContent) return; // nothing left to show at all — ignore

  const threadId = await findThreadIdByMessage(env, msg.chat.id, msg.message_id);
  if (!threadId) return; // editing something we're not tracking — ignore, don't guess

  const text = msg.text || msg.caption || (attachmentFileId ? `📎 ${attachmentName}` : "");
  const attachment = attachmentFileId ? { fileId: attachmentFileId, name: attachmentName } : null;
  await editIncomingMessageInThread(env, threadId, msg.message_id, text, attachment);
}
