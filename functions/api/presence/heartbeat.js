/**
 * POST /api/presence/heartbeat
 *
 * Called every 15s by public/assets/presence-heartbeat.js for any
 * logged-in agent (no Active Agents permission required to SEND a
 * heartbeat about yourself — canViewActiveAgents only gates who can
 * VIEW the resulting data, not who gets tracked; everyone logged in is
 * tracked, same as the existing lastActiveAt mechanism).
 *
 * Body: { status: "online"|"inactive", device: "desktop"|"mobile",
 *         browser: "Chrome 128", os: "Windows" }
 */
import { authenticateStaff, ROLE_RANK } from "../../_shared/accounts.js";
import { recordHeartbeat } from "../../_shared/presence.js";

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handle({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok || !auth.account) return json({ ok: false, error: "Not authorized." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const status = body.status === "inactive" ? "inactive" : "online";
  const device = body.device === "mobile" ? "mobile" : "desktop";
  const browser = (body.browser || "Unknown browser").slice(0, 40);
  const os = (body.os || "Unknown OS").slice(0, 40);

  const fresh = await recordHeartbeat(env, auth.account.username, { status, device, browser, os });
  return json({ ok: true, presence: fresh });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
