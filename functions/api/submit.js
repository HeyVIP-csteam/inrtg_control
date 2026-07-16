import { BRANDS, RECORD_TO_SHEET, MODULE_META } from "../_shared/routing.js";
import { appendRowToSheet } from "../_shared/googleSheets.js";

const VALID_MODULES = Object.keys(MODULE_META);

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { module: moduleId, brand: brandId, reporter, fields, attachments } = body || {};

  if (!VALID_MODULES.includes(moduleId)) {
    return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);
  }
  const brand = BRANDS[brandId];
  if (!brand) {
    return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
  }
  if (!reporter || !Array.isArray(fields)) {
    return json({ ok: false, error: "Missing reporter or fields." }, 400);
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);
  }

  const meta = MODULE_META[moduleId];
  const route = brand.telegram[moduleId] || brand.telegram.default;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const text = buildMessage({ meta, brandName: brand.name, reporter, fields, timestamp });

  // 1. Send to Telegram
  const tgResult = await sendTelegramMessage({ botToken, route, text });
  if (!tgResult.ok) {
    return json({ ok: false, error: `Telegram send failed: ${tgResult.error}` }, 502);
  }

  // 1b. Send any attachments as follow-up photos/documents in the same chat/topic.
  const attachmentErrors = [];
  if (Array.isArray(attachments) && attachments.length) {
    for (const att of attachments.slice(0, 10)) {
      try {
        await sendTelegramAttachment({ botToken, route, attachment: att });
      } catch (e) {
        attachmentErrors.push(`${att.name}: ${e.message || e}`);
      }
    }
  }

  // 2. Optionally log to the brand's Google Sheet (fire-and-await, but don't
  //    fail the whole request if the sheet write fails — Telegram already has it).
  let sheetLogged = false;
  let sheetError = null;
  if (RECORD_TO_SHEET[moduleId] && brand.sheetId) {
    try {
      const row = {
        timestamp,
        brand: brand.name,
        reporter,
        ...Object.fromEntries(fields.map((f) => [f.key, f.value])),
        attachments: (attachments || []).map((a) => a.name).join(", "),
      };
      await appendRowToSheet(env, brand.sheetId, moduleId, row);
      sheetLogged = true;
    } catch (e) {
      sheetError = String(e.message || e);
    }
  }

  return json({
    ok: true,
    telegramMessageId: tgResult.messageId,
    sheetLogged,
    sheetError,
    attachmentErrors: attachmentErrors.length ? attachmentErrors : undefined,
  });
}

function buildMessage({ meta, brandName, reporter, fields, timestamp }) {
  const lines = [
    `${meta.emoji} <b>New ${escapeHtml(meta.name)} — ${escapeHtml(brandName)}</b>`,
    "",
    ...fields
      .filter((f) => f.value)
      .map((f) => `<b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}`),
    "",
    `🧑‍💼 Submitted by ${escapeHtml(reporter)}`,
    `🕒 ${timestamp}`,
  ];
  return lines.join("\n");
}

async function sendTelegramMessage({ botToken, route, text }) {
  const payload = {
    chat_id: route.chatId,
    text,
    parse_mode: "HTML",
  };
  if (route.topicId) payload.message_thread_id = route.topicId;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    return { ok: false, error: data.description || "unknown Telegram error" };
  }
  return { ok: true, messageId: data.result.message_id };
}

async function sendTelegramAttachment({ botToken, route, attachment }) {
  const { name, type, dataUrl } = attachment;
  const commaIdx = dataUrl.indexOf(",");
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const bytes = base64ToBytes(base64);
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });

  const isImage = (type || "").startsWith("image/");
  const method = isImage ? "sendPhoto" : "sendDocument";
  const field = isImage ? "photo" : "document";

  const form = new FormData();
  form.append("chat_id", route.chatId);
  if (route.topicId) form.append("message_thread_id", String(route.topicId));
  form.append(field, blob, name || "attachment");

  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || "unknown Telegram error");
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
