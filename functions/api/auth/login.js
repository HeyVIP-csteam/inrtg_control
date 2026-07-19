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
 */
import { getAccount, verifyPassword, officeIpCheckPasses } from "../../_shared/accounts.js";

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

  // Same generic error whether the username doesn't exist, the password
  // is wrong, or the IP doesn't match — don't help narrow down which.
  const fail = () => json({ ok: false, error: "Wrong username, password, or you're not on an approved network." }, 401);

  const account = await getAccount(env, username);
  if (!account) return fail();

  const passwordOk = await verifyPassword(password, account.salt, account.hash, account.iterations);
  if (!passwordOk) return fail();

  if (!(await officeIpCheckPasses(env, account, request))) return fail();

  return json({
    ok: true,
    account: { username: account.username, role: account.role, allowedBrands: account.allowedBrands, officeId: account.officeId },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
