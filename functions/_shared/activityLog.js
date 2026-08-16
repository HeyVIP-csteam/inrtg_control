/**
 * activityLog.js  (SERVER-ONLY)
 *
 * Site-wide audit trail — "who did what, when, from where" — covering
 * four categories: Auth (login success/failure/lockout), Account
 * (create/delete/role/permissions/password/lock), Thread (TG Reply
 * Threads actions), and Config (routes, IP whitelist, announcements,
 * brand links, batch backfill, etc).
 *
 * STORAGE — one KV key PER entry, data in `metadata`, not `value`.
 *
 * A single shared key (e.g. one big JSON array under one key) would hit
 * Cloudflare KV's "at most 1 write/sec to the SAME key" limit the moment
 * two agents did anything loggable in the same second — exactly the trap
 * the old pre-D1 threads sidebar cache (`"index"` key) used to fall into.
 * Every entry instead gets its own key:
 *
 *   key:      activitylog:<13-digit ms timestamp>:<4-char random>
 *   value:    "1"                      <- placeholder; real data isn't here
 *   metadata: { ts, category, action, agent, detail, ip }
 *
 * list() returns every key's metadata inline, so reading N entries costs
 * one paginated list() call, never N separate get()s. KV metadata has a
 * ~1024-byte (serialized) ceiling, so `detail` is clipped well under that.
 *
 * Writes are wrapped in try/catch and meant to be fired via waitUntil() —
 * a logging hiccup must NEVER fail or slow down the real action it's
 * describing.
 */

const PREFIX = "activitylog:";
const RETENTION_DAYS = 90;
const SWEEP_SAMPLE_RATE = 0.05; // only 5% of reads actually run the sweep
const SAFETY_SCAN_CAP = 20000; // hard ceiling on how many keys list() will walk

function clip(str, max) {
  const s = String(str ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Fire-and-forget write. Never throws — a failure here must not be able
 * to take down (or even slow down) whatever real action triggered it.
 */
export async function logActivity(env, { category, action, agent, detail, ip } = {}) {
  try {
    if (!env?.THREADS_KV) return;
    const ts = Date.now();
    const entry = {
      ts,
      category: clip(category || "Config", 20),
      action: clip(action || "", 60),
      agent: clip(agent || "unknown", 80),
      detail: clip(detail || "", 700),
      ip: clip(ip || "unknown", 60),
    };
    const key = `${PREFIX}${ts}:${Math.random().toString(36).slice(2, 8)}`;
    await env.THREADS_KV.put(key, "1", { metadata: entry });
  } catch {
    // Never let a logging failure surface to the caller.
  }
}

/**
 * Reads back up to `limit` entries, newest first. Also opportunistically
 * sweeps expired (>90 days old) entries on a small % of calls instead of
 * needing a dedicated cron trigger — same "sample on read/write" trick
 * used elsewhere in this codebase.
 */
export async function listActivityLog(env, { limit = 1000 } = {}) {
  if (!env?.THREADS_KV) return [];
  const all = [];
  let cursor;
  do {
    const page = await env.THREADS_KV.list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const k of page.keys) {
      if (k.metadata) all.push({ ...k.metadata, __key: k.name });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && all.length < SAFETY_SCAN_CAP);

  all.sort((a, b) => b.ts - a.ts);
  sweepExpired(env, all).catch(() => {});
  return all.slice(0, limit).map(({ __key, ...rest }) => rest);
}

async function sweepExpired(env, entries) {
  if (Math.random() >= SWEEP_SAMPLE_RATE) return;
  const now = Date.now();
  const expiredKeys = entries
    .filter((e) => (now - e.ts) / 86400000 > RETENTION_DAYS)
    .map((e) => e.__key);
  if (!expiredKeys.length) return;
  await Promise.all(expiredKeys.map((k) => env.THREADS_KV.delete(k).catch(() => {})));
}

/**
 * Convenience factory used by callers that already have (env, agent, ip)
 * in scope and just want a short `log({ category, action, detail })`
 * call, fired via waitUntil() so it never adds latency to the response.
 */
export function makeActivityLogger(env, { agent, ip, waitUntil } = {}) {
  return (entry) => {
    const p = logActivity(env, { agent, ip, ...entry });
    if (waitUntil) waitUntil(p);
    else p.catch(() => {});
  };
}
