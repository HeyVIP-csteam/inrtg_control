/**
 * GET /api/presence/list -> { ok, agents: [{ username, fullName, role,
 *   officeName, status, lastHeartbeat, todayOnlineMs }], stats: { online,
 *   offline, total } }
 *
 * Two states only (online/offline) — see _shared/presence.js's header
 * comment for why "inactive" was removed.
 *
 * OWNER IS NEVER INCLUDED — filtered out unconditionally below,
 * regardless of who's viewing (even the Owner's own view of this
 * panel). See the comment on that filter for why this is stricter than
 * listAccounts()'s usual "hidden from everyone except itself" rule.
 *
 * Gated by canSeeAdminSection(account, "activeAgents") — same flexible
 * per-account model as every other Account Management Access section
 * (see _shared/accounts.js's ADMIN_SECTIONS_LIST). Floor is superadmin;
 * the Owner can extend or restrict individual accounts from there via
 * the existing Agent Profile "Account Management Access" checkboxes,
 * exactly like Whitelist IP / TG Routes / Settings / Announcements.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, listAccounts, listOffices } from "../../_shared/accounts.js";
import { listPresence } from "../../_shared/presence.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok || !auth.account) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "activeAgents")) {
    return json({ ok: false, error: "You don't have access to Active Agents." }, 403);
  }

  const [rawAccounts, offices] = await Promise.all([
    listAccounts(env, { viewerUsername: auth.account.username }),
    listOffices(env),
  ]);
  // Owner is excluded from this board unconditionally — not just from
  // OTHER viewers (listAccounts()'s default behavior already hides
  // owner-role accounts from everyone except the owner itself), but
  // from the owner's own view of this panel too. Presence data (online
  // status, device, today's online time) is a different sensitivity
  // class than "does an account exist" — the Owner not appearing here
  // at all, regardless of who's looking, is the simpler and stricter
  // guarantee.
  const accounts = rawAccounts.filter((a) => a.role !== "owner");
  const officeNameById = Object.fromEntries((offices || []).map((o) => [o.id, o.name]));
  const usernames = accounts.map((a) => a.username);
  const presence = await listPresence(env, usernames);
  const byUsername = Object.fromEntries(presence.map((p) => [p.username, p]));

  const agents = accounts.map((a) => {
    const p = byUsername[a.username] || { status: "offline", deviceType: "desktop", lastHeartbeat: null, todayOnlineMs: 0 };
    return {
      username: a.username,
      fullName: a.fullName || "",
      role: a.role,
      officeName: a.officeId ? (officeNameById[a.officeId] || "") : "",
      locked: !!a.locked,
      status: a.locked ? "offline" : p.status,
      deviceType: p.deviceType,
      lastHeartbeat: p.lastHeartbeat,
      todayOnlineMs: p.todayOnlineMs,
    };
  });

  const stats = { online: 0, offline: 0, total: agents.length };
  for (const a of agents) stats[a.status] = (stats[a.status] || 0) + 1;

  return json({ ok: true, agents, stats });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
