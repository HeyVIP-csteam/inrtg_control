import { BRANDS, RECORD_TO_SHEET, MODULE_META, SHEET_LAYOUT, MESSAGE_TEMPLATE, SCREENSHOT_R2_ENABLED } from "../_shared/routing.js";
import { appendRowToSheet, appendRowByColumns, writeRowForDate } from "../_shared/googleSheets.js";
import { uploadAttachmentToR2, screenshotUrl } from "../_shared/r2.js";

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
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f.value]));

  // 1. Upload attachments to R2 first (if configured) so the message text
  //    can include a real, directly-openable screenshot link.
  const r2Links = [];
  const r2Errors = [];
  if (env.SCREENSHOTS_BUCKET && SCREENSHOT_R2_ENABLED[moduleId] && Array.isArray(attachments) && attachments.length) {
    const origin = new URL(request.url).origin;
    for (const att of attachments) {
      try {
        const key = await uploadAttachmentToR2(env, { moduleId, brandId, attachment: att });
        r2Links.push(screenshotUrl(origin, key));
      } catch (e) {
        r2Errors.push(`${att.name}: ${e.message || e}`);
      }
    }
  }
  const screenshotLink = r2Links.join(", ");

  const template = resolveTemplate(MESSAGE_TEMPLATE[moduleId], fieldMap);
  const text = template
    ? buildMessageFromTemplate({ template, brandName: brand.name, fieldMap, reporter, screenshotLink })
    : buildMessage({ meta, brandName: brand.name, reporter, fields, timestamp });

  // 2. Send to Telegram — photo(s)/document(s) with the info as the caption,
  //    so it shows as one message instead of text + separate photo.
  let tgResult;
  const attachmentErrors = [];
  try {
    tgResult = await sendTelegramWithAttachments({ botToken, route, text, attachments: attachments || [] });
  } catch (e) {
    // Fall back to a plain text message so the ticket isn't lost even if
    // the attachment send fails (e.g. caption too long, bad file, etc).
    attachmentErrors.push(String(e.message || e));
    const fallback = await sendTelegramMessage({ botToken, route, text });
    if (!fallback.ok) {
      return json({ ok: false, error: `Telegram send failed: ${fallback.error}` }, 502);
    }
    tgResult = { messageId: fallback.messageId, attachmentLinks: [] };
  }
  const attachmentLinks = tgResult.attachmentLinks;

  // 2. Optionally log to the brand's Google Sheet (fire-and-await, but don't
  //    fail the whole request if the sheet write fails — Telegram already has it).
  let sheetLogged = false;
  let sheetError = null;
  const sheetAttempted = !!(RECORD_TO_SHEET[moduleId] && brand.sheetId);
  if (sheetAttempted) {
    try {
      const layoutEntry = SHEET_LAYOUT[moduleId];
      if (layoutEntry && layoutEntry.pairByDate) {
        const values = resolveColumnValues(layoutEntry.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
        const dateValue = formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date);
        const shiftValue = fieldMap[layoutEntry.selectorField];
        const activeSide = shiftValue === layoutEntry.rightBlock.shiftValue ? "right" : "left";
        await writeRowForDate(env, brand.sheetId, layoutEntry.tab, {
          leftBlock: layoutEntry.leftBlock,
          rightBlock: layoutEntry.rightBlock,
          activeSide,
          dateValue,
          values,
        });
      } else {
        const layout = resolveSheetLayout(layoutEntry, fieldMap);
        if (layout) {
          const values = resolveColumnValues(layout.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
          await appendRowByColumns(env, brand.sheetId, layout.tab, layout.startColumn, values);
        } else {
          const row = {
            timestamp,
            brand: brand.name,
            reporter,
            ...Object.fromEntries(fields.map((f) => [f.key, f.value])),
            attachments: (attachments || []).map((a) => a.name).join(", "),
          };
          await appendRowToSheet(env, brand.sheetId, moduleId, row);
        }
      }
      sheetLogged = true;
    } catch (e) {
      sheetError = String(e.message || e);
    }
  }

  return json({
    ok: true,
    telegramMessageId: tgResult.messageId,
    sheetAttempted,
    sheetLogged,
    sheetError,
    attachmentErrors: attachmentErrors.length ? attachmentErrors : undefined,
    r2Errors: r2Errors.length ? r2Errors : undefined,
  });
}

function resolveColumnValues(columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks }) {
  return columns.map((col) => {
    if (col === null) return "-";
    if (typeof col === "string") {
      if (col === "brand") return brand.name || "-";
      if (col === "pic") return reporter || "-";
      if (col === "screenshotLink") return (screenshotLink || attachmentLinks.join(", ")) || "-";
      if (col === "dateFormatted") return formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date) || "-";
      return fieldMap[col] || "-";
    }
    // { details: ["remark", "issueDetails"] } — first non-empty field wins
    const [, fallbackKeys] = Object.entries(col)[0];
    for (const key of fallbackKeys) {
      if (fieldMap[key]) return fieldMap[key];
    }
    return "-";
  });
}

function resolveSheetLayout(entry, fieldMap) {
  if (!entry) return null;
  if (entry.selectorField) {
    const selectorValue = fieldMap[entry.selectorField];
    return entry.layouts[selectorValue] || entry.layouts.default || null;
  }
  return entry;
}

function resolveTemplate(entry, fieldMap) {
  if (!entry) return null;
  if (Array.isArray(entry)) return { rows: entry, spacing: "tight", emptyPlaceholder: "-" };
  if (entry.selectorField) {
    const selectorValue = fieldMap[entry.selectorField];
    const chosen = entry.templates[selectorValue] || entry.templates.default;
    return resolveTemplate(chosen, fieldMap);
  }
  return { rows: entry.rows, spacing: entry.spacing || "tight", emptyPlaceholder: entry.emptyPlaceholder ?? "-" };
}

function resolveFieldValue(item, { brandName, fieldMap, reporter, screenshotLink }) {
  if (typeof item.key !== "string") {
    const [, fallbackKeys] = Object.entries(item.key)[0];
    return fallbackKeys.map((k) => fieldMap[k]).find((v) => v);
  }
  if (item.key === "brand") return brandName;
  if (item.key === "screenshotLink") return screenshotLink;
  if (item.key === "pic") return reporter;
  if (item.key === "dateShift") return formatDateShift(fieldMap.reportDate, fieldMap.shift);
  return fieldMap[item.key];
}

function buildMessageFromTemplate({ template, brandName, fieldMap, reporter, screenshotLink }) {
  const { rows, spacing, emptyPlaceholder } = template;
  const lines = [];
  rows.forEach((item, i) => {
    const value = resolveFieldValue(item, { brandName, fieldMap, reporter, screenshotLink });
    lines.push(`${item.emoji} <b>${escapeHtml(item.label)}:</b> ${escapeHtml(value || emptyPlaceholder)}`);
    if (spacing === "loose" && i < rows.length - 1 && !item.tight) lines.push("");
  });
  return lines.join("\n");
}

// "15/07/2026 ( Day Shift Report )☀️" — DD/MM/YYYY from the <input type=date>
// value (YYYY-MM-DD), plus the shift name and a sun/moon emoji.
function formatDateShift(isoDate, shift) {
  const formatted = formatDateDDMMYYYY(isoDate);
  if (!formatted) return "-";
  const emoji = shift === "Night Shift" ? "🌙" : "☀️";
  return `${formatted} ( ${shift || "Day Shift"} Report )${emoji}`;
}

function formatDateDDMMYYYY(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
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

async function sendTelegramWithAttachments({ botToken, route, text, attachments }) {
  if (!attachments.length) {
    const r = await sendTelegramMessage({ botToken, route, text });
    if (!r.ok) throw new Error(r.error);
    return { messageId: r.messageId, attachmentLinks: [] };
  }

  if (attachments.length === 1) {
    const messageId = await sendSingleWithCaption({ botToken, route, text, attachment: attachments[0] });
    return { messageId, attachmentLinks: [buildMessageLink(route, messageId)] };
  }

  const allImages = attachments.every((a) => (a.type || "").startsWith("image/"));
  if (allImages) {
    const messageIds = await sendMediaGroup({ botToken, route, text, attachments });
    return { messageId: messageIds[0], attachmentLinks: messageIds.map((id) => buildMessageLink(route, id)) };
  }

  // Mixed image/document types can't share one album — send each as its own
  // message, with the caption only on the first so it still reads as "the
  // ticket", not repeated noise on every attachment.
  const ids = [];
  for (let i = 0; i < attachments.length; i++) {
    const id = await sendSingleWithCaption({ botToken, route, text: i === 0 ? text : undefined, attachment: attachments[i] });
    ids.push(id);
  }
  return { messageId: ids[0], attachmentLinks: ids.map((id) => buildMessageLink(route, id)) };
}

async function sendSingleWithCaption({ botToken, route, text, attachment }) {
  const { name, type, dataUrl } = attachment;
  const bytes = base64ToBytes(dataUrlToBase64(dataUrl));
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });

  const isImage = (type || "").startsWith("image/");
  const method = isImage ? "sendPhoto" : "sendDocument";
  const field = isImage ? "photo" : "document";

  const form = new FormData();
  form.append("chat_id", route.chatId);
  if (route.topicId) form.append("message_thread_id", String(route.topicId));
  form.append(field, blob, name || "attachment");
  if (text) {
    form.append("caption", text);
    form.append("parse_mode", "HTML");
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "unknown Telegram error");
  return data.result.message_id;
}

async function sendMediaGroup({ botToken, route, text, attachments }) {
  const form = new FormData();
  form.append("chat_id", route.chatId);
  if (route.topicId) form.append("message_thread_id", String(route.topicId));

  const media = attachments.map((att, i) => {
    const entry = { type: "photo", media: `attach://file${i}` };
    if (i === 0) {
      entry.caption = text;
      entry.parse_mode = "HTML";
    }
    return entry;
  });
  form.append("media", JSON.stringify(media));

  attachments.forEach((att, i) => {
    const bytes = base64ToBytes(dataUrlToBase64(att.dataUrl));
    const blob = new Blob([bytes], { type: att.type || "image/jpeg" });
    form.append(`file${i}`, blob, att.name || `photo${i}`);
  });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "unknown Telegram error");
  return data.result.map((m) => m.message_id);
}

function dataUrlToBase64(dataUrl) {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function buildMessageLink(route, messageId) {
  const internalId = String(route.chatId).replace(/^-100/, "");
  return route.topicId
    ? `https://t.me/c/${internalId}/${route.topicId}/${messageId}`
    : `https://t.me/c/${internalId}/${messageId}`;
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
