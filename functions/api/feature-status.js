/**
 * GET /api/feature-status  -> { ok: true, items: { [itemId]: { status, blocked } } }
 *
 * Read-only, any logged-in agent. `status` is "active" | "maintenance" |
 * "coming_soon" (used to render the breathing-light badge); `blocked` is
 * already resolved against THIS account's role (accountCanBypass), so
 * the frontend never needs to know the bypass-role list itself — a
 * SuperAdmin/Owner testing a "Maintenance" item sees the badge but
 * `blocked: false`, so their own click still goes through.
 *
 * This is UX only — every gated endpoint (submit.js, threads.js,
 * promo-search.js, deposit-issue/*, deposit-backup/*) independently
 * re-checks getFeatureStatus()/accountCanBypass() server-side, so
 * skipping this endpoint and hitting an API directly gains nothing.
 */
import { verifyRequest } from "../_shared/accounts.js";
import { getAllFeatureStatuses, accountCanBypass } from "../_shared/featureStatus.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: true, items: {} });
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const all = await getAllFeatureStatuses(env);
  const items = {};
  for (const [itemId, s] of Object.entries(all)) {
    items[itemId] = {
      status: s.status,
      blocked: s.status !== "active" && !accountCanBypass(account, s.bypassRoles),
    };
  }
  return json({ ok: true, items });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
