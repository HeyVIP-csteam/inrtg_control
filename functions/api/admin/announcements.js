/**
 * /api/admin/announcements — management CRUD for the announcements.html page.
 *
 *   GET                                              -> { ok, announcements, topics }
 *   POST { action:"save", id?, text, topic, enabled, startAt, endAt } -> { ok, announcement }
 *   POST { action:"delete", id }                      -> { ok }
 *
 * Gated by canAccessOwnerTopic(account, "announcements") — moved out of
 * Account Management Access into the Agent Profile's "Topic access"
 * list, 2026-08-10 (see OWNER_TOPIC_ITEMS in _shared/accounts.js).
 * STRICTLY the real Owner can grant/restrict this per account (no
 * canGrantAdminAccess delegation). Single tier now — no separate view-
 * vs-edit split like the old Account Management Access model had, since
 * "Topic access" is a plain see-it-or-don't checkbox; anyone granted
 * this topic can both view and manage announcements.
 */
import { authenticateStaff, ROLE_RANK, canAccessOwnerTopic, requestIP } from "../../_shared/accounts.js";
import { listAllAnnouncements, saveAnnouncement, deleteAnnouncement, ANNOUNCEMENT_TOPICS } from "../../_shared/announcements.js";
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
  if (!canAccessOwnerTopic(auth.account, "announcements")) {
    return json({ ok: false, error: "You don't have access to Announcements." }, 403);
  }

  const announcements = await listAllAnnouncements(env);
  return json({ ok: true, announcements, topics: ANNOUNCEMENT_TOPICS });
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
  if (!canAccessOwnerTopic(auth.account, "announcements")) {
    return json({ ok: false, error: "You don't have access to Announcements." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const actorUsername = auth.account ? auth.account.username : "bootstrap";
  const log = (entry) => {
    const p = logActivity(env, { category: "Config", agent: actorUsername, ip: requestIP(request) || "unknown", ...entry });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  };

  if (body.action === "save") {
    try {
      const announcement = await saveAnnouncement(env, {
        id: body.id,
        text: body.text,
        topic: body.topic,
        enabled: body.enabled,
        startAt: body.startAt,
        endAt: body.endAt,
      }, actorUsername);
      log({ action: body.id ? "Announcement Updated" : "Announcement Created", detail: `[${announcement.topic}] ${clip(announcement.text)}` });
      return json({ ok: true, announcement });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "delete") {
    if (!body.id) return json({ ok: false, error: "id is required." }, 400);
    await deleteAnnouncement(env, body.id, actorUsername);
    log({ action: "Announcement Deleted", detail: `Announcement "${body.id}" deleted` });
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function clip(str, max = 200) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
