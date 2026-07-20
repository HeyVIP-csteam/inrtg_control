/**
 * POST /api/auth/login   body: { username, password }
 *
 * No server-side session store — this validates the credentials + the
 * office/IP rule (see _shared/accounts.js officeIpCheckPasses() — every
 * role except SuperAdmin must be bound to an office with a matching IP;
 * an account with no office is rejected outright now, not silently let
 * through). On success, issues a signed session token (issueToken() in
 * _shared/accounts.js) and returns it alongside the account's public
 * info (role, allowedBrands). The frontend stores ONLY this token
 * (never the password — see the SECURITY INCIDENT note in
 * _shared/accounts.js for why that changed) and re-sends it as
 * X-Agent-Token on every subsequent request; every protected endpoint
 * re-verifies the token's signature/expiry/version independently.
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
 * ACCOUNT AUTO-LOCK — also requested directly. Two independent triggers,
 * either one locks the account (sets `locked: true` via
 * setAccountLocked() in _shared/accounts.js — see that file for what
 * locking actually does to every other endpoint, not just this one):
 *   1. 5 CONSECUTIVE wrong-password attempts (counter in KV, reset to 0
 *      the moment a correct password comes in — this is about repeated
 *      wrong guesses, not lifetime attempts).
 *   2. 5 DIFFERENT unrecognized IPs within a rolling 1-hour window (KV-
 *      stored timestamped list, pruned to the last hour on every check —
 *      repeatedly retrying from the SAME bad IP doesn't count multiple
 *      times toward this, only genuinely different IPs do).
 * Once locked, the account can't log in (or use any already-open browser
 * session — see verifyRequest() in _shared/accounts.js) until a
 * SuperAdmin manually unlocks it (accounts-admin.html, or Agent Profile
 * on the Home sidebar). A separate Telegram alert fires the moment an
 * account gets auto-locked, distinct from the per-attempt IP-warning
 * message above.
 *
 * NOT YET CONFIGURED: set SECURITY_ALERTS_CHAT_ID (and optionally
 * SECURITY_ALERTS_TOPIC_ID) as Cloudflare environment variables once
 * there's a Telegram group/topic picked out for these — until then this
 * silently no-ops (sendTelegramMessage() skips cleanly with no chat ID),
 * so this ships now without breaking anything or requiring the group to
 * exist yet.
 */
import { getAccount, verifyPassword, officeIpCheckPasses, getOffice, requestIP, setAccountLocked, issueToken } from "../../_shared/accounts.js";
import { sendTelegramMessage } from "../../_shared/telegram.js";

const PASSWORD_FAIL_LOCK_THRESHOLD = 5;
const IP_FAIL_LOCK_DISTINCT_THRESHOLD = 5;
const IP_FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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

  // Checked before the (CPU-costly) password hash — see the matching
  // note in verifyRequest() in _shared/accounts.js.
  if (account.locked) {
    return json({ ok: false, error: `This account is locked${account.lockedReason ? ` (${account.lockedReason})` : ""}. Contact a SuperAdmin to unlock it.` }, 403);
  }

  const passwordOk = await verifyPassword(password, account.salt, account.hash, account.iterations);
  if (!passwordOk) {
    const { locked, count } = await recordFailedPassword(env, account.username);
    if (locked && waitUntil) {
      waitUntil(notifyAccountLocked(env, { account, reason: `${count} consecutive wrong password attempts` }));
    }
    return badCreds();
  }
  // Correct password — whatever streak of wrong guesses existed before
  // this is over; don't let it carry forward toward a future lockout.
  await clearFailedPassword(env, account.username);

  if (!(await officeIpCheckPasses(env, account, request))) {
    const ip = requestIP(request) || "unknown";
    // Fire-and-forget via waitUntil — never adds latency to the actual
    // rejection response, and a Telegram hiccup here can't turn into a
    // broken login flow (notifyUnrecognizedIp swallows its own errors).
    if (waitUntil) waitUntil(notifyUnrecognizedIp(env, { account, ip, request }));

    const distinctIpCount = await recordFailedIp(env, account.username, ip);
    if (distinctIpCount >= IP_FAIL_LOCK_DISTINCT_THRESHOLD) {
      await setAccountLocked(env, account.username, true, `${distinctIpCount} different unrecognized IPs within 1 hour`);
      if (waitUntil) waitUntil(notifyAccountLocked(env, { account, reason: `${distinctIpCount} different unrecognized IPs within 1 hour` }));
    }

    if (!account.officeId) {
      return json({ ok: false, error: `Your account has no office assigned, so it can't log in from anywhere. Ask an admin to assign you an office (your current IP: ${ip}).` }, 401);
    }
    const office = await getOffice(env, account.officeId);
    const officeName = office?.name || "your office";
    return json({ ok: false, error: `Your IP address (${ip}) isn't on the approved list for ${officeName}. Ask an admin to whitelist it under Account Management → Whitelist IP.` }, 401);
  }

  const token = await issueToken(env, account);
  return json({
    ok: true,
    token,
    account: { username: account.username, role: account.role, allowedBrands: account.allowedBrands, officeId: account.officeId },
  });
}

// ---- consecutive-wrong-password tracking (trigger #1 for auto-lock) ----

async function recordFailedPassword(env, username) {
  const key = `pwfail:${username}`;
  const raw = await env.THREADS_KV.get(key);
  const count = (parseInt(raw || "0", 10) || 0) + 1;
  if (count >= PASSWORD_FAIL_LOCK_THRESHOLD) {
    await setAccountLocked(env, username, true, `${count} consecutive wrong password attempts`);
    await env.THREADS_KV.delete(key); // fresh count if this account is ever unlocked and tried again
    return { locked: true, count };
  }
  await env.THREADS_KV.put(key, String(count));
  return { locked: false, count };
}

async function clearFailedPassword(env, username) {
  await env.THREADS_KV.delete(`pwfail:${username}`).catch(() => {});
}

// ---- distinct-unrecognized-IPs-per-hour tracking (trigger #2) ----

async function recordFailedIp(env, username, ip) {
  const key = `ipfail:${username}`;
  const raw = await env.THREADS_KV.get(key);
  const now = Date.now();
  let entries = raw ? JSON.parse(raw) : [];
  entries = entries.filter((e) => now - e.ts < IP_FAIL_WINDOW_MS);
  entries.push({ ip, ts: now });
  entries = entries.slice(-100); // defensive cap, well above what 1 hour of real attempts would ever produce
  await env.THREADS_KV.put(key, JSON.stringify(entries));
  return new Set(entries.map((e) => e.ip)).size;
}

async function notifyAccountLocked(env, { account, reason }) {
  try {
    const lines = [
      `🔒<b>Account Auto-Locked</b>🔒`,
      ``,
      `👤 User: ${escapeHtml(account.username)}`,
      `📋 Reason: ${escapeHtml(reason)}`,
      `🕒 Colombo Time: ${formatInZone(new Date(), "Asia/Colombo")} (GMT+5:30)`,
      ``,
      `🔑 This account can no longer log in (or use any already-open session) until a SuperAdmin unlocks it under Account Management → Agent Profile, or accounts-admin.html.`,
    ];
    await sendTelegramMessage(env, {
      chatId: env.SECURITY_ALERTS_CHAT_ID,
      topicId: env.SECURITY_ALERTS_TOPIC_ID,
      text: lines.join("\n"),
    });
  } catch {
    // Never let a notification hiccup affect anything else.
  }
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
      `⚠️<b>Login Warning (Abnormal IP Address)</b>⚠️`,
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
