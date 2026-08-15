/**
 * presence.js  (SERVER-ONLY)
 *
 * Backs the "Active Agents" feature — near-real-time online/inactive/
 * offline presence, plus a 7-day daily-total rollup, for every
 * logged-in agent. Deliberately a SEPARATE system from the existing
 * lightweight `lastActiveAt` field on accounts (see touchLastActive()
 * in accounts.js) — that one is explicitly throttled to 5 minutes and
 * documented as "not a real-time presence indicator"; this one is.
 * Keeping them apart means neither has to compromise on its own use
 * case.
 *
 * DESIGN — heartbeat + timeout, not push:
 * The client (public/assets/presence-heartbeat.js) POSTs
 * /api/presence/heartbeat every 15s while logged in, reporting
 * "online" (tab visible) or "inactive" (tab hidden/switched away — via
 * the Page Visibility API, so this fires the instant a tab is switched,
 * not on the next heartbeat tick). If the browser is closed, crashes,
 * or loses network, no more heartbeats arrive — there is no way for a
 * dying client to reliably send a final "offline" signal, so OFFLINE IS
 * ALWAYS DERIVED, never reported: any read of presence data checks
 * whether the last heartbeat is older than the relevant offline
 * threshold (see ONLINE_OFFLINE_AFTER_MS / INACTIVE_OFFLINE_AFTER_MS
 * below) and treats it as offline if so, regardless of what status was
 * last stored. This is why every getX() below re-derives status instead
 * of trusting the stored value verbatim.
 *
 * STORAGE (all in THREADS_KV, same namespace as accounts/offices):
 *   presence:current:<username>        -> current snapshot (see shape below)
 *   presence:daily:<username>:<yyyy-mm-dd> -> { totalOnlineSeconds, lastActiveAt }
 *     cached rollup, updated incrementally on each heartbeat.
 *
 * NOTE — no more per-segment timeline log. An earlier version of this
 * feature also kept `presence:log:<username>:<date>`, an array of
 * { from, to, status, device, browser, os } segments backing a
 * "Today's timeline" table in the Record popover. That was removed
 * deliberately (real KV-quota pressure — every segment write is its own
 * KV put(), and background-tab heartbeat throttling was fragmenting a
 * single continuous "Inactive" stretch into dozens of tiny segments per
 * day per agent) in favor of keeping ONLY the daily total + current
 * status. If a full per-day timeline is ever wanted again, it needs to
 * be rebuilt as a new, deliberately-throttled feature (e.g. write at
 * most one segment boundary per few minutes), not restored as-is — the
 * per-heartbeat granularity is exactly what made it expensive.
 */

const HEARTBEAT_INTERVAL_MS = 15000;
// KV WRITE THROTTLE — the biggest cost driver by far: the client POSTs a
// heartbeat every 15s (HEARTBEAT_INTERVAL_MS) while a tab is online, and
// an earlier version of this function did an unconditional KV put() on
// EVERY single one of those, whether or not anything actually changed.
// One always-online agent alone was ~4 writes/min x 60min x 8h shift =
// ~1,920 writes/day just to currentKey, before counting dailyKey or any
// other agent — this is what actually exhausts the free-tier 1,000
// writes/day cap. Fix: skip the KV write entirely (just acknowledge the
// heartbeat) whenever nothing meaningful changed AND it hasn't been long
// since the last real write — only write when status/device truly
// changes, OR when MIN_KV_WRITE_INTERVAL_MS has elapsed since the last
// write (a periodic "keep-alive" so a genuinely-online agent's data
// doesn't go stale between real transitions). The client-side 15s
// heartbeat cadence is UNCHANGED — presence-heartbeat.js doesn't need
// touching, this is a server-only optimization.
const MIN_KV_WRITE_INTERVAL_MS = 60000;
// Both offline thresholds below must stay comfortably ABOVE
// MIN_KV_WRITE_INTERVAL_MS — since a real write can now legitimately lag
// up to that long behind the actual heartbeat, a threshold shorter than
// (or too close to) the throttle window would make a genuinely-present
// agent flicker to "offline" every throttle cycle, which is exactly the
// kind of self-inflicted flapping this whole file exists to avoid.
const ONLINE_OFFLINE_AFTER_MS = 90000; // 60s throttle window + 1 heartbeat (15s) + margin
// A BACKGROUNDED tab is a different situation on top of the throttle
// above: browsers (Chrome in particular, once a tab has been hidden for
// a while) throttle setInterval in hidden tabs down to roughly once per
// MINUTE regardless of what interval the page asked for — this is the
// browser's own power-saving behavior, not something presence-
// heartbeat.js can work around client-side. That ~60s client-side
// throttle STACKS with the ~60s server-side write throttle above, so
// this threshold needs more headroom than the online one.
const INACTIVE_OFFLINE_AFTER_MS = 120000;

function pad2(n) { return String(n).padStart(2, "0"); }
function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayKey() { return dateKey(new Date()); }

function currentKey(username) { return `presence:current:${username.toLowerCase()}`; }
function dailyKey(username, date) { return `presence:daily:${username.toLowerCase()}:${date}`; }

async function getCurrent(env, username) {
  const raw = await env.THREADS_KV.get(currentKey(username));
  return raw ? JSON.parse(raw) : null;
}

async function getDaily(env, username, date) {
  const raw = await env.THREADS_KV.get(dailyKey(username, date));
  return raw ? JSON.parse(raw) : { totalOnlineSeconds: 0, lastActiveAt: null };
}

/** Derives the effective status from a stored snapshot, applying the
 * offline timeout — this is the ONLY place "offline" gets decided.
 * Uses a longer allowance for "inactive" than "online" — see the
 * INACTIVE_OFFLINE_AFTER_MS comment above for why a single shared
 * threshold doesn't work once browser background-tab throttling is
 * accounted for. */
function deriveStatus(current, now = Date.now()) {
  if (!current) return "offline";
  const age = now - new Date(current.lastHeartbeat).getTime();
  const threshold = current.status === "inactive" ? INACTIVE_OFFLINE_AFTER_MS : ONLINE_OFFLINE_AFTER_MS;
  if (age > threshold) return "offline";
  return current.status; // "online" | "inactive"
}

/**
 * Called by POST /api/presence/heartbeat. `status` is "online" or
 * "inactive" (never "offline" — see the module note above). Most calls
 * are now a cheap no-op on the KV side (see MIN_KV_WRITE_INTERVAL_MS
 * above) — only a real status/device change, or enough time since the
 * last actual write, bumps `current` and (while online) the daily
 * online-seconds counter. No per-segment log is written anymore — see
 * the module note at the top of this file.
 */
export async function recordHeartbeat(env, username, { status, device, browser, os }) {
  if (status !== "online" && status !== "inactive") throw new Error("Invalid status.");
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const date = todayKey();

  const current = await getCurrent(env, username);
  const unchanged = current
    && current.status === status
    && current.device === device
    && current.browser === browser
    && current.os === os
    && deriveStatus(current, nowMs) !== "offline"; // a timed-out gap always counts as a change

  // ---- THROTTLE: if this heartbeat doesn't represent any real change
  // AND the last actual KV write is still recent, skip KV entirely and
  // just acknowledge it. Every write below this point is now the
  // exception, not the default, for a steady-state agent. ----
  const elapsedSinceWriteMs = current ? nowMs - new Date(current.lastHeartbeat).getTime() : Infinity;
  if (unchanged && elapsedSinceWriteMs < MIN_KV_WRITE_INTERVAL_MS) {
    // Return what's already on file — the response shape stays
    // identical whether or not a write actually happened, so nothing on
    // the client needs to know or care that this heartbeat was a no-op
    // server-side.
    return { status: current.status, lastHeartbeat: current.lastHeartbeat, device: current.device, browser: current.browser, os: current.os };
  }

  if (status === "online") {
    const daily = await getDaily(env, username, date);
    // Credit the ACTUAL elapsed time since the last recorded write, not
    // a fixed HEARTBEAT_INTERVAL_MS — writes no longer land every 15s
    // now that unchanged heartbeats are skipped, so a fixed credit would
    // silently under-count "today's online time" the longer an agent
    // stays steadily online. Capped at 4x the throttle window as a
    // sanity bound (protects against a clock skew or missed-write edge
    // case wildly over-crediting a single write) — for the very first
    // heartbeat ever recorded (no `current`), there's nothing to measure
    // elapsed time from yet, so it just credits one heartbeat interval.
    const creditSeconds = current
      ? Math.min(elapsedSinceWriteMs, MIN_KV_WRITE_INTERVAL_MS * 4) / 1000
      : HEARTBEAT_INTERVAL_MS / 1000;
    daily.totalOnlineSeconds += creditSeconds;
    daily.lastActiveAt = nowIso;
    await env.THREADS_KV.put(dailyKey(username, date), JSON.stringify(daily));
  }

  const fresh = { status, lastHeartbeat: nowIso, device, browser, os };
  await env.THREADS_KV.put(currentKey(username), JSON.stringify(fresh));
  return fresh;
}

/** One row for the main Active Agents list (and for the Record
 * popover's "current status" header) — current effective status plus
 * how long it's held and today's running total. `account` is the
 * already-loaded account record (role/officeId), passed in by the
 * caller so this module never has to import accounts.js itself. */
export async function getListRow(env, account) {
  const username = account.username;
  const current = await getCurrent(env, username);
  const now = Date.now();
  const status = deriveStatus(current, now);
  const daily = await getDaily(env, username, todayKey());
  return {
    username,
    role: account.role,
    officeId: account.officeId,
    status,
    device: current?.device || null,
    browser: current?.browser || null,
    os: current?.os || null,
    // "since" is deliberately the last HEARTBEAT time, not a segment
    // start (there's no segment concept anymore) — good enough for the
    // "just now" / "6 mins ago" display, which only needs recency.
    statusSince: current ? current.lastHeartbeat : null,
    totalOnlineSecondsToday: Math.round(daily.totalOnlineSeconds),
    lastActiveAt: daily.lastActiveAt,
  };
}

/** Last N days (including today) of { date, totalOnlineSeconds,
 * lastActiveAt }, newest first. Today's row is read live, past days
 * come straight from their cached daily rollup. This is now the ONLY
 * historical view the Record popover has — no more per-day timeline
 * (see the module note at the top of this file). */
export async function getLastNDays(env, username, n = 7) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const date = dateKey(d);
    const daily = await getDaily(env, username, date);
    out.push({
      date,
      label: i === 0 ? "Today" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      totalOnlineSeconds: Math.round(daily.totalOnlineSeconds),
      lastActiveAt: daily.lastActiveAt,
    });
  }
  return out;
}
