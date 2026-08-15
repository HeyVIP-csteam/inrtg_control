/**
 * GET /api/announcements -> { ok: true, announcements: [{id, text, startAt, endAt}, ...] }
 *
 * The banner's own data source — every logged-in agent can read this
 * (the banner is a broadcast, not an admin-only view), even though only
 * admin+ can create/edit them (see /api/admin/announcements.js). Only
 * returns announcements that are effectively active right now (enabled
 * AND within any configured start/end window) — see
 * _shared/announcements.js's isEffectivelyActive().
 */
import { getActiveAnnouncements, getAnnouncementSettings } from "../_shared/announcements.js";
import { verifyRequest } from "../_shared/accounts.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.THREADS_KV) return json({ ok: true, announcements: [], rotateIntervalMs: 5000 });
    const account = await verifyRequest(request, env);
    if (!account) return json({ ok: false, error: "Login required." }, 401);

    const [active, settings] = await Promise.all([getActiveAnnouncements(env), getAnnouncementSettings(env)]);
    return json({
      ok: true,
      announcements: active.map((a) => ({ id: a.id, text: a.text, topic: a.topic, startAt: a.startAt, endAt: a.endAt })),
      rotateIntervalMs: settings.rotateIntervalMs,
    });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
