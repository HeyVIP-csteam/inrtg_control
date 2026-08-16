/**
 * /api/admin/offices
 *   GET                                  -> list offices. Base floor rank
 *     >= senior; canSeeAdminSection() then does the real per-account
 *     gating. Full IP data only if Can-See Whitelist IP; otherwise
 *     id+name only (enough to populate an office picker).
 *   POST { action:"save", id?, name, allowedIPs[] }  -> create/update.
 *     Requires Can-Edit access to Whitelist IP.
 *   POST { action:"delete", id }         -> delete. Requires Can-Edit
 *     access to Whitelist IP.
 *
 * See _shared/accounts.js authenticateStaff() for the two ways in (real
 * login at the required rank, or the one-time bootstrap password), and
 * canSeeAdminSection()/canEditAdminSection() for the Account Management
 * Access layer that replaced the old flat rank checks here.
 */
import { listOffices, saveOffice, deleteOffice, authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { logActivity } from "../../_shared/activityLog.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  // Base floor is senior — the lowest floor among the sections that need
  // this endpoint (createAccount). canSeeAdminSection() below does the
  // real per-section gating. This matters because a Senior-rank account
  // whose ONLY admin access is Create Account still needs to reach this
  // endpoint to populate the office picker when creating a new account —
  // it used to require rank >= admin outright, which silently broke that
  // picker for exactly that account type (a real bug, fixed here).
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);

  const canSeeIPs = canSeeAdminSection(auth.account, "whitelistIp");
  const canEnter = canSeeIPs || canSeeAdminSection(auth.account, "createAccount") || canSeeAdminSection(auth.account, "agentProfile") || canSeeAdminSection(auth.account, "tgRoutes");
  if (!canEnter) return json({ ok: false, error: "Not authorized." }, 403);

  const offices = await listOffices(env);
  // Full IP whitelist data only if this account can actually see Whitelist
  // IP — everyone else (e.g. Create-Account-only) gets just id+name, enough
  // to populate a dropdown without leaking IP data they have no access to.
  if (canSeeIPs) return json({ ok: true, offices });
  return json({ ok: true, offices: offices.map((o) => ({ id: o.id, name: o.name })) });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  // Editing IPs requires Can-Edit access to Whitelist IP — owner-controlled
  // per account now, not a flat SuperAdmin-only rule. The bootstrap
  // password still works here during initial setup (creating the very
  // first Office before any admin account exists) since authenticateStaff
  // grants bootstrap mode full trust until an admin-or-above account
  // exists — see _shared/accounts.js.
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "whitelistIp")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Whitelist IP." }, 403);
  }
  const log = (entry) => {
    const p = logActivity(env, { category: "Config", agent: auth.account ? auth.account.username : "bootstrap-setup", ip: requestIP(request) || "unknown", ...entry });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.action === "save") {
    if (!body.name) return json({ ok: false, error: "Office name is required." }, 400);
    const office = await saveOffice(env, { id: body.id, name: body.name, allowedIPs: body.allowedIPs || [] });
    log({ action: body.id ? "Office Updated" : "Office Created", detail: `"${office.name}" — ${(office.allowedIPs || []).length} whitelisted IP(s)` });
    return json({ ok: true, office });
  }

  if (body.action === "delete") {
    if (!body.id) return json({ ok: false, error: "Missing office id." }, 400);
    await deleteOffice(env, body.id);
    log({ action: "Office Deleted", detail: `Office "${body.id}" deleted` });
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
