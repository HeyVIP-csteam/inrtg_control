import { BRANDS, RECORD_TO_SHEET, MODULE_META, SHEET_LAYOUT, MESSAGE_TEMPLATE, SCREENSHOT_R2_ENABLED, PROMOTION_SHEET_CONFIG, PROMOTION_MESSAGE_TEMPLATE } from "../_shared/routing.js";
import {
  resolveColumnValues, resolveSheetLayout, formatDateDDMMYYYY,
  buildTicketMessage, buildTitleAndSummary,
} from "../_shared/messageBuilders.js";
import { appendRowToSheet, appendRowByColumns, writeRowForDate, getNextSequenceValue } from "../_shared/googleSheets.js";
import { uploadAttachmentToR2, screenshotUrl } from "../_shared/r2.js";
import { createThread } from "../_shared/threads.js";
import { verifyRequest, canSeeBrand, canSeeModule } from "../_shared/accounts.js";
import { logActivity } from "../_shared/activityLog.js";
import { getRouteOverride } from "../_shared/routes.js";
import { compressImageForTelegram } from "../_shared/telegramImageCompress.js";
import { getIssueSheetOverride, resolveWriteTab, promotionModuleId } from "../_shared/issueSubmissionSheets.js";

const VALID_MODULES = Object.keys(MODULE_META);

// Top-level safety net. Everything below already handles its OWN expected
// failure modes (bad JSON, missing config, Telegram/Sheets errors) with a
// clean { ok:false, error } response — this catch is for anything
// UNEXPECTED (a bug, a malformed routing.js entry, whatever) so a ticket
// submission never comes back as a raw platform error page. The agent
// always gets JSON back, even when something we didn't anticipate breaks.
export async function onRequestPost(context) {
  try {
    return await handleSubmit(context);
  } catch (e) {
    console.error("submit.js: unexpected error", e && e.stack || e);
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleSubmit({ request, env, waitUntil }) {
  // The whole hub now requires login (business owner's call — previously
  // only TG Reply Threads did). This is the server-side half of that: the
  // frontend redirect to /login.html is the UX, this is what actually
  // stops an unauthenticated request hitting the API directly.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { module: moduleId, brand: brandId, reporter, fields, attachments, idempotencyKey } = body || {};

  if (!VALID_MODULES.includes(moduleId)) {
    return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);
  }
  // Real enforcement, not just hiding it from the sidebar — an agent
  // scoped away from a topic (account.allowedModules, set in the Agent
  // Personal Profile modal) can't submit to it even by calling this
  // endpoint directly, bypassing the Home page and app.js's own checks
  // entirely. Checked before the brand lookup below on purpose — no
  // reason to even validate brandId for a module this account can't use.
  if (!canSeeModule(account, moduleId)) {
    return json({ ok: false, error: `Your account doesn't have access to the ${MODULE_META[moduleId]?.name || moduleId} topic.` }, 403);
  }
  const brand = BRANDS[brandId];
  if (!brand) {
    return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
  }
  // Real enforcement, not just hiding it from the dropdown — an agent
  // scoped to specific brands (account.allowedBrands) can't submit for
  // any other brand even by calling this endpoint directly. The form's
  // Brand/Platform dropdown (app.js) already only shows brands they're
  // allowed to see; this is the server-side half that actually matters.
  if (!canSeeBrand(account, brand.name)) {
    return json({ ok: false, error: `You don't have access to submit tickets for ${brand.name}.` }, 403);
  }
  if (!reporter || !Array.isArray(fields)) {
    return json({ ok: false, error: "Missing reporter or fields." }, 400);
  }

  // Idempotency check — same submit CLICK occasionally reaches the server
  // twice for real (flaky mobile network retrying the request, a double-
  // tap, an edge node retry), which used to mean a duplicate Telegram
  // message, a duplicate thread record, and sometimes a Sheet row
  // conflict from two near-simultaneous writes. idempotencyKey (see
  // app.js) is a fresh random ID per click, not tied to the form's
  // content, so retrying after a genuine failure still submits normally.
  if (idempotencyKey && env.THREADS_KV) {
    const dedupeKey = `submit_dedupe:${idempotencyKey}`;
    const already = await env.THREADS_KV.get(dedupeKey);
    if (already) {
      // Already processed (or currently mid-processing) — hand back the
      // exact same result instead of doing everything a second time.
      return new Response(already, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Placeholder first, 30s TTL — so a near-simultaneous duplicate
    // request (arriving before the real processing below has finished)
    // still gets caught immediately instead of racing past this check too.
    // Cloudflare KV enforces a hard minimum of 60s for expirationTtl —
    // passing 30 here (as originally written) makes EVERY put() call
    // fail with a 400, which breaks EVERY submission, not just duplicate
    // ones (this dedupe check runs on every request, not just repeats).
    await env.THREADS_KV.put(dedupeKey, JSON.stringify({ ok: true, duplicate: true, note: "Original submission was still processing — this is not a second ticket." }), { expirationTtl: 60 });
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);
  }

  const meta = MODULE_META[moduleId];
  // Live-editable routing (TG Group / Channel admin page) takes priority
  // over the hardcoded default — see _shared/routes.js. An empty/unset KV
  // means every brand+module just falls back to brand.telegram as before,
  // so this can't break anything that already works.
  const routeOverride = await getRouteOverride(env, brandId, moduleId);
  const route = routeOverride || brand.telegram[moduleId] || brand.telegram.default;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f.value]));

  // Promotion Request's TID gets shown to the agent via the "Generate"
  // button (see app.js) BEFORE they submit — often minutes before, while
  // they're still filling out the rest of the form. That preview is a
  // point-in-time READ of "what's the next TID after the last row in the
  // sheet right now"; if a second submission (a different agent, or the
  // same one double-clicking Generate) reads that same "last row" before
  // THIS one has actually been written, both end up with the identical
  // previewed TID — nothing enforces it's still free by the time Submit
  // is actually clicked. Close that gap here, right before the real
  // write: re-check what the CURRENT next TID actually is; if it no
  // longer matches what the agent's form is holding (someone else's
  // submission landed in the meantime), silently swap in the fresh one
  // instead of writing a duplicate. Shrinks the real race window from
  // "however long the agent takes to fill out the form" down to the
  // handful of milliseconds between this check and the write below —
  // not a mathematical guarantee under true simultaneous submissions,
  // but closes the actual gap that was causing real duplicates.
  if (moduleId === "promotion_request" && fieldMap.tid) {
    const freshConfig = PROMOTION_SHEET_CONFIG[`${brandId}|${fieldMap.promotion}`];
    if (freshConfig) {
      try {
        const fresh = await getNextSequenceValue(env, freshConfig.sheetId, freshConfig.tab, freshConfig.tidColumn || freshConfig.startColumn);
        if (fresh.next && fresh.next !== fieldMap.tid) {
          fieldMap.tid = fresh.next;
          const tidField = fields.find((f) => f.key === "tid");
          if (tidField) tidField.value = fresh.next;
        }
      } catch {
        // Best-effort — if this re-check itself fails (Sheets hiccup),
        // fall through and submit with whatever TID the agent's form
        // already had rather than blocking the whole submission over it.
      }
    }
  }

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

  const text = buildTicketMessage({
    moduleId, brandId, meta, brand, fieldMap, fields, reporter, screenshotLink,
    messageTemplate: MESSAGE_TEMPLATE, promotionMessageTemplate: PROMOTION_MESSAGE_TEMPLATE,
  });

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
    tgResult = { messageId: fallback.messageId, messageIds: [fallback.messageId], attachmentLinks: [], attachmentFileIds: [], attachmentNames: [] };
  }
  const attachmentLinks = tgResult.attachmentLinks;

  // 2. Optionally log to the brand's Google Sheet (fire-and-await, but don't
  //    fail the whole request if the sheet write fails — Telegram already has it).
  // Runs BEFORE the thread record below on purpose: if this writes a real
  // row, we want its {sheetId, tab, startColumn, columns, row} saved on
  // the thread as `sheetRef`, so a later edit (functions/api/threads/[id].js
  // editDetails) knows exactly which Sheet cell range to overwrite instead
  // of appending a duplicate row.
  let sheetLogged = false;
  let sheetError = null;
  let sheetRef = null;
  const promoConfig = moduleId === "promotion_request" ? PROMOTION_SHEET_CONFIG[`${brandId}|${fieldMap.promotion}`] : null;
  const sheetAttempted = moduleId === "promotion_request"
    ? !!(RECORD_TO_SHEET[moduleId] && promoConfig)
    : !!(RECORD_TO_SHEET[moduleId] && brand.sheetId);

  // Live-editable sheet/tab (Integration Portal → Issue Submission Gsheet
  // admin page) takes priority over the hardcoded routing.js default —
  // see _shared/issueSubmissionSheets.js. Only ever affects WHERE a row
  // is written (sheetId + tab); startColumn/columns below always stay the
  // hardcoded ones, since an overridden sheet is still assumed to have
  // the same column layout as the original. Empty/unset KV means every
  // module writes exactly where it always has.
  const issueSheetOverride = sheetAttempted
    ? await getIssueSheetOverride(env, brandId, moduleId === "promotion_request" ? promotionModuleId(fieldMap.promotion) : moduleId)
    : null;

  if (sheetAttempted) {
    try {
      if (moduleId === "promotion_request") {
        const effectiveSheetId = issueSheetOverride?.sheetId || promoConfig.sheetId;
        const effectiveTab = issueSheetOverride
          ? (await resolveWriteTab(env, effectiveSheetId, issueSheetOverride.tabNames)) || promoConfig.tab
          : promoConfig.tab;
        const values = resolveColumnValues(promoConfig.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
        const { row } = await appendRowByColumns(env, effectiveSheetId, effectiveTab, promoConfig.startColumn, values);
        if (row) sheetRef = { sheetId: effectiveSheetId, tab: effectiveTab, startColumn: promoConfig.startColumn, columns: promoConfig.columns, row };
      } else {
        const layoutEntry = SHEET_LAYOUT[moduleId];
        const effectiveSheetId = issueSheetOverride?.sheetId || brand.sheetId;
        if (layoutEntry && layoutEntry.pairByDate) {
          const effectiveTab = issueSheetOverride
            ? (await resolveWriteTab(env, effectiveSheetId, issueSheetOverride.tabNames)) || layoutEntry.tab
            : layoutEntry.tab;
          const values = resolveColumnValues(layoutEntry.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
          const dateValue = formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date);
          const shiftValue = fieldMap[layoutEntry.selectorField];
          const activeSide = shiftValue === layoutEntry.rightBlock.shiftValue ? "right" : "left";
          const activeBlock = activeSide === "right" ? layoutEntry.rightBlock : layoutEntry.leftBlock;
          const { row } = await writeRowForDate(env, effectiveSheetId, effectiveTab, {
            leftBlock: layoutEntry.leftBlock,
            rightBlock: layoutEntry.rightBlock,
            activeSide,
            dateValue,
            values,
          });
          // `row` is the ACTUAL Sheets row this shift's data landed on —
          // same row a same-date submission from the OTHER shift would
          // also resolve to (see writeRowForDate()'s scan logic), but
          // that's fine: sheetRef is stored per-THREAD, not shared, and
          // `startColumn` is fixed to THIS shift's own block, so a later
          // editDetails() on this specific ticket only ever touches this
          // shift's own columns — never the other shift's half of the row.
          if (row) sheetRef = { sheetId: effectiveSheetId, tab: effectiveTab, startColumn: activeBlock.startColumn, columns: layoutEntry.columns, row };
        } else {
          const layout = resolveSheetLayout(layoutEntry, fieldMap);
          if (layout) {
            const effectiveTab = issueSheetOverride
              ? (await resolveWriteTab(env, effectiveSheetId, issueSheetOverride.tabNames)) || layout.tab
              : layout.tab;
            const values = resolveColumnValues(layout.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
            const { row } = await appendRowByColumns(env, effectiveSheetId, effectiveTab, layout.startColumn, values);
            if (row) sheetRef = { sheetId: effectiveSheetId, tab: effectiveTab, startColumn: layout.startColumn, columns: layout.columns, row };
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
      }
      sheetLogged = true;
    } catch (e) {
      sheetError = String(e.message || e);
    }
  }

  // 2b. Create a TG Reply Threads record so agent replies to this exact
  //     Telegram message can be tracked in the dashboard. Optional feature —
  //     skipped silently until THREADS_KV is bound (see wrangler.toml).
  let threadId = null;
  if (env.THREADS_KV) {
    try {
      const { title, summary } = buildTitleAndSummary({ meta, brand, fieldMap, fields });
      const thread = await createThread(env, {
        module: moduleId,
        moduleName: meta.name,
        icon: meta.emoji,
        accent: meta.accent,
        brand: brand.name,
        brandId,
        title,
        submitter: reporter,
        chatId: route.chatId,
        topicId: route.topicId,
        rootMessageId: tgResult.messageId,
        rootMessageIds: tgResult.messageIds,
        rootText: text,
        hasMedia: Array.isArray(attachments) && attachments.length > 0,
        attachmentFileIds: tgResult.attachmentFileIds || [],
        attachmentNames: tgResult.attachmentNames || [],
        summary,
        fieldMap,
        screenshotLink,
        sheetRef,
      });
      threadId = thread.id;
    } catch (e) {
      // Non-fatal — the Telegram message and sheet row are already the
      // source of truth; the reply-tracking record is a nice-to-have.
      // Still logged (fire-and-forget, never throws — see activityLog.js)
      // so a sustained/repeated failure here is discoverable in the
      // Activity Log instead of silently vanishing, which is what made
      // the "visible in sidebar, 404s on open" bug hard to notice before.
      logActivity(env, {
        category: "Thread",
        action: "createThread failed",
        agent: reporter || "unknown",
        detail: `brand=${brand.name} module=${moduleId}: ${String(e && e.message || e)}`,
      });
    }
  }

  const finalResponse = {
    ok: true,
    telegramMessageId: tgResult.messageId,
    threadId,
    sheetAttempted,
    sheetLogged,
    sheetError,
    attachmentErrors: attachmentErrors.length ? attachmentErrors : undefined,
    r2Errors: r2Errors.length ? r2Errors : undefined,
  };
  if (idempotencyKey && env.THREADS_KV) {
    // Overwrite the 30s placeholder from the check above with the real
    // result, now that processing actually finished — and extend the
    // TTL to 10 minutes, long enough to catch a slow retry (e.g. a
    // mobile network that took a while to give up and resend) without
    // keeping every submission's dedupe key around indefinitely.
    await env.THREADS_KV.put(`submit_dedupe:${idempotencyKey}`, JSON.stringify(finalResponse), { expirationTtl: 600 });
  }
  return json(finalResponse);
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

async function sendTelegramWithAttachments({ botToken, route, text, attachments }) {
  if (!attachments.length) {
    const r = await sendTelegramMessage({ botToken, route, text });
    if (!r.ok) throw new Error(r.error);
    return { messageId: r.messageId, messageIds: [r.messageId], attachmentLinks: [], attachmentFileIds: [], attachmentNames: [] };
  }

  if (attachments.length === 1) {
    const { messageId, fileId } = await sendSingleWithCaption({ botToken, route, text, attachment: attachments[0] });
    return {
      messageId,
      messageIds: [messageId],
      attachmentLinks: [buildMessageLink(route, messageId)],
      attachmentFileIds: fileId ? [fileId] : [],
      // Real original filename, kept 1:1 aligned with attachmentFileIds
      // (only pushed when fileId itself was non-null, same filter as
      // above) — this is what lets threads.html correctly detect "this
      // is an image" for the ORIGINAL ticket's own attachments (not just
      // reply attachments, which already had this) via a real file
      // extension, instead of a generic placeholder name with no
      // extension defaulting to "unknown file, show a download link"
      // even for actual photos. See /api/attachment/[fileId].js's
      // ?name= priority ordering.
      attachmentNames: fileId ? [attachments[0].name] : [],
    };
  }

  const allImages = attachments.every((a) => looksLikeImage(a.type, a.name));
  if (allImages) {
    const sent = await sendMediaGroup({ botToken, route, text, attachments });
    return {
      messageId: sent[0].messageId,
      // EVERY message_id in the album — a multi-photo submission lands
      // in Telegram as one message_id PER photo, only the first
      // carrying the caption. Used to only ever keep the first one
      // (as the single messageId above), which meant Recall
      // (functions/api/threads/[id].js) could only ever delete that
      // one, silently leaving the rest of the photos behind in the
      // group forever. See createThread()'s rootMessageIds in
      // _shared/threads.js for where this gets stored.
      messageIds: sent.map((s) => s.messageId),
      attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
      attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
      attachmentNames: sent.filter((s) => s.fileId).map((s) => s.name),
    };
  }

  // Mixed image/document types can't share one album — send each as its own
  // message, with the caption only on the first so it still reads as "the
  // ticket", not repeated noise on every attachment.
  const sent = [];
  for (let i = 0; i < attachments.length; i++) {
    const result = await sendSingleWithCaption({ botToken, route, text: i === 0 ? text : undefined, attachment: attachments[i] });
    sent.push(result);
  }
  return {
    messageId: sent[0].messageId,
    messageIds: sent.map((s) => s.messageId),
    attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
    attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
    attachmentNames: sent.filter((s) => s.fileId).map((s) => s.name),
  };
}

async function sendSingleWithCaption({ botToken, route, text, attachment }) {
  const { name, type, dataUrl } = attachment;
  let bytes = base64ToBytes(dataUrlToBase64(dataUrl));
  let sendType = type;

  const isImage = looksLikeImage(type, name);
  // Only photos can hit Telegram's 10MB sendPhoto limit in the first
  // place — sendDocument has a much higher cap, so documents are never
  // routed through this (see compressImageForTelegram's own threshold
  // check too, which is a no-op for anything already under it).
  if (isImage) {
    const result = await compressImageForTelegram(bytes, type);
    bytes = result.bytes;
    sendType = result.type;
  }
  const blob = new Blob([bytes], { type: sendType || "application/octet-stream" });

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
  const fileId = isImage
    ? data.result.photo?.[data.result.photo.length - 1]?.file_id || null
    : data.result.document?.file_id || null;
  return { messageId: data.result.message_id, fileId, name };
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

  // This path is only ever reached when every attachment already
  // "looksLikeImage" (see the allImages check at the call site), so every
  // item here is a candidate for compression — no per-item isImage check
  // needed, unlike sendSingleWithCaption above.
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const raw = base64ToBytes(dataUrlToBase64(att.dataUrl));
    const { bytes, type } = await compressImageForTelegram(raw, att.type);
    const blob = new Blob([bytes], { type: type || "image/jpeg" });
    form.append(`file${i}`, blob, att.name || `photo${i}`);
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "unknown Telegram error");
  // attachments[i] lines up positionally with data.result[i] — sendMediaGroup
  // returns results in the same order the media items were submitted in.
  return data.result.map((m, i) => ({
    messageId: m.message_id,
    fileId: m.photo?.[m.photo.length - 1]?.file_id || null,
    name: attachments[i]?.name,
  }));
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
