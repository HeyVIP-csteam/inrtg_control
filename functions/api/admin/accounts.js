/**
 * /api/admin/accounts
 *   GET                                  -> list accounts (no secrets)
 *   POST { action:"save", username, password?, role, officeId, allowedBrands, fullName?, pid? } -> create/update
 *     - `password` omitted when editing an existing account and not
 *       changing the password.
 *     - Any field omitted from the body keeps its existing value
 *       (saveAccount uses patch/merge semantics) — so a caller that only
 *       wants to update fullName/pid, say, doesn't have to resend
 *       role/officeId/allowedBrands just to avoid wiping them.
 *   POST { action:"delete", username }   -> delete
 *
 * Admin-gated — see authenticateAdmin() in _shared/accounts.js for the
 * two ways in (real admin login, or one-time bootstrap password).
 */
import { listAccounts, saveAccount, deleteAccount, authenticateAdmin } from "../../_shared/accounts.js";

export async function onRequestGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: "Admin login required." }, 401);
  return json({ ok: true, accounts: await listAccounts(env) });
}

export async function onRequestPost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: "Admin login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.action === "save") {
    if (!body.username) return json({ ok: false, error: "Username is required." }, 400);
    try {
      const account = await saveAccount(env, {
        username: body.username,
        password: body.password || undefined,
        // An admin resetting/setting a password is a different "who did
        // this" than self-service — auth.account is null only in
        // bootstrap mode (no real admin account exists yet).
        passwordChangedBy: body.password ? (auth.account ? auth.account.username : "bootstrap-setup") : undefined,
        role: body.role !== undefined ? body.role : undefined,
        officeId: body.officeId !== undefined ? (body.officeId || null) : undefined,
        allowedBrands: body.allowedBrands !== undefined ? body.allowedBrands : undefined,
        fullName: body.fullName !== undefined ? body.fullName : undefined,
        pid: body.pid !== undefined ? body.pid : undefined,
      });
      return json({ ok: true, account });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "delete") {
    if (!body.username) return json({ ok: false, error: "Missing username." }, 400);
    await deleteAccount(env, body.username);
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
