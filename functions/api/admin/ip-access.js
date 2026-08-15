/**
 * /api/admin/ip-access
 *   GET                                              -> { stats, pending, approved, blocked, offices, record }
 *   POST { action:"approve",   officeId, ip }
 *   POST { action:"reject",    officeId, ip }
 *   POST { action:"block",     ip, reason? }
 *   POST { action:"unblock",   ip }
 *   POST { action:"manualAdd", officeId, ip }
 *   POST { action:"remove",    officeId, ip }
 *
 * Reuses the existing "whitelistIp" permission bit — Can-See gets GET
 * (view only), Can-Edit is required for every POST action. Deliberately
 * NOT a new permission dimension; this whole feature is "make Whitelist
 * IP smarter", not a separate thing that owners need to remember to
 * grant separately. See _shared/ipAccess.js for the actual logic — this
 * file is just auth + request parsing + dispatch.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import {
  getIpAccessDashboard, listIpAccessLog, isValidIpFormat,
  approveIpRequest, rejectIpRequest, blockIp, unblockIp, manualAddIp, removeIp,
} from "../../_shared/ipAccess.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.admin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "whitelistIp")) return json({ ok: false, error: "Not authorized." }, 403);

  const [dashboard, record] = await Promise.all([getIpAccessDashboard(env), listIpAccessLog(env)]);
  return json({ ok: true, ...dashboard, record });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.admin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "whitelistIp")) {
    return json({ ok: false, error: "You don't have Can-Edit access to IP Access." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const by = auth.account?.username || "bootstrap";
  const byRole = auth.account?.role || "bootstrap";
  const ip = (body.ip || "").trim();

  try {
    if (body.action === "approve") {
      if (!body.officeId || !ip) return json({ ok: false, error: "Missing officeId or ip." }, 400);
      await approveIpRequest(env, { officeId: body.officeId, ip, by, byRole });
      return json({ ok: true });
    }

    if (body.action === "reject") {
      if (!body.officeId || !ip) return json({ ok: false, error: "Missing officeId or ip." }, 400);
      await rejectIpRequest(env, { officeId: body.officeId, ip, by, byRole });
      return json({ ok: true });
    }

    if (body.action === "block") {
      if (!ip) return json({ ok: false, error: "Missing ip." }, 400);
      if (!isValidIpFormat(ip)) return json({ ok: false, error: `"${ip}" doesn't look like a valid IPv4 or IPv6 address.` }, 400);
      await blockIp(env, { ip, reason: body.reason || "", by, byRole });
      return json({ ok: true });
    }

    if (body.action === "unblock") {
      if (!ip) return json({ ok: false, error: "Missing ip." }, 400);
      await unblockIp(env, { ip, by, byRole });
      return json({ ok: true });
    }

    if (body.action === "manualAdd") {
      if (!body.officeId || !ip) return json({ ok: false, error: "Missing officeId or ip." }, 400);
      if (!isValidIpFormat(ip)) return json({ ok: false, error: `"${ip}" doesn't look like a valid IPv4 or IPv6 address.` }, 400);
      await manualAddIp(env, { officeId: body.officeId, ip, by, byRole });
      return json({ ok: true });
    }

    if (body.action === "remove") {
      if (!body.officeId || !ip) return json({ ok: false, error: "Missing officeId or ip." }, 400);
      await removeIp(env, { officeId: body.officeId, ip, by, byRole });
      return json({ ok: true });
    }
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 400);
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
