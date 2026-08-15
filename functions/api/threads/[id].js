/**
 * GET  /api/threads/<id>  -> { ok, thread }  (full record incl. messages)
 * POST /api/threads/<id>  -> body: { action, password?, text?, messageId? }
 *   Actions:
 *   - solve / unsolve: no password — any agent can toggle from the dashboard.
 *   - delete: requires `password` (deletes our tracking record only —
 *     Telegram messages and the Google Sheet row are untouched).
 *   - reply: sends `text` back into the Telegram thread as a reply to the
 *     original ticket message, and records it as a "self" message.
 *   - editRoot { text }: edits the original ticket message on Telegram.
 *   - recallRoot { password }: deletes the original ticket message from
 *     Telegram (password-gated — this removes it from the group for real).
 *   - editReply { messageId, text }: edits one of our own past replies.
 *   - recallReply { messageId, password }: deletes one of our own past
 *     replies from Telegram (password-gated).
 *
 *   Only messages our own bot sent (the root ticket + "self" replies) can
 *   be edited/recalled — Telegram doesn't let a bot edit or delete
 *   messages other people typed directly in the group.
 */
/**
 * GET  /api/threads/<id>  -> { ok, thread }  (full record incl. messages)
 * POST /api/threads/<id>  -> body: { action, text?, messageId? }
 *   Actions:
 *   - solve / unsolve: any logged-in agent who can see this thread's brand.
 *   - delete: untracks our record (Telegram/Sheet untouched). No separate
 *     password anymore — being logged in as an account that can see this
 *     brand is the authorization; `by` is filled from that account.
 *   - reply: sends `text` back into the Telegram thread as a reply to the
 *     original ticket message, and records it as a "self" message.
 *   - editRoot { text }: edits the original ticket message on Telegram.
 *   - recallRoot: deletes the original ticket message from Telegram.
 *   - editReply { messageId, text }: edits one of our own past replies.
 *   - recallReply { messageId }: deletes one of our own past replies.
 *   - editDetails { fields, fieldMap }: field-level edit ("🔄 Sync to
 *     Sheet") — regenerates the Telegram message AND (if this ticket's
 *     submission wrote a trackable Sheet row — see submit.js's
 *     `sheetRef`) that Sheet row, from a corrected field-value map.
 *     Threads created before this feature existed (no brandId saved)
 *     reject this action; use editRoot instead for those.
 *
 *   Only messages our own bot sent (the root ticket + "self" replies) can
 *   be edited/recalled — Telegram doesn't let a bot edit or delete
 *   messages other people typed directly in the group.
 *
 *   Every action requires a logged-in account (X-Agent-Token) that's
 *   allowed to see this thread's brand — see _shared/accounts.js.
 *   A thread outside an account's allowed brands 404s exactly like it
 *   doesn't exist, same as it's filtered out of the sidebar list.
 */
import {
  getThread, setSolved, softDeleteThread, appendMessage,
  updateRootText, updateThreadDetails, markRootRecalled, editMessageInThread, removeMessageFromThread,
  logDeletion,
} from "../../_shared/threads.js";
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { BRANDS, MODULE_META, MESSAGE_TEMPLATE, PROMOTION_MESSAGE_TEMPLATE } from "../../_shared/routing.js";
import { updateRowByColumns } from "../../_shared/googleSheets.js";
import { buildTicketMessage, buildTitleAndSummary, resolveColumnValues } from "../../_shared/messageBuilders.js";
import { compressImageForTelegram } from "../../_shared/telegramImageCompress.js";

export async function onRequestGet({ request, env, params }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);
  const thread = await getThread(env, params.id);
  if (!thread || thread.deleted || !canSeeBrand(account, thread.brand)) return json({ ok: false, error: "Not found." }, 404);
  return json({ ok: true, thread });
}

// Top-level safety net — same reasoning as submit.js: everything below
// already handles its own expected failure modes (bad JSON, Telegram
// errors via callTelegram's tg.ok checks) with a clean { ok:false, error }
// response, but a handful of actions (editRoot/recallRoot/editReply/
// recallReply) call the Telegram API directly without their own try/catch
// — a network hiccup or a non-JSON response from Telegram would otherwise
// throw uncaught and come back as a raw platform error instead of JSON.
// This outer catch is the guarantee that never happens.
export async function onRequestPost(context) {
  try {
    return await handleThreadAction(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleThreadAction({ request, env, params }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { action } = body || {};
  const id = params.id;

  // Every action operates on an existing thread the account must be
  // allowed to see — check once up front instead of in every branch.
  const existingThread = await getThread(env, id);
  if (!existingThread || existingThread.deleted || !canSeeBrand(account, existingThread.brand)) {
    return json({ ok: false, error: "Not found." }, 404);
  }

  if (action === "solve" || action === "unsolve") {
    const thread = await setSolved(env, id, action === "solve");
    if (!thread) return json({ ok: false, error: "Not found." }, 404);
    return json({ ok: true, thread });
  }

  if (action === "delete") {
    const before = existingThread;
    const thread = await softDeleteThread(env, id);
    if (!thread) return json({ ok: false, error: "Not found." }, 404);
    await logDeletion(env, {
      type: "delete-thread",
      threadId: id,
      threadTitle: before?.title || thread.title,
      brand: before?.brand || thread.brand,
      content: `Ticket + ${thread.messages?.length || 0} message(s) untracked (Telegram/Sheet untouched)`,
      by: account.username,
    });
    return json({ ok: true });
  }

  if (action === "reply") {
    const text = (body.text || "").trim();
    // { name, type, dataUrl }[] — also accepts the old singular
    // `attachment` shape (pre-multi-select clients) wrapped into a
    // 1-item array, so nothing older breaks.
    const attachments = Array.isArray(body.attachments) && body.attachments.length
      ? body.attachments
      : (body.attachment ? [body.attachment] : []);
    const replyToMessageId = body.replyToMessageId || null;
    if (!text && !attachments.length) return json({ ok: false, error: "Reply text is empty." }, 400);
    if (attachments.length > 10) return json({ ok: false, error: "Telegram allows at most 10 attachments in one message — trim your selection and send the rest separately." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;

    let messageId;
    let messageIds = [];
    let attachmentFileIds = [];
    let attachmentNames = [];
    try {
      if (attachments.length) {
        const sent = await sendTelegramReplyAttachments(env, thread, text, attachments, replyToMessageId);
        messageId = sent.messageId;
        messageIds = sent.messageIds;
        attachmentFileIds = sent.attachmentFileIds;
        attachmentNames = sent.attachmentNames;
      } else {
        messageId = await sendTelegramText(env, thread, text, replyToMessageId);
        messageIds = [messageId];
      }
    } catch (e) {
      console.error(`[threads/[id].js] Reply send failed for thread ${thread.id}: ${String(e.message || e)}`);
      return json({ ok: false, error: String(e.message || e) }, 502);
    }

    // Reply attachments used to only ever go to Telegram — nothing about
    // them was saved on our own side, so there was no way to view one
    // again from this dashboard afterward (the sidebar just showed a
    // plain, unclickable "📎 attachment" label forever). Deliberately NOT
    // storing a copy anywhere (business owner's call, to avoid using any
    // R2 storage for this) — instead, just remember Telegram's own
    // `file_id` for the upload (returned by sendPhoto/sendDocument above,
    // valid for as long as the file exists on Telegram's servers). The
    // dashboard fetches the actual bytes live, on demand, only when
    // someone actually clicks to view it — see
    // functions/api/attachment/[fileId].js, which resolves that file_id
    // through Telegram's getFile + file download endpoints and proxies
    // the bytes back (never exposing TELEGRAM_BOT_TOKEN to the browser —
    // the token only ever appears in this server-side proxy's own
    // outbound requests, same reasoning as why R2 files get served
    // through /api/screenshot/<key> instead of a raw bucket URL).
    //
    // attachmentFileId/attachmentName (singular) are kept alongside the
    // new attachmentFileIds/attachmentNames (arrays) — just [0] of the
    // array — so nothing else in this project that might still read the
    // singular fields breaks.
    const updated = await appendMessage(env, id, {
      from: account.username,
      handle: null,
      text: text || (attachments.length > 1 ? `📎 ${attachments.length} attachments` : `📎 ${attachments[0]?.name || "attachment"}`),
      hasAttachment: attachments.length > 0,
      attachmentName: attachmentNames[0] || null,
      attachmentFileId: attachmentFileIds[0] || null,
      attachmentNames,
      attachmentFileIds,
      ts: new Date().toISOString(),
      self: true,
      delivered: true,
      messageId,
      messageIds,
      replyToMessageId: replyToMessageId || null,
    });
    return json({ ok: true, thread: updated });
  }

  if (action === "editRoot") {
    const text = (body.text || "").trim();
    if (!text) return json({ ok: false, error: "New text is empty." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;
    if (thread.rootRecalled) return json({ ok: false, error: "This ticket's original message was already recalled — nothing to edit." }, 400);

    const method = thread.hasMedia ? "editMessageCaption" : "editMessageText";
    const payload = { chat_id: thread.chatId, message_id: thread.rootMessageId, parse_mode: "HTML" };
    if (thread.hasMedia) payload.caption = text; else payload.text = text;

    const tg = await callTelegram(env, method, payload);
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    const updated = await updateRootText(env, id, text);
    return json({ ok: true, thread: updated });
  }

  // Field-level edit — the "🔄 Sync to Sheet" flow. Regenerates the
  // Telegram message text AND (if this ticket wrote a trackable Sheet
  // row) the Sheet row itself, from a corrected { fieldKey: value } map,
  // using the exact same builder functions submit.js used at creation
  // time (see _shared/messageBuilders.js) — never a hand-parsed guess at
  // what the old message text meant.
  //
  // Body: { action: "editDetails", fields: [{key,label,value}], fieldMap }
  // — same shape submit.js's own request body uses for these two, built
  // client-side in threads.html from window.MODULES (schemas.js), same
  // as the original submission form does.
  if (action === "editDetails") {
    const { fields, fieldMap } = body || {};
    if (!Array.isArray(fields) || !fieldMap || typeof fieldMap !== "object") {
      return json({ ok: false, error: "Missing fields or fieldMap." }, 400);
    }
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;
    if (thread.rootRecalled) return json({ ok: false, error: "This ticket's original message was already recalled — nothing to edit." }, 400);
    // Threads created before this feature existed (or that never got a
    // brandId for some other reason) don't have enough saved to safely
    // rebuild a message the same way submit.js originally did — fail
    // clearly instead of silently producing a differently-formatted
    // message. The plain ✏️ text editor (editRoot above) still works on
    // any thread, old or new.
    const brand = thread.brandId && BRANDS[thread.brandId];
    if (!brand) return json({ ok: false, error: "This ticket doesn't support field-level editing (created before this feature existed) — use the ✏️ text editor instead." }, 400);
    const meta = MODULE_META[thread.module];
    if (!meta) return json({ ok: false, error: `Unknown module "${thread.module}".` }, 400);

    const reporter = thread.submitter;
    const screenshotLink = thread.screenshotLink || "";
    const text = buildTicketMessage({
      moduleId: thread.module, brandId: thread.brandId, meta, brand, fieldMap, fields, reporter, screenshotLink,
      messageTemplate: MESSAGE_TEMPLATE, promotionMessageTemplate: PROMOTION_MESSAGE_TEMPLATE,
    });

    const method = thread.hasMedia ? "editMessageCaption" : "editMessageText";
    const payload = { chat_id: thread.chatId, message_id: thread.rootMessageId, parse_mode: "HTML" };
    if (thread.hasMedia) payload.caption = text; else payload.text = text;

    const tg = await callTelegram(env, method, payload);
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    // Sheet sync is best-effort/non-fatal, same reasoning as submit.js's
    // own Sheet write: the Telegram message above is the part that just
    // succeeded and is now the source of truth; a Sheet hiccup shouldn't
    // undo that or block the rest of this action.
    let sheetSynced = false;
    let sheetError = null;
    if (thread.sheetRef) {
      try {
        const values = resolveColumnValues(thread.sheetRef.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks: [] });
        await updateRowByColumns(env, thread.sheetRef.sheetId, thread.sheetRef.tab, thread.sheetRef.startColumn, thread.sheetRef.row, values);
        sheetSynced = true;
      } catch (e) {
        sheetError = String(e.message || e);
      }
    }

    const { title, summary } = buildTitleAndSummary({ meta, brand, fieldMap, fields });
    const updated = await updateThreadDetails(env, id, { fieldMap, rootText: text, title, summary });
    return json({ ok: true, thread: updated, sheetHasRef: !!thread.sheetRef, sheetSynced, sheetError });
  }

  if (action === "recallRoot") {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;
    // A ticket sent as a multi-photo Telegram album has one message_id
    // PER PHOTO, only the first of which is `rootMessageId` — deleting
    // just that one used to leave the rest of the album sitting in the
    // group untouched. rootMessageIds (added alongside "Generate to
    // another Topic") has every one of them; threads from before that
    // existed fall back to the single rootMessageId, same as before.
    // Deletes run in parallel and a FAILURE ON ANY ONE of them still
    // fails the whole action (rather than silently reporting success
    // while some photos remain) — an agent clicking Recall needs to
    // know if it didn't fully work.
    const idsToDelete = thread.rootMessageIds && thread.rootMessageIds.length ? thread.rootMessageIds : [thread.rootMessageId];
    const results = await Promise.all(idsToDelete.map((mid) => callTelegram(env, "deleteMessage", { chat_id: thread.chatId, message_id: mid })));
    const firstFailure = results.find((r) => !r.ok);
    if (firstFailure) return json({ ok: false, error: telegramDeleteError(firstFailure) }, 502);

    const updated = await markRootRecalled(env, id);
    await logDeletion(env, {
      type: "recall-root",
      threadId: id,
      threadTitle: thread.title,
      brand: thread.brand,
      content: thread.rootText || "(no text)",
      by: account.username,
    });
    return json({ ok: true, thread: updated });
  }

  if (action === "editReply") {
    const text = (body.text || "").trim();
    const messageId = body.messageId;
    if (!text || !messageId) return json({ ok: false, error: "Missing text or messageId." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const tg = await callTelegram(env, "editMessageText", { chat_id: existingThread.chatId, message_id: messageId, text, parse_mode: "HTML" });
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    const updated = await editMessageInThread(env, id, messageId, text);
    return json({ ok: true, thread: updated });
  }

  if (action === "recallReply") {
    const messageId = body.messageId;
    if (!messageId) return json({ ok: false, error: "Missing messageId." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = existingThread;
    const recalledMsg = thread.messages.find((m) => m.self && m.messageId === messageId);
    // A multi-attachment reply went out as a Telegram album — one
    // message_id PER attachment, only the first (messageId) is what the
    // ↩️ button references. Delete every id in the group, not just the
    // first, or the rest silently stay behind in the chat forever.
    const idsToDelete = recalledMsg?.messageIds && recalledMsg.messageIds.length ? recalledMsg.messageIds : [messageId];
    const results = await Promise.all(idsToDelete.map((mid) => callTelegram(env, "deleteMessage", { chat_id: thread.chatId, message_id: mid })));
    const firstFailure = results.find((r) => !r.ok);
    if (firstFailure) return json({ ok: false, error: telegramDeleteError(firstFailure) }, 502);

    const updated = await removeMessageFromThread(env, id, messageId);
    await logDeletion(env, {
      type: "recall-reply",
      threadId: id,
      threadTitle: thread.title,
      brand: thread.brand,
      content: recalledMsg?.text || "(no text)",
      by: account.username,
    });
    return json({ ok: true, thread: updated });
  }

  return json({ ok: false, error: `Unknown action "${action}".` }, 400);
}

async function callTelegram(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendTelegramText(env, thread, text, replyToMessageId) {
  const payload = { chat_id: thread.chatId, text, reply_to_message_id: replyToMessageId || thread.rootMessageId };
  if (thread.topicId) payload.message_thread_id = thread.topicId;
  const data = await callTelegram(env, "sendMessage", payload);
  if (!data.ok) throw new Error(data.description || "Telegram send failed.");
  return data.result.message_id;
}

// Sends a screenshot/PDF attached to a reply, same base64 → Blob approach
// submit.js already uses for the original ticket's attachments.
// Browsers usually set File.type correctly, but not always — a file
// re-uploaded after being downloaded from somewhere else (e.g. saved out
// of Telegram itself, which often renames photos to a plain numeric
// filename like "6111620814923827982_1.jpg") can come through with an
// empty or generic type. Falling back to the file extension catches
// those cases, so an actual photo still gets sent via sendPhoto (shows
// as an inline thumbnail in Telegram) instead of silently degrading to
// sendDocument (shows as a bare 📎 filename with no preview).
function looksLikeImage(type, name) {
  if ((type || "").startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name || "");
}

// Same fallback reasoning as looksLikeImage above — trust the browser's
// File.type first, fall back to extension for files that arrive with a
// missing/generic type (e.g. re-uploaded after being saved out of some
// other app). Used to route video attachments through sendVideo (native
// inline player + thumbnail in Telegram) instead of sendDocument (bare
// 📎 filename, no preview/playback in-chat).
function looksLikeVideo(type, name) {
  if ((type || "").startsWith("video/")) return true;
  return /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(name || "");
}

// Classifies one attachment into the three Telegram upload "lanes" this
// file works with. Centralized here so the single-send path, the
// media-group grouping decision, and the media-group per-item `type`
// field all agree on the same classification.
function attachmentKind(type, name) {
  if (looksLikeImage(type, name)) return "photo";
  if (looksLikeVideo(type, name)) return "video";
  return "document";
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Top-level entry point for a reply that has 1+ attachments — mirrors the
// three-way split submit.js's sendTelegramWithAttachments() already uses
// for the original ticket (single item / media album / mixed-with-
// documents), just with reply_to_message_id threaded through every
// Telegram call so it lands as a reply instead of a fresh message.
// "Media album" covers photos AND videos together — Telegram allows
// mixing those two in one sendMediaGroup call, just not documents.
async function sendTelegramReplyAttachments(env, thread, text, attachments, replyToMessageId) {
  const replyId = replyToMessageId || thread.rootMessageId;

  if (attachments.length === 1) {
    const { messageId, fileId, name } = await sendReplySingleWithCaption(env, thread, text, attachments[0], replyId);
    return {
      messageId,
      messageIds: [messageId],
      attachmentFileIds: fileId ? [fileId] : [],
      attachmentNames: fileId ? [name] : [],
    };
  }

  // Telegram's sendMediaGroup album accepts a MIX of photos and videos in
  // one album (just not documents) — so the grouping check is "does
  // nothing here need sendDocument", not "is everything a photo".
  const allMedia = attachments.every((a) => attachmentKind(a.type, a.name) !== "document");
  if (allMedia) {
    const sent = await sendReplyMediaGroup(env, thread, text, attachments, replyId);
    return {
      messageId: sent[0].messageId,
      messageIds: sent.map((s) => s.messageId),
      attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
      attachmentNames: sent.filter((s) => s.fileId).map((s) => s.name),
    };
  }

  // Mixed image/document types can't share one album — send each as its
  // own message in sequence, caption only on the first so it still reads
  // as one reply, not repeated noise on every attachment.
  const sent = [];
  for (let i = 0; i < attachments.length; i++) {
    const result = await sendReplySingleWithCaption(env, thread, i === 0 ? text : "", attachments[i], replyId);
    sent.push(result);
  }
  return {
    messageId: sent[0].messageId,
    messageIds: sent.map((s) => s.messageId),
    attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
    attachmentNames: sent.filter((s) => s.fileId).map((s) => s.name),
  };
}

async function sendReplySingleWithCaption(env, thread, text, attachment, replyId) {
  let { name, type, dataUrl } = attachment;
  let bytes = dataUrlToBytes(dataUrl);

  const kind = attachmentKind(type, name);
  // Same "compress before Telegram can reject it" fix as submit.js — see
  // telegram-photo-limit-fix.md. Only photos hit Telegram's 10MB
  // sendPhoto limit; sendVideo/sendDocument have their own separate
  // (much higher) limits and are left untouched.
  if (kind === "photo") {
    const compressed = await compressImageForTelegram(bytes, { type, name });
    bytes = compressed.bytes;
    type = compressed.type;
    name = compressed.name;
  }
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });

  const method = kind === "photo" ? "sendPhoto" : kind === "video" ? "sendVideo" : "sendDocument";
  const field = kind; // "photo" | "video" | "document" — same names as the FormData field Telegram expects

  const form = new FormData();
  form.append("chat_id", thread.chatId);
  if (thread.topicId) form.append("message_thread_id", String(thread.topicId));
  form.append("reply_to_message_id", String(replyId));
  form.append(field, blob, name || "attachment");
  if (text) form.append("caption", text);

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[threads/[id].js] Reply attachment send failed (${method}): ${data.description || "unknown error"}`);
    throw new Error(data.description || "Telegram send failed.");
  }

  // sendPhoto returns an ARRAY of sizes (Telegram auto-generates several
  // resolutions) — the last one is the largest/original-quality version,
  // which is the one worth keeping. sendVideo and sendDocument each
  // return a single object instead, no array. Either way, this file_id is
  // what functions/api/attachment/[fileId].js needs later to fetch the
  // actual bytes on demand — see the comment where this function is
  // called for why nothing is stored/uploaded anywhere at send time.
  const fileId = kind === "photo"
    ? data.result.photo?.[data.result.photo.length - 1]?.file_id || null
    : kind === "video"
      ? data.result.video?.file_id || null
      : data.result.document?.file_id || null;

  return { messageId: data.result.message_id, fileId, name };
}

// Sends 2+ photos/videos as one Telegram album (sendMediaGroup) —
// all-or-nothing multipart upload, caption goes on the first item only
// (Telegram shows it as the whole album's caption regardless of which
// item it's on). Photos and videos can be freely mixed within one album.
async function sendReplyMediaGroup(env, thread, text, attachments, replyId) {
  const form = new FormData();
  form.append("chat_id", thread.chatId);
  if (thread.topicId) form.append("message_thread_id", String(thread.topicId));
  form.append("reply_to_message_id", String(replyId));

  const media = attachments.map((att, i) => {
    const entry = { type: attachmentKind(att.type, att.name), media: `attach://file${i}` };
    if (i === 0 && text) entry.caption = text;
    return entry;
  });
  form.append("media", JSON.stringify(media));

  // Compress every photo before building the multipart body — a reply
  // album is just as all-or-nothing as a ticket album (see
  // telegram-photo-limit-fix.md), one oversized photo would silently
  // drop the whole reply. Videos pass through untouched (photon only
  // handles still images; sendVideo/sendMediaGroup's video limit is
  // separate and much higher anyway).
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const isPhoto = attachmentKind(att.type, att.name) === "photo";
    const rawBytes = dataUrlToBytes(att.dataUrl);
    const { bytes, type, name } = isPhoto
      ? await compressImageForTelegram(rawBytes, { type: att.type, name: att.name })
      : { bytes: rawBytes, type: att.type, name: att.name };
    const blob = new Blob([bytes], { type: type || "application/octet-stream" });
    form.append(`file${i}`, blob, name || `file${i}`);
  }

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[threads/[id].js] Reply sendMediaGroup rejected by Telegram (${attachments.length} attachment(s)): ${data.description || "unknown error"}`);
    throw new Error(data.description || "Telegram send failed.");
  }
  // attachments[i] lines up positionally with data.result[i] —
  // sendMediaGroup returns results in the same order the media items
  // were submitted in (same assumption submit.js's own sendMediaGroup
  // already relies on). Each result carries either a `photo` array or a
  // `video` object depending on which type that particular item was.
  return data.result.map((m, i) => ({
    messageId: m.message_id,
    fileId: (m.photo?.[m.photo.length - 1]?.file_id) || m.video?.file_id || null,
    name: attachments[i]?.name,
  }));
}

// Telegram's own wording is fairly technical — translate the common cases
// into something an agent can actually act on.
function telegramEditError(tg) {
  const desc = tg.description || "";
  if (/message is not modified/i.test(desc)) return "That's already the current text.";
  if (/message can't be edited|MESSAGE_ID_INVALID/i.test(desc)) return "Telegram won't let this message be edited anymore (likely too old, or it was sent as an album).";
  return desc || "Edit failed.";
}
function telegramDeleteError(tg) {
  const desc = tg.description || "";
  if (/message to delete not found/i.test(desc)) return "Already gone from Telegram (maybe someone deleted it manually).";
  if (/message can't be deleted/i.test(desc)) return "Telegram won't let this be deleted anymore — it's likely older than 48 hours.";
  return desc || "Recall failed.";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
