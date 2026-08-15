/**
 * announcements.js  (SERVER-ONLY)
 *
 * Site-wide "REMINDER" banner + its admin management page. Reuses the
 * app's existing THREADS_KV namespace — no new namespace needed. Three
 * keys, all JSON:
 *
 *   announcements            -> array of announcement records
 *   announcement-settings    -> { rotateIntervalMs }
 *
 * Announcements realistically never number more than a handful, so a
 * single get()/put() on one JSON-array key is simplest and cheap — don't
 * copy the heavier list()+metadata+cache pattern threads.js uses for its
 * (potentially thousands-of-records) ticket list.
 *
 * SCHEDULING — no cron job, and none is needed. isEffectivelyActive() is
 * evaluated fresh on every read (every banner poll). Nothing ever writes
 * to KV when a schedule window opens or closes — "auto on / auto off" is
 * purely a side effect of recomputing this on each request. Simpler and
 * more reliable than a cron job (no missed-run risk, no drift).
 */

const ANNOUNCEMENTS_KEY = "announcements";
const SETTINGS_KEY = "announcement-settings";

export const ANNOUNCEMENT_TOPICS = [
  "Friendly reminder",
  "Game maintenance",
  "System maintenance",
  "Deposit / Withdraw Issues",
];

const DEFAULT_SETTINGS = { rotateIntervalMs: 5000 };
const MIN_ROTATE_INTERVAL_MS = 1000;

function genId() {
  return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** The scheduling check — see the module header note above. */
export function isEffectivelyActive(a, now = Date.now()) {
  if (!a.enabled) return false;
  if (a.startAt && now < new Date(a.startAt).getTime()) return false;
  if (a.endAt && now > new Date(a.endAt).getTime()) return false;
  return true;
}

async function readAll(env) {
  if (!env.THREADS_KV) return [];
  const raw = await env.THREADS_KV.get(ANNOUNCEMENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(env, list) {
  await env.THREADS_KV.put(ANNOUNCEMENTS_KEY, JSON.stringify(list));
}

/** Every announcement, any state — admin (management page) view. */
export async function listAllAnnouncements(env) {
  const list = await readAll(env);
  return list.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

/** Only effectively-active ones, sorted oldest-active-first — banner view. */
export async function getActiveAnnouncements(env) {
  const list = await readAll(env);
  const now = Date.now();
  return list
    .filter((a) => isEffectivelyActive(a, now))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

/**
 * Create (no `id`) or update (with `id`) an announcement. Validates
 * `topic` against the fixed list, falling back to the first topic if
 * invalid/missing, and that `endAt` is after `startAt` if both are set.
 */
export async function saveAnnouncement(env, { id, text, topic, enabled, startAt, endAt }, actorUsername) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("Message text is required.");

  const cleanTopic = ANNOUNCEMENT_TOPICS.includes(topic) ? topic : ANNOUNCEMENT_TOPICS[0];
  const cleanStart = startAt ? new Date(startAt).toISOString() : null;
  const cleanEnd = endAt ? new Date(endAt).toISOString() : null;
  if (cleanStart && cleanEnd && new Date(cleanEnd).getTime() <= new Date(cleanStart).getTime()) {
    throw new Error("End time must be after start time.");
  }

  const list = await readAll(env);
  const now = new Date().toISOString();
  let saved;

  if (id) {
    const idx = list.findIndex((a) => a.id === id);
    if (idx === -1) throw new Error("Announcement not found.");
    saved = {
      ...list[idx],
      text: cleanText,
      topic: cleanTopic,
      enabled: !!enabled,
      startAt: cleanStart,
      endAt: cleanEnd,
      updatedBy: actorUsername,
      updatedAt: now,
    };
    list[idx] = saved;
    await logToSheet(env, "edited", saved, actorUsername);
  } else {
    saved = {
      id: genId(),
      text: cleanText,
      topic: cleanTopic,
      enabled: !!enabled,
      startAt: cleanStart,
      endAt: cleanEnd,
      createdBy: actorUsername,
      createdAt: now,
      updatedBy: actorUsername,
      updatedAt: now,
    };
    list.push(saved);
    await logToSheet(env, "created", saved, actorUsername);
  }

  await writeAll(env, list);
  return saved;
}

export async function deleteAnnouncement(env, id, actorUsername) {
  const list = await readAll(env);
  const found = list.find((a) => a.id === id);
  const next = list.filter((a) => a.id !== id);
  await writeAll(env, next);
  if (found) await logToSheet(env, "deleted", found, actorUsername);
}

export async function getAnnouncementSettings(env) {
  if (!env.THREADS_KV) return DEFAULT_SETTINGS;
  const raw = await env.THREADS_KV.get(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw);
    const ms = Number(parsed.rotateIntervalMs);
    return { rotateIntervalMs: Number.isFinite(ms) && ms >= MIN_ROTATE_INTERVAL_MS ? ms : DEFAULT_SETTINGS.rotateIntervalMs };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveAnnouncementSettings(env, { rotateIntervalMs }) {
  const ms = Number(rotateIntervalMs);
  if (!Number.isFinite(ms) || ms < MIN_ROTATE_INTERVAL_MS) {
    throw new Error(`rotateIntervalMs must be a number >= ${MIN_ROTATE_INTERVAL_MS}.`);
  }
  const settings = { rotateIntervalMs: ms };
  await env.THREADS_KV.put(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

/**
 * Best-effort audit log to a Google Sheet — the app never reads this
 * sheet back, it's purely for record-keeping. No-ops silently if
 * env.ANNOUNCEMENT_LOG_SHEET_ID isn't set, and never throws (a logging
 * failure must never fail the actual save/delete).
 */
async function logToSheet(env, action, announcement, actorUsername) {
  if (!env.ANNOUNCEMENT_LOG_SHEET_ID) return;
  try {
    const { appendRowToSheet } = await import("./googleSheets.js");
    await appendRowToSheet(env, env.ANNOUNCEMENT_LOG_SHEET_ID, env.ANNOUNCEMENT_LOG_TAB || "Log", {
      timestamp: new Date().toISOString(),
      action,
      actor: actorUsername || "",
      topic: announcement.topic || "",
      text: announcement.text || "",
      enabled: announcement.enabled ? "yes" : "no",
      startAt: announcement.startAt || "",
      endAt: announcement.endAt || "",
      id: announcement.id || "",
    });
  } catch (e) {
    console.error("announcements: audit log failed (non-blocking):", e && e.message || e);
  }
}
