/**
 * /api/admin/announcements — the Announcement management page's API.
 * Admin rank and above only (rank check, not the per-section
 * Account-Management-Access mechanism other admin pages use — an
 * announcement isn't scoped to a "section" an owner can hand out
 * piecemeal, it's just an admin+ tool).
 *
 *   GET  -> { ok: true, announcements: [...] }  (every announcement, any effective state)
 *   POST { action: "save", id?, text, enabled, startAt, endAt } -> { ok: true, announcement }
 *   POST { action: "delete", id } -> { ok: true }
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { listAllAnnouncements, saveAnnouncement, deleteAnnouncement, ANNOUNCEMENT_TOPICS } from "../../_shared/announcements.js";

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
  if (!canSeeAdminSection(auth.account, "announcements")) {
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

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "announcements")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Announcements." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.action === "save") {
    const text = (body.text || "").trim();
    if (!text) return json({ ok: false, error: "Text can't be empty." }, 400);
    if (body.startAt && body.endAt && new Date(body.startAt) >= new Date(body.endAt)) {
      return json({ ok: false, error: "End time must be after start time." }, 400);
    }
    const announcement = await saveAnnouncement(env, {
      id: body.id || null,
      text,
      topic: body.topic,
      enabled: !!body.enabled,
      startAt: body.startAt || null,
      endAt: body.endAt || null,
    }, auth.account?.username || "bootstrap");
    return json({ ok: true, announcement });
  }

  if (body.action === "delete") {
    if (!body.id) return json({ ok: false, error: "Missing id." }, 400);
    const removed = await deleteAnnouncement(env, body.id, auth.account?.username || "bootstrap");
    if (!removed) return json({ ok: false, error: "Not found." }, 404);
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
