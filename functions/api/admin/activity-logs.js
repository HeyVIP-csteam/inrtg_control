/**
 * GET /api/admin/activity-logs -> { ok, entries: [{ts,category,action,agent,detail,ip}, ...] }
 *
 * Owner-only by default, opt-in per account via `ownerTopicAccess`
 * ("activityLogs" — see OWNER_TOPIC_ITEMS in _shared/accounts.js). No
 * rank floor, same as Announcements/Active Agents/Integration Portal —
 * the Owner's explicit per-account grant IS the access decision.
 *
 * The frontend's canAccessOwnerTopic() check (public/index.html) only
 * controls whether the sidebar entry is shown — this server-side check
 * is the real gate; a hidden link is not a security boundary.
 */
import { verifyRequest, canAccessOwnerTopic } from "../../_shared/accounts.js";
import { listActivityLog } from "../../_shared/activityLog.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);
  if (!canAccessOwnerTopic(account, "activityLogs")) {
    return json({ ok: false, error: "Not authorized." }, 403);
  }
  const entries = await listActivityLog(env, { limit: 2000 });
  return json({ ok: true, entries });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
