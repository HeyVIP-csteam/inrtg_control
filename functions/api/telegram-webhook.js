/**
 * telegram-webhook.js
 *
 * Register this URL with Telegram once (from your own machine, not this
 * app — Telegram calls it, we don't call ourselves):
 *
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *     -d "url=https://inrtg-control.pages.dev/api/telegram-webhook" \
 *     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
 *     -d "allowed_updates=[\"message\"]"
 *
 * `TELEGRAM_WEBHOOK_SECRET` is a string you make up yourself (any random
 * value works) and set as a Cloudflare secret with that same name — it's
 * how we verify a request genuinely came from Telegram and not some rando
 * hitting this URL directly.
 *
 * Every message posted in the bot's groups (agent replies included) is
 * delivered here. A message that's a genuine, explicit reply to one of our
 * ticket messages is matched exactly. Anything else — a plain message
 * typed in the topic, no reply at all — is attributed to whichever
 * thread in that same chat/topic was most recently active, so agents
 * don't have to remember to hit "Reply" for it to show up.
 */
import { findThreadIdByMessage, findLatestThreadForTopic, appendMessage } from "../_shared/threads.js";

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
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  if (!msg.text && !msg.caption) return; // Nothing worth recording (join/leave/pin service messages, etc.)

  const replyTarget = msg.reply_to_message;
  const isAutoTopicReply = replyTarget && msg.is_topic_message && msg.message_thread_id === replyTarget.message_id;
  const isGenuineReply = replyTarget && !isAutoTopicReply;

  let threadId = null;
  if (isGenuineReply) {
    // Explicit reply to a specific message — try the exact match first.
    threadId = await findThreadIdByMessage(env, msg.chat.id, replyTarget.message_id);
  }
  if (!threadId) {
    // No reply at all, an auto-attached topic-root "reply", or an explicit
    // reply that didn't match anything we're tracking — fall back to the
    // most recently active thread in this same chat + topic.
    threadId = await findLatestThreadForTopic(env, msg.chat.id, msg.message_thread_id ?? null);
  }
  if (!threadId) return;

  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Unknown";
  await appendMessage(env, threadId, {
    from: name,
    handle: msg.from?.username ? `@${msg.from.username}` : null,
    text: msg.text || msg.caption || "(attachment)",
    ts: new Date((msg.date || Date.now() / 1000) * 1000).toISOString(),
    self: false,
  });
}
