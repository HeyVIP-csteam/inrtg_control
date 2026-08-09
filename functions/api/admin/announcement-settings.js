/**
 * /api/admin/announcement-settings — Settings tab's control for how fast
 * the reminder banner cycles through 2+ simultaneously active
 * announcements. Gated by the "settings" admin section — same tier as
 * Maintenance/Coming soon on this same tab — NOT by "announcements"
 * (that section only covers the announcements themselves, see
 * /api/admin/announcements.js).
 *
 *   GET  -> { ok: true, rotateIntervalMs }
 *   POST { rotateIntervalMs } -> { ok: true, rotateIntervalMs }
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { getAnnouncementSettings, saveAnnouncementSettings } from "../../_shared/announcements.js";

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

  const ms = Number(body.rotateIntervalMs);
  if (!Number.isFinite(ms) || ms < 1000) {
    return json({ ok: false, error: "Rotation interval must be at least 1 second." }, 400);
  }

  const settings = await saveAnnouncementSettings(env, { rotateIntervalMs: ms });
  return json({ ok: true, ...settings });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
