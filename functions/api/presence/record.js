/**
 * GET /api/presence/record?username=<u>&days=<n> -> { ok, username,
 *   fullName, days: [{ dayKey, totalOnlineMs }] } (newest first)
 *
 * Backs the "🕘 Record" popup inside the Active Agents panel — daily
 * totals only, per the same reasoning as _shared/presence.js's header
 * comment (no per-event timeline is stored, so none can be returned).
 * Same "activeAgents" gate as list.js.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, listAccounts } from "../../_shared/accounts.js";
import { getDailyRecord } from "../../_shared/presence.js";

const MAX_DAYS = 90;

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

  const url = new URL(request.url);
  const username = (url.searchParams.get("username") || "").trim().toLowerCase();
  if (!username) return json({ ok: false, error: "username is required." }, 400);

  const requestedDays = parseInt(url.searchParams.get("days") || "30", 10);
  const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(MAX_DAYS, requestedDays)) : 30;

  const accounts = await listAccounts(env, { viewerUsername: auth.account.username });
  const target = accounts.find((a) => a.username === username);
  if (!target) return json({ ok: false, error: "Unknown agent." }, 404);

  const records = await getDailyRecord(env, username, days);
  records.sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1)); // newest first

  return json({ ok: true, username: target.username, fullName: target.fullName || "", days: records });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
