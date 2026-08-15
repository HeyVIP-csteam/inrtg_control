/**
 * GET /api/presence/record?username=<u>
 *
 * Backs the Record popover on the Active Agents page: one specific
 * agent's current status (today's total online time, last active time)
 * plus their last 7 days rollup. Same canViewActiveAgents gate as
 * list.js.
 *
 * No `date` param / per-day timeline anymore — that was removed from
 * presence.js for KV-quota reasons, see the module note at the top of
 * _shared/presence.js. This endpoint only ever returns "now" plus the
 * last 7 days' daily totals.
 */
import { authenticateStaff, ROLE_RANK, canViewActiveAgents, getAccount } from "../../_shared/accounts.js";
import { getListRow, getLastNDays } from "../../_shared/presence.js";

export async function onRequestGet(context) {
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
  if (!canViewActiveAgents(auth.account)) return json({ ok: false, error: "You don't have access to Active Agents." }, 403);

  const url = new URL(request.url);
  const username = (url.searchParams.get("username") || "").trim().toLowerCase();
  if (!username) return json({ ok: false, error: "Missing username." }, 400);

  const target = await getAccount(env, username);
  if (!target || target.role === "owner") return json({ ok: false, error: "Agent not found." }, 404);

  const [today, last7] = await Promise.all([getListRow(env, target), getLastNDays(env, username, 7)]);

  return json({ ok: true, username, today, last7 });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
