/**
 * presence.js  (SERVER-ONLY)
 *
 * "Active Agents" — a real-time online/offline board for staff accounts,
 * built on THREADS_KV under its own `presence:` prefix so it never
 * collides with thread/office/account/feature-status keys already
 * living in that same namespace.
 *
 * TWO STATES ONLY — online / offline. There used to be a third
 * "inactive" state (tab backgrounded / idle) with its own, shorter
 * offline threshold. Removed on request: a backgrounded tab that keeps
 * heartbeating counts as online the same as a foreground one now — the
 * only question this board answers is "is their browser still checked
 * in", not "are they actively looking at it right now". See
 * public/assets/presence-heartbeat.js — it no longer tracks idle time
 * or tab visibility for this reason, it just heartbeats.
 *
 * KV SHAPE:
 *   presence:current:<username>  -> { status: "online"|"offline",
 *                                      lastHeartbeat: ISO string,
 *                                      lastWriteTime: epoch ms,
 *                                      dayKey: "YYYY-MM-DD" (Asia/Colombo) }
 *   presence:daily:<username>:<YYYY-MM-DD> -> { totalOnlineMs: number }
 *
 * DELIBERATELY NOT STORED: a per-event timeline (every Online<->Offline
 * transition with a timestamp). Only two things are ever asked of this
 * feature — "what's this agent's status right now" and "how long were
 * they online today/this week" — both answered fully by `current` +
 * `daily`. See PROJECT_STATUS.md-style reasoning notes if this ever
 * needs revisiting.
 *
 * WRITE THROTTLING — the whole point of this file. Every logged-in
 * agent's browser sends a heartbeat every ~15s (see
 * public/assets/presence-heartbeat.js) while its tab is open. Writing
 * KV on every single one of those, unconditionally, is exactly the
 * "write frequency follows poll frequency, not business events" trap:
 * one agent alone burns ~240 writes/hour; a small office blows through
 * KV's free-tier daily write budget in well under a shift. So the
 * server only actually writes when the status changed OR the throttle
 * window has elapsed — see recordHeartbeat() below.
 *
 * THRESHOLD SAFETY MARGIN — MIN_KV_WRITE_INTERVAL_MS (how rarely we're
 * willing to write) MUST stay comfortably BELOW OFFLINE_AFTER_MS (how
 * long without a write before we call someone offline), or a
 * genuinely-online agent gets misjudged offline in the gap between two
 * real writes. Worst case gap between real writes here is roughly
 * MIN_KV_WRITE_INTERVAL_MS + one heartbeat interval (~15s), plus
 * whatever the browser's own background-tab timer throttling adds on
 * top (Chrome clamps a hidden tab's timers to ~60s regardless of what
 * interval was requested — see presence-heartbeat.js's header comment).
 * OFFLINE_AFTER_MS below (5 minutes) leaves wide headroom over that
 * worst case either way, which is also why the write-throttle window
 * could be relaxed to 2 minutes without any real risk of false
 * "offline" flips — fewer writes, same accuracy guarantee.
 */

const MIN_KV_WRITE_INTERVAL_MS = 2 * 60 * 1000; // don't write more than once/2min per agent
const OFFLINE_AFTER_MS = 5 * 60 * 1000; // no heartbeat for 5 minutes -> offline

// Cap how much "online" time a single heartbeat can retroactively credit
// to the daily total. Without this, a laptop that sleeps for 3 hours and
// then wakes up (next heartbeat arrives 3h later) would silently add 3
// fake hours to that day's total. Capped at the offline threshold —
// anything longer than that gap should never have been counted as "was
// online the whole time" in the first place.
const MAX_CREDIT_MS = OFFLINE_AFTER_MS;

function currentKey(username) { return `presence:current:${username}`; }
function dailyKey(username, dayKey) { return `presence:daily:${username}:${dayKey}`; }

/**
 * Day boundary is Asia/Colombo (GMT+5:30) — matches the timezone already
 * used elsewhere in this project (see functions/api/auth/login.js's
 * formatInZone). An agent's "today" total resets at Colombo midnight
 * regardless of the agent's own browser timezone.
 */
export function dayKeyColombo(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

async function getCurrentRaw(env, username) {
  const raw = await env.THREADS_KV.get(currentKey(username));
  return raw ? JSON.parse(raw) : null;
}

async function addDailyCredit(env, username, dayKey, creditMs) {
  if (creditMs <= 0) return;
  const raw = await env.THREADS_KV.get(dailyKey(username, dayKey));
  const daily = raw ? JSON.parse(raw) : { totalOnlineMs: 0 };
  daily.totalOnlineMs = (daily.totalOnlineMs || 0) + creditMs;
  await env.THREADS_KV.put(dailyKey(username, dayKey), JSON.stringify(daily));
}

/**
 * Called on every heartbeat from the browser. A heartbeat only ever
 * means "online" now (see file header) — there's no status to pass in
 * anymore. `deviceType` is "desktop" or "mobile", detected client-side
 * from the User-Agent (see public/assets/presence-heartbeat.js) — real
 * per-agent data, not a static label. Returns fast, without touching KV
 * at all, unless the throttle window has elapsed since the last real
 * write (which also means a device switch — e.g. picking up a phone
 * mid-shift — can take up to MIN_KV_WRITE_INTERVAL_MS to show up on the
 * board; same "good-enough, eventually consistent" trade-off the rest
 * of this file makes elsewhere).
 *
 * NOTE ON DAY-BOUNDARY CREDIT: if a heartbeat's elapsed-time credit
 * straddles a Colombo midnight, the whole credit is attributed to
 * *today's* key rather than being split across the two days. This is a
 * deliberate, documented simplification (same "good-enough aggregate,
 * not to-the-second" trade-off the rest of this file makes) — the
 * error is bounded by MIN_KV_WRITE_INTERVAL_MS and only ever affects
 * the one heartbeat that happens to straddle midnight.
 */
export async function recordHeartbeat(env, username, deviceType) {
  const now = Date.now();
  const current = await getCurrentRaw(env, username);
  const safeDeviceType = deviceType === "mobile" ? "mobile" : "desktop";

  const wasAlreadyOnline = !!current && current.status === "online";
  const elapsedSinceWrite = current ? now - current.lastWriteTime : Infinity;

  if (wasAlreadyOnline && elapsedSinceWrite < MIN_KV_WRITE_INTERVAL_MS) {
    return { written: false };
  }

  // Credit elapsed time toward today's online total, capped at
  // MAX_CREDIT_MS to avoid the sleep/wake spike described above. If the
  // agent had gone offline (or this is their first-ever heartbeat),
  // there's nothing to credit — the clock only starts counting again
  // from this write.
  if (wasAlreadyOnline) {
    const creditMs = Math.min(now - current.lastWriteTime, MAX_CREDIT_MS);
    await addDailyCredit(env, username, current.dayKey || dayKeyColombo(new Date(current.lastWriteTime)), creditMs);
  }

  const fresh = {
    status: "online",
    deviceType: safeDeviceType,
    lastHeartbeat: new Date(now).toISOString(),
    lastWriteTime: now,
    dayKey: dayKeyColombo(new Date(now)),
  };
  await env.THREADS_KV.put(currentKey(username), JSON.stringify(fresh));
  return { written: true };
}

/**
 * Immediate, un-throttled write for the rare, real "this agent just left"
 * events — tab closed (sendBeacon/fetch-keepalive on pagehide) or
 * explicit logout. These are natural low-frequency events, not a
 * polling loop, so bypassing the throttle here doesn't reopen the
 * write-budget problem this file exists to solve. Also credits any
 * remaining online time first, same as a normal heartbeat would.
 * deviceType isn't needed here — an offline agent's device doesn't show
 * on the board (see renderRoster()'s pill logic), so the last-known
 * value from their final recordHeartbeat() call is simply left in
 * place, stale but unused.
 */
export async function markOffline(env, username) {
  const now = Date.now();
  const current = await getCurrentRaw(env, username);
  if (current && current.status === "online") {
    const creditMs = Math.min(now - current.lastWriteTime, MAX_CREDIT_MS);
    await addDailyCredit(env, username, current.dayKey || dayKeyColombo(new Date(current.lastWriteTime)), creditMs);
  }
  await env.THREADS_KV.put(currentKey(username), JSON.stringify({
    status: "offline",
    deviceType: current ? current.deviceType : undefined,
    lastHeartbeat: new Date(now).toISOString(),
    lastWriteTime: now,
    dayKey: dayKeyColombo(new Date(now)),
  }));
}

/**
 * Derives the DISPLAYED status for one agent from their raw `current`
 * record. "offline" is written directly by markOffline() (tab close /
 * logout), OR inferred here, at read time, whenever a heartbeat has
 * gone quiet for longer than OFFLINE_AFTER_MS. This second path is what
 * actually detects "closed the laptop / lost connection / crashed",
 * which a heartbeat-based system can only ever infer from silence,
 * never be told directly.
 */
function deriveStatus(current, now) {
  if (!current) return "offline";
  if (current.status === "offline") return "offline";
  const age = now - current.lastWriteTime;
  if (age > OFFLINE_AFTER_MS) return "offline";
  return "online";
}

/**
 * Batch read for the roster view — one KV get per account for `current`,
 * plus one for today's `daily` total. Reads are not the constrained
 * resource here (KV's free read quota is generous; only writes are
 * scarce), so this is intentionally simple rather than trying to merge
 * keys the way the write path does.
 */
export async function listPresence(env, usernames) {
  const now = Date.now();
  const todayKey = dayKeyColombo(new Date(now));
  const results = await Promise.all(usernames.map(async (username) => {
    const [currentRaw, dailyRaw] = await Promise.all([
      env.THREADS_KV.get(currentKey(username)),
      env.THREADS_KV.get(dailyKey(username, todayKey)),
    ]);
    const current = currentRaw ? JSON.parse(currentRaw) : null;
    const daily = dailyRaw ? JSON.parse(dailyRaw) : null;
    // If still online right now, add the not-yet-credited time since the
    // last write so "today's total" looks live instead of jumping in
    // 2-minute steps — display-only, never written back to KV.
    let liveOnlineMs = daily ? daily.totalOnlineMs || 0 : 0;
    const status = deriveStatus(current, now);
    if (status === "online" && current) {
      liveOnlineMs += Math.min(now - current.lastWriteTime, MAX_CREDIT_MS);
    }
    return {
      username,
      status,
      deviceType: current && current.deviceType === "mobile" ? "mobile" : "desktop",
      lastHeartbeat: current ? current.lastHeartbeat : null,
      todayOnlineMs: liveOnlineMs,
    };
  }));
  return results;
}

/**
 * Daily records for the "Record" search popup — last `days` days of
 * totals for one agent, newest first. Missing days (agent didn't work /
 * feature wasn't live yet) are simply omitted rather than padded with
 * zero rows.
 */
export async function getDailyRecord(env, username, days = 30) {
  const now = new Date();
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    keys.push(dayKeyColombo(d));
  }
  const rows = await Promise.all(keys.map(async (dayKey) => {
    const raw = await env.THREADS_KV.get(dailyKey(username, dayKey));
    if (!raw) return null;
    const daily = JSON.parse(raw);
    return { dayKey, totalOnlineMs: daily.totalOnlineMs || 0 };
  }));
  return rows.filter(Boolean);
}

export const PRESENCE_THRESHOLDS = { MIN_KV_WRITE_INTERVAL_MS, OFFLINE_AFTER_MS };
