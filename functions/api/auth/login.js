/**
 * POST /api/auth/login   body: { username, password }
 *
 * No session is created — this just validates the credentials + the
 * office/IP rule (see _shared/accounts.js officeIpCheckPasses() — every
 * role except SuperAdmin must be bound to an office with a matching IP;
 * an account with no office is rejected outright now, not silently let
 * through). On success, returns the account's public info (role,
 * allowedBrands) so the frontend can decide what to show; the frontend
 * then re-sends the same username/password as X-Agent-User / X-Agent-Pass
 * headers on every subsequent request, and every protected endpoint
 * re-verifies them independently — this endpoint is really just a "does
 * this work" check for the login form, not a source of trust by itself.
 *
 * ERROR MESSAGES — deliberately generic for username/password ("Wrong
 * username or password") since those two failures happen BEFORE we know
 * the credentials are real, and blending them avoids confirming to
 * whoever's typing whether a given username even exists. Once the
 * password has actually verified correctly, though, the ONLY thing left
 * that can fail is the office/IP rule — at that point whoever's logging
 * in has already proven they know a real password, so there's nothing
 * left to protect by staying vague, and a specific "your IP isn't
 * whitelisted for your office" message (with the actual IP, so an admin
 * can immediately go add it) is much more useful than the same generic
 * line. Requested directly by the business owner.
 *
 * IP ALERT NOTIFICATION — business owner requested a Telegram alert when
 * a real (password-correct) account tries to log in from an IP that
 * ISN'T on its office's approved list. Login is STILL BLOCKED exactly as
 * before — this only adds visibility, it does not loosen access.
 * Notifies on EVERY such attempt (deliberately not de-duplicated) — the
 * business owner wants to see how many times a given account has tried
 * from unapproved networks, not just a one-time flag. Switching between
 * multiple IPs that are ALL already on the approved list never alerts at
 * all (officeIpCheckPasses() passes, this whole block is skipped).
 *
 * NOT YET CONFIGURED: set SECURITY_ALERTS_CHAT_ID (and optionally
 * SECURITY_ALERTS_TOPIC_ID) as Cloudflare environment variables once
 * there's a Telegram group/topic picked out for these — until then this
 * silently no-ops (sendTelegramMessage() skips cleanly with no chat ID),
 * so this ships now without breaking anything or requiring the group to
 * exist yet.
 */
import { getAccount, verifyPassword, officeIpCheckPasses, getOffice, requestIP } from "../../_shared/accounts.js";
import { sendTelegramMessage } from "../../_shared/telegram.js";

export async function onRequestPost(context) {
  try {
    return await handleLogin(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleLogin({ request, env, waitUntil }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) return json({ ok: false, error: "Username and password are required." }, 400);

  const badCreds = () => json({ ok: false, error: "Wrong username or password." }, 401);

  const account = await getAccount(env, username);
  if (!account) return badCreds();

  const passwordOk = await verifyPassword(password, account.salt, account.hash, account.iterations);
  if (!passwordOk) return badCreds();

  if (!(await officeIpCheckPasses(env, account, request))) {
    const ip = requestIP(request) || "unknown";
    // Fire-and-forget via waitUntil — never adds latency to the actual
    // rejection response, and a Telegram hiccup here can't turn into a
    // broken login flow (notifyUnrecognizedIp swallows its own errors).
    if (waitUntil) waitUntil(notifyUnrecognizedIp(env, { account, ip, request }));
    if (!account.officeId) {
      return json({ ok: false, error: `Your account has no office assigned, so it can't log in from anywhere. Ask an admin to assign you an office (your current IP: ${ip}).` }, 401);
    }
    const office = await getOffice(env, account.officeId);
    const officeName = office?.name || "your office";
    return json({ ok: false, error: `Your IP address (${ip}) isn't on the approved list for ${officeName}. Ask an admin to whitelist it under Account Management → Whitelist IP.` }, 401);
  }

  return json({
    ok: true,
    account: { username: account.username, role: account.role, allowedBrands: account.allowedBrands, officeId: account.officeId },
  });
}

async function notifyUnrecognizedIp(env, { account, ip, request }) {
  try {
    const userAgent = request.headers.get("User-Agent") || "unknown device";
    const officeName = account.officeId ? (await getOffice(env, account.officeId))?.name : null;

    // Cloudflare attaches geo/network info to every request at the edge —
    // no extra API call needed, this is instant. `cf` can be missing in
    // local/dev environments, so every field below falls back cleanly.
    const cf = request.cf || {};
    const country = countryName(cf.country);
    const city = cf.city || "Unknown";
    const isp = cf.asOrganization || "Unknown";

    const now = new Date();
    const lines = [
      `⚠️<b>登录提醒（IP异常）</b>⚠️`,
      ``,
      `👤 User: ${escapeHtml(account.username)}`,
      `🌐 IP: ${escapeHtml(ip)}`,
      `🏢 Assigned office: ${escapeHtml(officeName || "none")}`,
      `📱 Browser/device: ${escapeHtml(userAgent)}`,
      `🗺️ Country: ${escapeHtml(country)}`,
      `🏙️ City: ${escapeHtml(city)}`,
      `📡 ISP: ${escapeHtml(isp)}`,
      `🕒 Colombo Time: ${formatInZone(now, "Asia/Colombo")} (GMT+5:30)`,
      `🕗 Malaysia Time: ${formatInZone(now, "Asia/Kuala_Lumpur")} (GMT+8:00)`,
      ``,
      `🚫 Login was blocked as usual — this is just a heads-up.`,
    ];
    await sendTelegramMessage(env, {
      chatId: env.SECURITY_ALERTS_CHAT_ID,
      topicId: env.SECURITY_ALERTS_TOPIC_ID,
      text: lines.join("\n"),
    });
  } catch {
    // Never let a notification hiccup affect anything else — this
    // function's caller is a fire-and-forget waitUntil() anyway.
  }
}

// Cloudflare's `cf.country` is a 2-letter code (e.g. "LK", "MY") — spell
// it out for a human reading a Telegram alert. Falls back to the raw
// code if Intl.DisplayNames can't resolve it (or isn't available) rather
// than showing nothing.
function countryName(code) {
  if (!code) return "Unknown";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

// "2026-07-19 18:32" in the given IANA timezone — the (GMT+X) label is
// added by the caller as a static string rather than computed here,
// since the two zones this is used for (Colombo, Kuala Lumpur) don't
// observe daylight saving, so their offset never changes.
function formatInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    return date.toISOString();
  }
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
