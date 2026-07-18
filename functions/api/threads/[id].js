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
import {
  getThread, setSolved, softDeleteThread, appendMessage,
  updateRootText, markRootRecalled, editMessageInThread, removeMessageFromThread,
} from "../../_shared/threads.js";

export async function onRequestGet({ env, params }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const thread = await getThread(env, params.id);
  if (!thread || thread.deleted) return json({ ok: false, error: "Not found." }, 404);
  return json({ ok: true, thread });
}

export async function onRequestPost({ request, env, params }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { action } = body || {};
  const id = params.id;

  if (action === "solve" || action === "unsolve") {
    const thread = await setSolved(env, id, action === "solve");
    if (!thread) return json({ ok: false, error: "Not found." }, 404);
    return json({ ok: true, thread });
  }

  if (action === "delete") {
    if (!env.BRAND_EDIT_PASSWORD) return json({ ok: false, error: "Server is missing BRAND_EDIT_PASSWORD." }, 500);
    if (body.password !== env.BRAND_EDIT_PASSWORD) return json({ ok: false, error: "Wrong password." }, 403);
    const thread = await softDeleteThread(env, id);
    if (!thread) return json({ ok: false, error: "Not found." }, 404);
    return json({ ok: true });
  }

  if (action === "reply") {
    const text = (body.text || "").trim();
    if (!text) return json({ ok: false, error: "Reply text is empty." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = await getThread(env, id);
    if (!thread || thread.deleted) return json({ ok: false, error: "Not found." }, 404);

    const payload = {
      chat_id: thread.chatId,
      text,
      reply_to_message_id: thread.rootMessageId,
    };
    if (thread.topicId) payload.message_thread_id = thread.topicId;

    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) return json({ ok: false, error: data.description || "Telegram send failed." }, 502);

    const updated = await appendMessage(env, id, {
      from: body.agentName || "You",
      handle: null,
      text,
      ts: new Date().toISOString(),
      self: true,
      messageId: data.result.message_id,
    });
    return json({ ok: true, thread: updated });
  }

  if (action === "editRoot") {
    const text = (body.text || "").trim();
    if (!text) return json({ ok: false, error: "New text is empty." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = await getThread(env, id);
    if (!thread || thread.deleted) return json({ ok: false, error: "Not found." }, 404);
    if (thread.rootRecalled) return json({ ok: false, error: "This ticket's original message was already recalled — nothing to edit." }, 400);

    const method = thread.hasMedia ? "editMessageCaption" : "editMessageText";
    const payload = { chat_id: thread.chatId, message_id: thread.rootMessageId, parse_mode: "HTML" };
    if (thread.hasMedia) payload.caption = text; else payload.text = text;

    const tg = await callTelegram(env, method, payload);
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    const updated = await updateRootText(env, id, text);
    return json({ ok: true, thread: updated });
  }

  if (action === "recallRoot") {
    if (!env.BRAND_EDIT_PASSWORD) return json({ ok: false, error: "Server is missing BRAND_EDIT_PASSWORD." }, 500);
    if (body.password !== env.BRAND_EDIT_PASSWORD) return json({ ok: false, error: "Wrong password." }, 403);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = await getThread(env, id);
    if (!thread || thread.deleted) return json({ ok: false, error: "Not found." }, 404);

    const tg = await callTelegram(env, "deleteMessage", { chat_id: thread.chatId, message_id: thread.rootMessageId });
    if (!tg.ok) return json({ ok: false, error: telegramDeleteError(tg) }, 502);

    const updated = await markRootRecalled(env, id);
    return json({ ok: true, thread: updated });
  }

  if (action === "editReply") {
    const text = (body.text || "").trim();
    const messageId = body.messageId;
    if (!text || !messageId) return json({ ok: false, error: "Missing text or messageId." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = await getThread(env, id);
    if (!thread || thread.deleted) return json({ ok: false, error: "Not found." }, 404);

    const tg = await callTelegram(env, "editMessageText", { chat_id: thread.chatId, message_id: messageId, text, parse_mode: "HTML" });
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    const updated = await editMessageInThread(env, id, messageId, text);
    return json({ ok: true, thread: updated });
  }

  if (action === "recallReply") {
    if (!env.BRAND_EDIT_PASSWORD) return json({ ok: false, error: "Server is missing BRAND_EDIT_PASSWORD." }, 500);
    if (body.password !== env.BRAND_EDIT_PASSWORD) return json({ ok: false, error: "Wrong password." }, 403);
    const messageId = body.messageId;
    if (!messageId) return json({ ok: false, error: "Missing messageId." }, 400);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

    const thread = await getThread(env, id);
    if (!thread || thread.deleted) return json({ ok: false, error: "Not found." }, 404);

    const tg = await callTelegram(env, "deleteMessage", { chat_id: thread.chatId, message_id: messageId });
    if (!tg.ok) return json({ ok: false, error: telegramDeleteError(tg) }, 502);

    const updated = await removeMessageFromThread(env, id, messageId);
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
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
