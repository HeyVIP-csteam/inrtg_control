/**
 * presence.js  (SERVER-ONLY)
 *
 * "Active Agents" — a real-time online/inactive/offline board for staff
 * accounts, built on THREADS_KV under its own `presence:` prefix so it
 * never collides with thread/office/account/feature-status keys already
 * living in that same namespace.
 *
 * KV SHAPE:
 *   presence:current:<username>  -> { status: "online"|"inactive",
 *                                      lastHeartbeat: ISO string,
 *                                      lastWriteTime: epoch ms,
 *                                      dayKey: "YYYY-MM-DD" (Asia/Colombo) }
 *   presence:daily:<username>:<YYYY-MM-DD> -> { totalOnlineMs: number }
 *
 * DELIBERATELY NOT STORED: a per-event timeline (every Online<->Inactive
 * transition with a timestamp). Only two things are ever asked of this
 * feature — "what's this agent's status right now" and "how long were
 * they online today/this week" — both answered fully by `current` +
 * `daily`. A segmented timeline needs one KV write per status change,
 * which under a 15s-heartbeat, multi-agent office adds up fast; a daily
 * counter needs a write only when the throttle window below allows it.
 * See PROJECT_STATUS.md-style reasoning notes if this ever needs
 * revisiting — the moment someone asks "show me exactly when Agent X
 * went idle at 2pm", that's the signal to add a real timeline back.
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
 * willing to write) MUST stay comfortably BELOW the *_OFFLINE_AFTER_MS
 * thresholds (how long without a write before we call someone offline),
 * or a genuinely-online agent gets misjudged offline in the gap between
 * two real writes. Worst case gap between real writes here is roughly
 * MIN_KV_WRITE_INTERVAL_MS + one heartbeat interval (~15s) for the
 * foreground case, and worse in the background case because Chrome
 * throttles a hidden tab's timers to ~60s on its own — see
 * presence-heartbeat.js's header comment. The numbers below leave
 * deliberate headroom for both.
 */

const MIN_KV_WRITE_INTERVAL_MS = 60 * 1000; // don't write more than once/minute per agent
const ONLINE_OFFLINE_AFTER_MS = 100 * 1000; // foreground heartbeats aren't browser-throttled
const INACTIVE_OFFLINE_AFTER_MS = 150 * 1000; // background tabs get throttled to ~60s by the browser itself

// Cap how much "online" time a single heartbeat can retroactively credit
// to the daily total. Without this, a laptop that sleeps for 3 hours and
// then wakes up (next heartbeat arrives 3h later, previous status was
// "online") would silently add 3 fake hours to that day's total. Capped
// at the offline threshold — anything longer than that gap should never
// have been counted as "was online the whole time" in the first place.
const MAX_CREDIT_MS = ONLINE_OFFLINE_AFTER_MS;

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
 * Called on every heartbeat from the browser. Returns fast, without
 * touching KV at all, unless the status genuinely changed or the
 * throttle window has elapsed — see the file header for why.
 *
 * NOTE ON DAY-BOUNDARY CREDIT: if a heartbeat's elapsed-time credit
 * straddles a Colombo midnight, the whole credit is attributed to
 * *today's* key rather than being split across the two days. This is a
 * deliberate, documented simplification (same "good-enough aggregate,
 * not to-the-second" trade-off the rest of this file makes) — the
 * error is bounded by MIN_KV_WRITE_INTERVAL_MS and only ever affects
 * the one heartbeat that happens to straddle midnight.
 */
export async function recordHeartbeat(env, username, status) {
  const normalizedStatus = status === "inactive" ? "inactive" : "online";
  const now = Date.now();
  const current = await getCurrentRaw(env, username);

  const unchanged = !!current && current.status === normalizedStatus;
  const elapsedSinceWrite = current ? now - current.lastWriteTime : Infinity;

  if (unchanged && elapsedSinceWrite < MIN_KV_WRITE_INTERVAL_MS) {
    return { written: false };
  }

  // Credit elapsed time toward today's online total — only for time that
  // was actually spent "online" (inactive/idle time doesn't count),
  // and only up to MAX_CREDIT_MS to avoid the sleep/wake spike above.
  if (current && current.status === "online") {
    const creditMs = Math.min(now - current.lastWriteTime, MAX_CREDIT_MS);
    await addDailyCredit(env, username, current.dayKey || dayKeyColombo(new Date(current.lastWriteTime)), creditMs);
  }

  const fresh = {
    status: normalizedStatus,
    lastHeartbeat: new Date(now).toISOString(),
    lastWriteTime: now,
    dayKey: dayKeyColombo(new Date(now)),
  };
  await env.THREADS_KV.put(currentKey(username), JSON.stringify(fresh));
  return { written: true };
}

/**
 * Immediate, un-throttled write for the rare, real "this agent just left"
 * events — tab closed (sendBeacon on pagehide) or explicit logout. These
 * are natural low-frequency events, not a polling loop, so bypassing the
 * throttle here doesn't reopen the write-budget problem this file exists
 * to solve. Also credits any remaining online time first, same as a
 * normal heartbeat would.
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
    lastHeartbeat: new Date(now).toISOString(),
    lastWriteTime: now,
    dayKey: dayKeyColombo(new Date(now)),
  }));
}

/**
 * Derives the DISPLAYED status for one agent from their raw `current`
 * record. "offline" is never stored by a heartbeat (only by
 * markOffline() above) — it's computed here, at read time, whenever a
 * heartbeat has gone quiet for longer than the relevant threshold. This
 * is what actually detects "closed the laptop / lost connection /
 * crashed", which a heartbeat-based system can only ever infer from
 * silence, never be told directly.
 */
function deriveStatus(current, now) {
  if (!current) return "offline";
  if (current.status === "offline") return "offline";
  const age = now - current.lastWriteTime;
  const threshold = current.status === "online" ? ONLINE_OFFLINE_AFTER_MS : INACTIVE_OFFLINE_AFTER_MS;
  if (age > threshold) return "offline";
  return current.status; // "online" | "inactive"
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
    // 60s steps — display-only, never written back to KV.
    let liveOnlineMs = daily ? daily.totalOnlineMs || 0 : 0;
    const status = deriveStatus(current, now);
    if (status === "online" && current) {
      liveOnlineMs += Math.min(now - current.lastWriteTime, MAX_CREDIT_MS);
    }
    return {
      username,
      status,
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

export const PRESENCE_THRESHOLDS = { MIN_KV_WRITE_INTERVAL_MS, ONLINE_OFFLINE_AFTER_MS, INACTIVE_OFFLINE_AFTER_MS };
