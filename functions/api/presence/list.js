/**
 * GET /api/presence/list
 *
 * Backs the main "Active Agents" page — one row per logged-in-capable
 * account (everyone in the accounts index, not just currently-online
 * ones, so Offline agents show up too) with their current effective
 * status, today's running online total, and last-active time.
 *
 * Gated by canViewActiveAgents(account) — see _shared/accounts.js for
 * why this is a flat Owner-granted flag rather than a rank tier.
 */
import { authenticateStaff, ROLE_RANK, canViewActiveAgents, listOffices } from "../../_shared/accounts.js";
import { getListRow } from "../../_shared/presence.js";

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

  const raw = await env.THREADS_KV.get("accounts-index");
  const usernames = raw ? JSON.parse(raw) : [];
  const accounts = (
    await Promise.all(usernames.map((u) => env.THREADS_KV.get(`account:${u}`)))
  )
    .filter(Boolean)
    .map((a) => JSON.parse(a))
    .filter((a) => a.role !== "owner"); // owner rows never appear in any account listing, see listAccounts()

  const offices = await listOffices(env);
  const officeNameById = Object.fromEntries(offices.map((o) => [o.id, o.name]));

  const rows = await Promise.all(
    accounts.map(async (a) => {
      const row = await getListRow(env, a);
      return { ...row, officeName: officeNameById[a.officeId] || null };
    })
  );

  const total = rows.length;
  const online = rows.filter((r) => r.status === "online").length;
  const inactive = rows.filter((r) => r.status === "inactive").length;
  const offline = total - online - inactive;

  return json({ ok: true, stats: { total, online, inactive, offline }, agents: rows });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
