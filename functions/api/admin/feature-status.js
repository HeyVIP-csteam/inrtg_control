/**
 * /api/admin/feature-status  ("Settings" admin page)
 *
 * Same "one row per controllable item" shape as /api/admin/routes (TG
 * Group/Channel) and /api/admin/deposit-sheets — gated by the "settings"
 * Account Management Access section (superadmin-only by default, same
 * tier as tgRoutes/depositSheets — see defaultSectionsForRank() in
 * _shared/accounts.js).
 *
 *   GET
 *     -> { ok: true, items: [{id,emoji,name}],
 *          statuses: { [itemId]: { status, bypassRoles } } }
 *     Requires canSeeAdminSection(..., "settings").
 *
 *   POST { action:"save", itemId, status, bypassRoles } -> store an
 *     override in THREADS_KV. Takes effect on the very next request for
 *     that item — no redeploy needed. Requires
 *     canEditAdminSection(..., "settings").
 *
 *   POST { action:"reset", itemId } -> delete the override, reverting
 *     that item back to "Active" (the default, nothing blocked).
 *     Requires canEditAdminSection(..., "settings").
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { FEATURE_STATUS_ITEMS, VALID_BYPASS_ROLES, getAllFeatureStatuses, saveFeatureStatus, resetFeatureStatus } from "../../_shared/featureStatus.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have access to Settings." }, 403);
  }

  const statuses = await getAllFeatureStatuses(env);
  return json({ ok: true, items: FEATURE_STATUS_ITEMS, statuses, validBypassRoles: VALID_BYPASS_ROLES });
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
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const itemId = body.itemId;
  if (!FEATURE_STATUS_ITEMS.some((i) => i.id === itemId)) {
    return json({ ok: false, error: `Unknown item "${itemId}".` }, 400);
  }

  if (body.action === "save") {
    try {
      const saved = await saveFeatureStatus(env, itemId, { status: body.status, bypassRoles: body.bypassRoles });
      return json({ ok: true, itemId, status: saved });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await resetFeatureStatus(env, itemId);
    return json({ ok: true, itemId, status: { status: "active", bypassRoles: ["superadmin", "owner"] } });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
