/**
 * GET /api/announcements -> { ok, announcements: [{id, text, topic, startAt, endAt}], rotateIntervalMs }
 *
 * Public banner endpoint — any LOGGED-IN account can call this (not
 * admin-only, the banner is a broadcast). Gated by the Maintenance/
 * Coming-soon system under item id "announcements" (see
 * _shared/featureStatus.js): if that's toggled off and the caller's role
 * isn't in the bypass list, this returns an EMPTY list, not a 403 — the
 * banner just stays quiet rather than erroring for everyone else.
 *
 * Only returns announcements where isEffectivelyActive() is true right
 * now (see _shared/announcements.js — this is what makes schedules turn
 * on/off with zero manual toggling and no cron job).
 */
import { verifyRequest } from "../_shared/accounts.js";
import { getActiveAnnouncements, getAnnouncementSettings } from "../_shared/announcements.js";
import { getFeatureStatus, accountCanBypass } from "../_shared/featureStatus.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const settings = await getAnnouncementSettings(env);

  const status = await getFeatureStatus(env, "announcements");
  if (status.status !== "active" && !accountCanBypass(account, status.bypassRoles)) {
    return json({ ok: true, announcements: [], rotateIntervalMs: settings.rotateIntervalMs });
  }

  const active = await getActiveAnnouncements(env);
  const announcements = active.map((a) => ({
    id: a.id,
    text: a.text,
    topic: a.topic,
    startAt: a.startAt,
    endAt: a.endAt,
  }));
  return json({ ok: true, announcements, rotateIntervalMs: settings.rotateIntervalMs });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
