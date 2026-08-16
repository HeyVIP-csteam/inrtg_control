/**
 * /api/admin/announcement-settings — the banner's rotation-speed control
 * (lives on the Settings tab, alongside Maintenance/Coming-soon).
 *
 *   GET                          -> { ok, rotateIntervalMs }
 *   POST { rotateIntervalMs }    -> { ok, rotateIntervalMs }
 *
 * Gated by the "settings" Account Management Access section — same tier
 * as the Maintenance/Coming-soon controls — DELIBERATELY NOT the
 * "announcements" section: "manage the announcements" and "manage how
 * the banner behaves" are different concerns. This is a global
 * display-behavior setting, not per-announcement content.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { getAnnouncementSettings, saveAnnouncementSettings } from "../../_shared/announcements.js";
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
  const auth = await authenticateStaff(request, env, ROLE_RANK.admin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have access to Settings." }, 403);
  }
  const settings = await getAnnouncementSettings(env);
  return json({ ok: true, ...settings });
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
  const auth = await authenticateStaff(request, env, ROLE_RANK.admin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have access to Settings." }, 403);
  }
  if (!canEditAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  try {
    const settings = await saveAnnouncementSettings(env, { rotateIntervalMs: body.rotateIntervalMs });
    const p = logActivity(env, { category: "Config", action: "Announcement Rotation Speed Changed", agent: auth.account ? auth.account.username : "bootstrap", ip: requestIP(request) || "unknown", detail: `rotateIntervalMs = ${settings.rotateIntervalMs}` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
    return json({ ok: true, ...settings });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 400);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
