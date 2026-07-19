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
 */
import { getAccount, verifyPassword, officeIpCheckPasses, getOffice, requestIP } from "../../_shared/accounts.js";

export async function onRequestPost(context) {
  try {
    return await handleLogin(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleLogin({ request, env }) {
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
