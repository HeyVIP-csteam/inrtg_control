/**
 * POST /api/presence/heartbeat  {}                  -> "I'm online"
 * POST /api/presence/heartbeat  { status: "offline" } -> tab closing (beacon)
 *
 * Called by every logged-in agent's browser every ~15s (see
 * public/assets/presence-heartbeat.js) — NOT gated by "activeAgents"
 * Account Management Access, deliberately: every agent needs to be able
 * to report their OWN presence for the board to mean anything, whether
 * or not they personally have permission to view the board. Any
 * authenticated account, any rank, can only ever write its own
 * `presence:current:<own username>` record — never another account's,
 * see authenticateStaff() below using the token's own username.
 *
 * Two states only (online/offline) — see _shared/presence.js's header
 * comment for why "inactive" was removed.
 */
import { authenticateStaff, ROLE_RANK } from "../../_shared/accounts.js";
import { recordHeartbeat, markOffline } from "../../_shared/presence.js";

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok || !auth.account) return json({ ok: false, error: "Not authorized." }, 401);

  let body = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — a plain heartbeat carries no payload at all.
  }

  if (body.status === "offline") {
    await markOffline(env, auth.account.username);
    return json({ ok: true });
  }

  const result = await recordHeartbeat(env, auth.account.username);
  return json({ ok: true, written: result.written });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
