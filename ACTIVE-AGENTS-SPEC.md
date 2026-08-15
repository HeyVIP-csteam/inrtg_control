# Active Agents — full spec & code reference

> **⚠️ PARTIALLY OUTDATED — read this note before trusting anything below.**
> This document describes the FEATURE AS ORIGINALLY DELIVERED. Since
> then, real production usage surfaced a KV-quota problem and the
> backend was substantially rewritten:
> - The per-heartbeat `presence:log:<user>:<date>` timeline (§8's
>   `getDayTimeline()`, the "Today's timeline" table in §3/§8, the
>   `logKey()`/`getLog()`/`closeOpenSegment()` functions) has been
>   **removed entirely** — it was the single biggest KV-write cost, and
>   background-tab heartbeat throttling was fragmenting a continuous
>   "Inactive" stretch into dozens of spurious segments per day per
>   agent. The Record popover now only shows current status + today's
>   total online time + the Last 7 days rollup — no per-day timeline.
> - `recordHeartbeat()` no longer writes to KV on every heartbeat — see
>   `MIN_KV_WRITE_INTERVAL_MS` in the actual `functions/_shared/
>   presence.js` on disk. Most heartbeats are now a no-op server-side.
> - The offline thresholds in §4/§8 (45s flat) are stale — the real
>   values are `ONLINE_OFFLINE_AFTER_MS` (90s) and
>   `INACTIVE_OFFLINE_AFTER_MS` (120s) in the current file.
> - The feature is no longer a dedicated page
>   (`public/active-agents.html`, referenced throughout §3/§8/§9, has
>   been DELETED) — it's a popup opened from the Home page's tool-card
>   grid, in `public/assets/active-agents-modal.js`.
>
> **The actual source on disk is authoritative.** Everything below this
> notice — design tokens, component sizes, layout structure — is still
> accurate for the visual/UX side; only the presence-tracking BACKEND
> (§4 status logic, §5 is fine, §8 full source) has moved on. Don't
> port §8's presence.js/record.js code as-is; read the real files
> instead.

Everything needed to port this feature to another project: exact sizes,
colors, spacing, thresholds, and the complete source of every file.

---

## 1. Design tokens used (from `style.css` `:root`, dark mode)

| Token | Value | Used for |
|---|---|---|
| `--ink` | `#eef1fb` | Primary text, username, selected-value text |
| `--ink-soft` | `#9aa3c4` | Muted text, labels, placeholders, secondary info |
| `--label-blue` | `#a9c1ff` | Field labels, section headers, the "To" column (distinguishes it from "From") |
| `--border` | `#262c50` | Default card/input border |
| `--panel-border` | `rgba(255,255,255,0.08)` | Table cell dividers (subtler than the card border) |
| `--field-bg` | `#1a2040` | Input/select background, avatar circle background, tag pill background |
| `--card-bg` | `#141a33` | Card background, table header row background |
| `--accent-gold` | `#f3c463` | Primary button, selected day-row highlight, hover states |
| `#34d399` | green | Online status (dot, text, avatar-badge, breathing animation) |
| `#5f5e5a` | gray | Offline status dot |
| `--font-mono` | `"JetBrains Mono", ...` | All timestamps and durations (fixed-width digits, easier to scan) |

No new colors were introduced — everything reuses tokens already defined
in the project's `style.css`, so it inherits light/dark mode for free.

---

## 2. Component sizes (final, after iteration)

| Element | Size |
|---|---|
| List row avatar | 34×34px, `border-radius:9px` |
| List row avatar-badge (status dot on avatar corner) | 11×11px, `border:2px solid var(--card-bg)` (cuts a ring out of the avatar so it doesn't look glued on) |
| List row status column width | fixed `100px` (right-aligned status + dot) — **fixed width is the fix** for the "dots don't align between rows" bug: without it, `Online`/`Inactive`/`Offline` being different string lengths shifted the whole flex block sideways |
| Stat pills | `border-radius:999px` (full pill), `padding:7px 14px`, reused `.ipa-stat-card` class from the IP Access page for the 4-stat grid version |
| Record popover width | **820px** (`max-width`) — went through 480 → 680 → 820 across iterations; 820 was the point where the 5-column timeline table stopped needing a horizontal scrollbar at normal zoom |
| Record popover timeline table columns | `From 17% / To 17% / Status 15% / Duration 19% / Device 32%` (`table-layout:fixed`) |
| Record popover Last-7-days table columns | `Date / Total online time / Last active time` — no fixed widths needed, only 3 columns |
| Breathing dot animation | `box-shadow` pulse, `1.8s ease-in-out infinite`, `0 0 0 0` → `0 0 0 6px` fading opacity — **only the Online dot animates**; Inactive/Offline are static gray, per explicit instruction ("只有online需要呼吸灯") |

---

## 3. Layout structure

```
Active Agents page
├── Header row: title + subtitle, "↻ Refresh" + "🕒 Record" buttons (top-right)
├── Search input (filters the list below by username/office)
├── Stat pills: Total / Online / Inactive / Offline
├── List (sorted: online first, then inactive, then offline; newest status-change first within each group)
│   └── Row: avatar+badge | username + role/device tags | status+dot (fixed 100px, right-aligned) + relative time
└── Record popover (opened by the header button, NOT by clicking a row)
    ├── Step 1 — search: text input + scrollable name list, click a name
    └── Step 2 — detail: "← Back to search" | avatar+username+role tag
        ├── "Last active: <time>"
        ├── Today's timeline table (From/To/Status/Duration/Device, newest-first, unresolved segment shows "now")
        └── Last 7 days table (clickable rows — click a past date to re-render the timeline table for that day, selected row highlighted gold)
```

**Key interaction decisions (each was corrected at least once during design review, noted so the reasoning isn't lost):**
- Record is reached via a **dedicated top-right button**, not by clicking a list row — matches the existing IP Access page's Record button pattern.
- The search-then-detail flow inside Record is **two states of the same popover**, not two separate popovers — "← Back to search" swaps the innerHTML back rather than closing/reopening.
- Timeline rows are **newest-first** (most recent status change at the top) — this applies to both the daily timeline and the Last 7 days table (Today row on top).
- "From" and "To" are **separate columns with different text colors** (`--ink` vs `--label-blue`) — originally one combined "09:02 AM → 10:15 AM" string, split apart because on narrow screens the combined string overflowed into neighboring columns.
- Table cells use `word-break: break-word` (wrap), **not** `white-space: nowrap` + horizontal scroll — an earlier nowrap version broke on narrow viewports (text overlapping between columns); switched to wrapping so the fixed 5-column layout survives at any width.

---

## 4. Status logic

```
online   -> tab visible AND heartbeat received within the last 45s
inactive -> tab hidden/backgrounded (Page Visibility API) AND heartbeat within 45s
offline  -> no heartbeat for 45s+  (ALWAYS DERIVED, never sent by the client —
            a crashed/closed browser can never reliably announce "I'm offline")
```

- Heartbeat interval: **15 seconds** (client-side POST cadence — unchanged).
- Offline threshold: **90 seconds while online, 120 seconds while inactive** (was a single flat 45s originally — split apart after two real-world issues surfaced: (1) backgrounded tabs get throttled by the browser to ~1 heartbeat/min, which flapped a 45s threshold to "offline" every cycle; (2) the server itself now throttles KV writes to at most once per 60s per agent when nothing's actually changed — see "KV write throttling" below — so a real write can legitimately lag up to that long behind the true heartbeat).
- **KV write throttling (added after a real quota incident):** the server does NOT write to KV on every heartbeat anymore. A heartbeat that doesn't represent a real status/device change, and arrived less than `MIN_KV_WRITE_INTERVAL_MS` (60s) after the last actual write, is acknowledged and dropped — zero KV operations. This is a server-only change; the client still POSTs every 15s exactly as before. See `MIN_KV_WRITE_INTERVAL_MS` in `functions/_shared/presence.js` for the full reasoning — an always-online agent went from ~4 writes/min to ~1 write/min this way.
- Status changes on `visibilitychange` fire **immediately**, not on the next heartbeat tick — switching tabs registers as inactive within milliseconds, not up to 15s late.

## 5. Time/duration formatting (single source of truth — reused everywhere to avoid the "6m vs 6 mins" inconsistency that came up repeatedly during design review)

```js
function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function fmtClock(iso) {
  // -> "12:30:07 PM"  (always includes seconds)
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}
function fmtRelative(iso) {
  // -> "just now" / "6 mins ago" / "2 hours ago" / "3 days ago"
  // <30s = "just now"; always the FULL word "mins"/"hours"/"days", never abbreviated "m"/"h"
}
```

## 6. Device/browser/OS detection — hard limits (worth keeping if you port this)

- **Can** reliably detect: mobile vs desktop, browser name + major version, OS family. All from `navigator.userAgent`.
- **Cannot** detect, on any browser, for any platform: laptop vs desktop PC (no API exposes this — deliberate browser privacy limit), or a machine's hostname/custom device name (also not exposed to web pages). Don't promise these in a UI without a manual-entry fallback.

## 7. Permission model

- Flat, **not** rank-tiered like every other admin section in this codebase.
- Nobody gets it by default — not even the highest non-owner rank.
- Only **Owner** can grant/revoke it, per-account, to literally any rank including the lowest.
- Owner itself is always unconditionally allowed (same convention as every other permission in the app).

```js
export function canViewActiveAgents(account) {
  if (!account) return false;
  if (account.role === "owner") return true;
  return !!account.canViewActiveAgents; // flat boolean, no tiering, no rank floor
}
```

---

## 8. Full source

All files below are also in the delivered zip. Reproduced here so the
whole feature can be read/copied without unzipping.

### `functions/_shared/presence.js`

```javascript
/**
 * presence.js  (SERVER-ONLY)
 *
 * Backs the "Active Agents" feature — near-real-time online/inactive/
 * offline presence, plus a per-day timeline and a 7-day rollup, for
 * every logged-in agent. Deliberately a SEPARATE system from the
 * existing lightweight `lastActiveAt` field on accounts (see
 * touchLastActive() in accounts.js) — that one is explicitly throttled
 * to 5 minutes and documented as "not a real-time presence indicator";
 * this one is. Keeping them apart means neither has to compromise on
 * its own use case.
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
 * whether the last heartbeat is older than OFFLINE_AFTER_MS and treats
 * it as offline if so, regardless of what status was last stored. This
 * is why every getX() below re-derives status instead of trusting the
 * stored value verbatim.
 *
 * STORAGE (all in THREADS_KV, same namespace as accounts/offices):
 *   presence:current:<username>        -> current snapshot (see shape below)
 *   presence:log:<username>:<yyyy-mm-dd> -> array of timeline segments for that day
 *   presence:daily:<username>:<yyyy-mm-dd> -> { totalOnlineSeconds, lastActiveAt }
 *     cached rollup, updated incrementally on each heartbeat so the
 *     Last 7 days table doesn't need to re-scan a full day's log on
 *     every read.
 *
 * A "segment" is one continuous stretch of a single status:
 *   { from: ISOString, to: ISOString|null, status, device, browser, os }
 * `to: null` means "still ongoing" — closed off (given a real `to`)
 * the moment the status changes, or read as "now" (or day-end, for a
 * past day) when displayed.
 */

const HEARTBEAT_INTERVAL_MS = 15000;
// Anything older than 3 missed heartbeats is treated as offline — long
// enough to absorb a slow network blip or a background-tab throttled
// timer, short enough that "online" stays meaningful.
const OFFLINE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

function pad2(n) { return String(n).padStart(2, "0"); }
function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayKey() { return dateKey(new Date()); }

function currentKey(username) { return `presence:current:${username.toLowerCase()}`; }
function logKey(username, date) { return `presence:log:${username.toLowerCase()}:${date}`; }
function dailyKey(username, date) { return `presence:daily:${username.toLowerCase()}:${date}`; }

async function getCurrent(env, username) {
  const raw = await env.THREADS_KV.get(currentKey(username));
  return raw ? JSON.parse(raw) : null;
}

async function getLog(env, username, date) {
  const raw = await env.THREADS_KV.get(logKey(username, date));
  return raw ? JSON.parse(raw) : [];
}

async function getDaily(env, username, date) {
  const raw = await env.THREADS_KV.get(dailyKey(username, date));
  return raw ? JSON.parse(raw) : { totalOnlineSeconds: 0, lastActiveAt: null };
}

/** Derives the effective status from a stored snapshot, applying the
 * offline timeout — this is the ONLY place "offline" gets decided. */
function deriveStatus(current, now = Date.now()) {
  if (!current) return "offline";
  const age = now - new Date(current.lastHeartbeat).getTime();
  if (age > OFFLINE_AFTER_MS) return "offline";
  return current.status; // "online" | "inactive"
}

/**
 * Called by POST /api/presence/heartbeat. `status` is "online" or
 * "inactive" (never "offline" — see the module note above). Closes the
 * previous timeline segment and opens a new one if the status (or
 * device/browser/os — e.g. the same person switching machines) changed
 * since the last heartbeat; otherwise just extends the ongoing segment
 * and bumps the daily online-seconds counter.
 */
export async function recordHeartbeat(env, username, { status, device, browser, os }) {
  if (status !== "online" && status !== "inactive") throw new Error("Invalid status.");
  const now = new Date();
  const nowIso = now.toISOString();
  const date = todayKey();

  const current = await getCurrent(env, username);
  const sameSegment = current
    && current.status === status
    && current.device === device
    && current.browser === browser
    && current.os === os
    && deriveStatus(current, now.getTime()) !== "offline"; // a timed-out gap always starts a fresh segment

  const log = await getLog(env, username, date);

  if (sameSegment) {
    // Extend the ongoing segment — nothing to close/open, just bump
    // lastHeartbeat on the snapshot and (if online) the daily total.
  } else {
    // Close whatever was open (if anything, and if it belongs to today —
    // a segment that started yesterday and is still "open" at midnight
    // is left for the day-boundary reconciliation in getRecord() to
    // split, not handled here to keep heartbeat writes cheap).
    if (log.length && log[log.length - 1].to === null) {
      log[log.length - 1].to = nowIso;
    }
    log.push({ from: nowIso, to: null, status, device, browser, os });
    await env.THREADS_KV.put(logKey(username, date), JSON.stringify(log));
  }

  const heartbeatSeconds = HEARTBEAT_INTERVAL_MS / 1000;
  if (status === "online") {
    const daily = await getDaily(env, username, date);
    daily.totalOnlineSeconds += heartbeatSeconds;
    daily.lastActiveAt = nowIso;
    await env.THREADS_KV.put(dailyKey(username, date), JSON.stringify(daily));
  }

  const fresh = { status, lastHeartbeat: nowIso, device, browser, os };
  await env.THREADS_KV.put(currentKey(username), JSON.stringify(fresh));
  return fresh;
}

/** One row for the main Active Agents list — current effective status
 * plus how long it's held and today's running total. `account` is the
 * already-loaded account record (role/officeId), passed in by the
 * caller so this module never has to import accounts.js itself. */
export async function getListRow(env, account) {
  const username = account.username;
  const current = await getCurrent(env, username);
  const now = Date.now();
  const status = deriveStatus(current, now);
  const since = current ? new Date(current.lastHeartbeat).getTime() : null; // approximation, see note below
  const daily = await getDaily(env, username, todayKey());
  return {
    username,
    role: account.role,
    officeId: account.officeId,
    status,
    device: current?.device || null,
    browser: current?.browser || null,
    os: current?.os || null,
    // "since" is deliberately the last HEARTBEAT time, not the segment
    // start — good enough for the list's "just now" / "6 mins ago"
    // display, which only needs recency, not exact segment duration
    // (that level of precision lives in the Record popover's timeline).
    statusSince: current ? current.lastHeartbeat : null,
    totalOnlineSecondsToday: Math.round(daily.totalOnlineSeconds),
    lastActiveAt: daily.lastActiveAt,
  };
}

/** Closes an "open" segment against `now` (or against the last instant
 * of a PAST day, at 23:59:59) so every segment in the returned list has
 * a real `to` — the raw KV log always has at most one open segment
 * (the most recent), everything else is already closed by
 * recordHeartbeat(). */
function closeOpenSegment(segments, date, now) {
  if (!segments.length) return segments;
  const last = segments[segments.length - 1];
  if (last.to !== null) return segments;
  const isToday = date === todayKey();
  const closedTo = isToday ? new Date(now).toISOString() : `${date}T23:59:59.999Z`;
  return [...segments.slice(0, -1), { ...last, to: closedTo }];
}

/** Today's (or a past day's) full timeline for one agent, newest
 * segment first, each with a computed duration in seconds. */
export async function getDayTimeline(env, username, date) {
  const raw = await getLog(env, username, date);
  const closed = closeOpenSegment(raw, date, Date.now());
  return closed
    .map((seg) => ({
      ...seg,
      durationSeconds: Math.max(0, Math.round((new Date(seg.to).getTime() - new Date(seg.from).getTime()) / 1000)),
    }))
    .reverse(); // newest first
}

/** Last N days (including today) of { date, totalOnlineSeconds,
 * lastActiveAt }, newest first. Today's row is read live (not yet
 * "closed"), past days come straight from their cached daily rollup. */
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

```

### `functions/api/presence/heartbeat.js`

```javascript
/**
 * POST /api/presence/heartbeat
 *
 * Called every 15s by public/assets/presence-heartbeat.js for any
 * logged-in agent (no Active Agents permission required to SEND a
 * heartbeat about yourself — canViewActiveAgents only gates who can
 * VIEW the resulting data, not who gets tracked; everyone logged in is
 * tracked, same as the existing lastActiveAt mechanism).
 *
 * Body: { status: "online"|"inactive", device: "desktop"|"mobile",
 *         browser: "Chrome 128", os: "Windows" }
 */
import { authenticateStaff, ROLE_RANK } from "../../_shared/accounts.js";
import { recordHeartbeat } from "../../_shared/presence.js";

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handle({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok || !auth.account) return json({ ok: false, error: "Not authorized." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const status = body.status === "inactive" ? "inactive" : "online";
  const device = body.device === "mobile" ? "mobile" : "desktop";
  const browser = (body.browser || "Unknown browser").slice(0, 40);
  const os = (body.os || "Unknown OS").slice(0, 40);

  const fresh = await recordHeartbeat(env, auth.account.username, { status, device, browser, os });
  return json({ ok: true, presence: fresh });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

```

### `functions/api/presence/list.js`

```javascript
/**
 * GET /api/presence/list
 *
 * Backs the main "Active Agents" page — one row per logged-in-capable
 * account (everyone in the accounts index, not just currently-online
 * ones, so Offline agents show up too) with their current effective
 * status, today's running online total, and last-active time.
 *
 * Gated by canViewActiveAgents(account) — see _shared/accounts.js for
 * why this is a flat Owner-granted flag rather than a rank tier.
 */
import { authenticateStaff, ROLE_RANK, canViewActiveAgents, listOffices } from "../../_shared/accounts.js";
import { getListRow } from "../../_shared/presence.js";

export async function onRequestGet(context) {
  try {
    return await handle(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handle({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok || !auth.account) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canViewActiveAgents(auth.account)) return json({ ok: false, error: "You don't have access to Active Agents." }, 403);

  const raw = await env.THREADS_KV.get("accounts-index");
  const usernames = raw ? JSON.parse(raw) : [];
  const accounts = (
    await Promise.all(usernames.map((u) => env.THREADS_KV.get(`account:${u}`)))
  )
    .filter(Boolean)
    .map((a) => JSON.parse(a))
    .filter((a) => a.role !== "owner"); // owner rows never appear in any account listing, see listAccounts()

  const offices = await listOffices(env);
  const officeNameById = Object.fromEntries(offices.map((o) => [o.id, o.name]));

  const rows = await Promise.all(
    accounts.map(async (a) => {
      const row = await getListRow(env, a);
      return { ...row, officeName: officeNameById[a.officeId] || null };
    })
  );

  const total = rows.length;
  const online = rows.filter((r) => r.status === "online").length;
  const inactive = rows.filter((r) => r.status === "inactive").length;
  const offline = total - online - inactive;

  return json({ ok: true, stats: { total, online, inactive, offline }, agents: rows });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

```

### `functions/api/presence/record.js`

```javascript
/**
 * GET /api/presence/record?username=<u>&date=<yyyy-mm-dd>
 *
 * Backs the Record popover on the Active Agents page: one specific
 * agent's timeline for a given day (defaults to today) plus their last
 * 7 days rollup. Same canViewActiveAgents gate as list.js.
 */
import { authenticateStaff, ROLE_RANK, canViewActiveAgents, getAccount } from "../../_shared/accounts.js";
import { getDayTimeline, getLastNDays } from "../../_shared/presence.js";

export async function onRequestGet(context) {
  try {
    return await handle(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handle({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok || !auth.account) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canViewActiveAgents(auth.account)) return json({ ok: false, error: "You don't have access to Active Agents." }, 403);

  const url = new URL(request.url);
  const username = (url.searchParams.get("username") || "").trim().toLowerCase();
  if (!username) return json({ ok: false, error: "Missing username." }, 400);

  const target = await getAccount(env, username);
  if (!target || target.role === "owner") return json({ ok: false, error: "Agent not found." }, 404);

  const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "Invalid date." }, 400);

  const [timeline, last7] = await Promise.all([getDayTimeline(env, username, date), getLastNDays(env, username, 7)]);

  return json({ ok: true, username, date, timeline, last7 });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

```

### `public/assets/presence-heartbeat.js`

```javascript
/**
 * presence-heartbeat.js  (SHARED — include on every logged-in page,
 * right after authguard.js)
 *
 * Sends a heartbeat to /api/presence/heartbeat every 15s for as long as
 * this tab is open and the agent is logged in, so the Active Agents
 * page (public/active-agents.html) can show near-real-time presence.
 *
 * "Active" vs "inactive" is decided by the Page Visibility API, NOT a
 * mouse/keyboard idle timer — switching to another tab, minimizing the
 * window, or switching to another app all fire `visibilitychange`
 * IMMEDIATELY (not on the next 15s tick), so status changes the instant
 * the tab stops being the visible one, matching "tab switch = inactive"
 * exactly as specced. There is no "offline" status sent from here —
 * offline is always DERIVED server-side from a stale heartbeat (see
 * the module note in functions/_shared/presence.js) since a closed tab
 * or crashed browser can never reliably send a final signal itself.
 *
 * Device/browser/OS are parsed from navigator.userAgent — this can
 * reliably distinguish mobile vs desktop and identify browser name +
 * major version + OS family, but CANNOT distinguish a laptop from a
 * desktop PC (no browser exposes that, on any platform) and CANNOT
 * read a machine's hostname/device name (no web API exposes that
 * either) — both are hard browser privacy limits, not something a
 * smarter parser could work around.
 */
(function () {
  if (!window.AgentAuth || !window.AgentAuth.getAuth()) return; // not logged in, nothing to track

  const HEARTBEAT_INTERVAL_MS = 15000;

  function detectDevice() {
    const ua = navigator.userAgent;
    const isMobile = /Mobi|Android(?!.*Tablet)|iPhone|iPod/.test(ua) || (/Android|iPad|Tablet/.test(ua) && !/Windows NT/.test(ua));
    return isMobile ? "mobile" : "desktop";
  }

  function detectBrowser() {
    const ua = navigator.userAgent;
    let m;
    if ((m = ua.match(/Edg\/(\d+)/))) return `Edge ${m[1]}`;
    if ((m = ua.match(/OPR\/(\d+)/))) return `Opera ${m[1]}`;
    if ((m = ua.match(/Chrome\/(\d+)/)) && !/Chromium/.test(ua)) return `Chrome ${m[1]}`;
    if ((m = ua.match(/Firefox\/(\d+)/))) return `Firefox ${m[1]}`;
    if ((m = ua.match(/Version\/(\d+).*Safari/)) ) return `Safari ${m[1]}`;
    return "Unknown browser";
  }

  function detectOS() {
    const ua = navigator.userAgent;
    if (/Windows NT/.test(ua)) return "Windows";
    if (/Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)) return "macOS";
    if (/Android/.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
    if (/Linux/.test(ua)) return "Linux";
    return "Unknown OS";
  }

  const payloadBase = { device: detectDevice(), browser: detectBrowser(), os: detectOS() };

  function currentStatus() {
    return document.visibilityState === "visible" ? "online" : "inactive";
  }

  function sendHeartbeat() {
    if (!window.AgentAuth || !window.AgentAuth.getAuth()) return; // logged out mid-session
    window.AgentAuth.authFetch("/api/presence/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: currentStatus(), ...payloadBase }),
    }).catch(() => {}); // best-effort — a dropped heartbeat just makes this tick a no-op, next one recovers
  }

  // Immediately on load, and immediately again on every visibility flip
  // (tab switch, minimize, app switch) — not waiting for the next
  // interval tick is what makes "inactive" register instantly rather
  // than up to 15s late.
  sendHeartbeat();
  document.addEventListener("visibilitychange", sendHeartbeat);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
})();

```

### `public/active-agents.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Active Agents</title>
<script src="/assets/theme.js?v=c61fb537"></script>
<style>
html {
  background-color: #090c1c;
  background-image:
    linear-gradient(180deg, rgba(3,4,13,0.35) 0%, rgba(3,4,13,0.55) 55%, rgba(3,4,13,0.75) 100%),
    url('/assets/img/bg-space.jpg');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-attachment: fixed;
}
html[data-theme="light"] {
  background-color: #dbe7fb;
  background-image:
    radial-gradient(900px 500px at 90% 0%, #eaf1ff 0%, transparent 55%),
    linear-gradient(160deg, #dbe7fb 0%, #d9cef4 45%, #cdbdf2 75%, #c4b2ee 100%);
}
</style>
<link rel="stylesheet" href="/assets/style.css?v=02e525a7" />
<link rel="stylesheet" href="/assets/toast.css?v=5779b14e" />
<script src="/assets/toast.js?v=d9d84724"></script>
<script src="/assets/starfield.js?v=b6e92821" defer></script>
<script src="/assets/authguard.js?v=19b1b251"></script>
<script src="/assets/presence-heartbeat.js?v=5e3bab29"></script>
<script src="/assets/announcement-banner.js?v=26c15118" defer></script>
<script src="/assets/schemas.js?v=189eea70"></script>
</head>
<body class="threads-page">
  <header class="topbar">
    <div class="topbar-left">
      <img src="/assets/img/logo.webp" alt="HeyVIP" class="logo-img" />
      <span class="wordmark">PKR CS TEAM - TBC</span>
    </div>
    <div class="topbar-right">
      <span class="clock" id="liveClock"></span>
      <button class="theme-pill" id="themeToggle"></button>
    </div>
  </header>

  <div class="threads-shell" id="threadsShell">
    <aside class="sidebar" id="hubNavMount"></aside>
    <div class="threads-content-col">
      <nav class="brand-row" id="pageBrandRow"><div class="brand-row-track"></div></nav>
      <div id="announcementBanner"></div>

      <main class="hub-main">
        <div class="inner">

          <div id="aaNoAccess" style="display:none;" class="ipa-section">
            <div class="ipa-section-body">
              <p class="ipa-hint">You don't have access to Active Agents. This section is granted individually by the Owner — ask them if you believe you should have it.</p>
            </div>
          </div>

          <div id="aaRoot" style="display:none;">
            <div class="ipa-header-actions" style="justify-content:space-between; margin-bottom:14px;">
              <div>
                <div class="ipa-table-title" style="font-size:16px;">Active Agents</div>
                <p style="color:var(--ink-soft); font-size:11.5px; margin:2px 0 0;">Tab switch = inactive · Auto-refreshes every 10s</p>
              </div>
              <div style="display:flex; gap:8px;">
                <button type="button" class="ipa-header-btn" id="aaRefreshBtn">↻ Refresh</button>
                <button type="button" class="ipa-header-btn" id="aaRecordBtn">🕒 Record</button>
              </div>
            </div>

            <div style="position:relative; margin-bottom:14px;">
              <span style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--ink-soft); font-size:13px;">🔍</span>
              <input type="text" id="aaSearch" placeholder="Search by username or office..." autocomplete="off"
                style="width:100%; box-sizing:border-box; height:36px; background:var(--field-bg); border:1.5px solid var(--border); border-radius:8px; padding:0 12px 0 34px; color:var(--ink); font-size:12.5px; font-family:inherit;" />
            </div>

            <div class="ipa-stats" id="aaStats"></div>

            <div id="aaList" style="display:flex; flex-direction:column; gap:8px;"></div>
            <p id="aaEmpty" class="ipa-empty" style="display:none; text-align:center; padding:24px;">No agents match.</p>
          </div>

        </div>
      </main>
    </div>
  </div>

  <div class="ipa-popover-scrim" id="aaRecordScrim" style="display:none;"></div>
  <div class="ipa-popover" id="aaRecordPopover" style="display:none; max-width:820px;"></div>

  <script src="/assets/hub-nav.js?v=faffc891"></script>
  <script src="/assets/brand-row.js?v=ea371f55"></script>
  <script>
    window.HubNav.mount("hubNavMount", {});
    window.BrandRow.mount("pageBrandRow");
    window.initThemeToggle();
    window.initClock();

    const authFetch = window.AgentAuth.authFetch;
    const myAuth = window.AgentAuth.getAuth();

    // ---- Formatting helpers (single source of truth — see the many
    // rounds of "unify the time format" iteration this went through) ----
    function fmtDuration(totalSeconds) {
      const s = Math.max(0, Math.round(totalSeconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (h > 0) return `${h}h ${m}m ${sec}s`;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    }
    function fmtClock(iso) {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "—";
      return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
    }
    function fmtRelative(iso) {
      if (!iso) return "—";
      const then = new Date(iso).getTime();
      if (isNaN(then)) return "—";
      const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (diffSec < 30) return "just now";
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mins ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`;
      return `${Math.floor(diffSec / 86400)} days ago`;
    }
    function roleLabel(role) {
      if (!role) return "—";
      return role.charAt(0).toUpperCase() + role.slice(1);
    }
    function deviceLabel(device) {
      return device === "mobile" ? "Mobile" : "Desktop";
    }
    function escAttr(s) { return String(s == null ? "" : s).replace(/"/g, "&quot;"); }
    function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    // ---- Main list ----
    let aaData = null; // last GET /api/presence/list response
    let aaSearchTerm = "";

    async function aaLoadList() {
      try {
        const res = await authFetch("/api/presence/list");
        const data = await res.json();
        if (!data.ok) {
          if (res.status === 403) {
            document.getElementById("aaNoAccess").style.display = "";
            document.getElementById("aaRoot").style.display = "none";
          }
          return;
        }
        aaData = data;
        document.getElementById("aaNoAccess").style.display = "none";
        document.getElementById("aaRoot").style.display = "";
        aaRenderStats();
        aaRenderList();
      } catch {
        // best-effort — leave the last-known list showing, try again next tick
      }
    }

    function aaRenderStats() {
      const s = aaData.stats;
      document.getElementById("aaStats").innerHTML = `
        <div class="ipa-stat-card active" style="border-color:var(--accent-gold);">
          <span class="ipa-stat-label">Total</span>
          <span class="ipa-stat-value">${s.total}</span>
        </div>
        <div class="ipa-stat-card">
          <span class="ipa-stat-label">Online</span>
          <span class="ipa-stat-value ipa-green">${s.online}</span>
        </div>
        <div class="ipa-stat-card">
          <span class="ipa-stat-label">Inactive</span>
          <span class="ipa-stat-value">${s.inactive}</span>
        </div>
        <div class="ipa-stat-card">
          <span class="ipa-stat-label">Offline</span>
          <span class="ipa-stat-value">${s.offline}</span>
        </div>
      `;
    }

    function aaRenderList() {
      const term = aaSearchTerm.trim().toLowerCase();
      const agents = aaData.agents
        .filter((a) => !term || a.username.toLowerCase().includes(term) || (a.officeName || "").toLowerCase().includes(term))
        .sort((a, b) => {
          const rank = { online: 0, inactive: 1, offline: 2 };
          if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
          return (b.statusSince || "").localeCompare(a.statusSince || "");
        });

      const listEl = document.getElementById("aaList");
      const emptyEl = document.getElementById("aaEmpty");
      if (!agents.length) {
        listEl.innerHTML = "";
        emptyEl.style.display = "";
        return;
      }
      emptyEl.style.display = "none";

      listEl.innerHTML = agents.map((a) => {
        const initial = a.username.charAt(0).toUpperCase();
        const isOnline = a.status === "online";
        const isInactive = a.status === "inactive";
        const dotClass = isOnline ? "aa-dot-online" : "aa-dot-gray";
        const statusLabel = isOnline ? "Online" : isInactive ? "Inactive" : "Offline";
        const statusColor = isOnline ? "#34d399" : "var(--ink-soft)";
        const timeText = isOnline || isInactive ? fmtRelative(a.statusSince) : fmtRelative(a.lastActiveAt);
        return `
          <div class="ipa-table-block" style="margin-bottom:0; padding:11px 10px 11px 14px; display:flex; align-items:center; gap:12px; border:1.5px solid var(--border); border-radius:12px; ${isOnline ? "" : "opacity:0.75;"}">
            <div style="position:relative; flex-shrink:0;">
              <div style="width:34px; height:34px; border-radius:9px; background:var(--field-bg); display:flex; align-items:center; justify-content:center; color:${isOnline ? "#34d399" : "var(--ink-soft)"}; font-weight:700; font-size:13px;">${escHtml(initial)}</div>
              <span class="${dotClass}" style="position:absolute; bottom:-2px; right:-2px; width:11px; height:11px; border-radius:50%; border:2px solid var(--card-bg);"></span>
            </div>
            <div style="flex:1; min-width:0;">
              <div style="color:var(--ink); font-weight:700; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(a.username)}</div>
              <div style="display:flex; gap:6px; margin-top:4px; flex-wrap:wrap;">
                <span style="color:var(--ink-soft); font-size:10.5px; background:var(--field-bg); border-radius:5px; padding:2px 7px;">${escHtml(roleLabel(a.role))}</span>
                <span style="color:var(--ink-soft); font-size:10.5px; background:var(--field-bg); border-radius:5px; padding:2px 7px;">${escHtml(deviceLabel(a.device))}</span>
              </div>
            </div>
            <div style="width:100px; flex-shrink:0;">
              <div style="display:flex; align-items:center; gap:6px; justify-content:flex-end;">
                <span class="${dotClass}" style="width:7px; height:7px; border-radius:50%; flex-shrink:0;"></span>
                <span style="color:${statusColor}; font-size:11.5px; font-weight:700;">${statusLabel}</span>
              </div>
              <div style="color:var(--ink-soft); font-size:10.5px; margin-top:2px; text-align:right;">${escHtml(timeText)}</div>
            </div>
          </div>
        `;
      }).join("");
    }

    document.getElementById("aaSearch").addEventListener("input", (e) => {
      aaSearchTerm = e.target.value;
      if (aaData) aaRenderList();
    });
    document.getElementById("aaRefreshBtn").addEventListener("click", aaLoadList);

    aaLoadList();
    setInterval(aaLoadList, 10000);

    // ---- Record popover: search-first, then a detail view ----
    let aaRecordSelectedUsername = null;

    function aaOpenRecord() {
      aaRecordSelectedUsername = null;
      document.getElementById("aaRecordScrim").style.display = "";
      document.getElementById("aaRecordPopover").style.display = "";
      aaRenderRecordSearch("");
    }
    function aaCloseRecord() {
      document.getElementById("aaRecordScrim").style.display = "none";
      document.getElementById("aaRecordPopover").style.display = "none";
    }
    document.getElementById("aaRecordBtn").addEventListener("click", aaOpenRecord);
    document.getElementById("aaRecordScrim").addEventListener("click", aaCloseRecord);

    function aaRenderRecordSearch(term) {
      const pop = document.getElementById("aaRecordPopover");
      const t = term.trim().toLowerCase();
      const matches = (aaData ? aaData.agents : [])
        .filter((a) => !t || a.username.toLowerCase().includes(t))
        .slice(0, 30);
      pop.innerHTML = `
        <div class="ipa-popover-header">
          <p class="ipa-popover-title">🕒 Record</p>
          <span style="color:var(--ink-soft); cursor:pointer;" id="aaRecordClose">✕</span>
        </div>
        <div style="position:relative; margin-bottom:12px;">
          <span style="position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--ink-soft); font-size:12px;">🔍</span>
          <input type="text" id="aaRecordSearchInput" placeholder="Search agent by name..." autocomplete="off" value="${escAttr(term)}"
            style="width:100%; box-sizing:border-box; height:36px; background:var(--field-bg); border:1.5px solid var(--border); border-radius:8px; padding:0 12px 0 32px; color:var(--ink); font-size:12.5px; font-family:inherit;" />
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; max-height:280px; overflow-y:auto;">
          ${matches.map((a) => {
            const dotColor = a.status === "online" ? "#34d399" : "var(--ink-soft)";
            return `
              <div class="aa-record-pick" data-username="${escAttr(a.username)}" style="display:flex; align-items:center; gap:10px; padding:8px 9px; border-radius:7px; cursor:pointer;">
                <div style="width:26px; height:26px; border-radius:7px; background:var(--field-bg); display:flex; align-items:center; justify-content:center; color:var(--ink-soft); font-weight:700; font-size:11px; flex-shrink:0;">${escHtml(a.username.charAt(0).toUpperCase())}</div>
                <span style="color:var(--ink); font-size:12.5px; flex:1;">${escHtml(a.username)}</span>
                <span style="width:6px; height:6px; border-radius:50%; background:${dotColor};"></span>
              </div>
            `;
          }).join("") || '<p class="ipa-hint" style="text-align:center;">No matches.</p>'}
        </div>
      `;
      document.getElementById("aaRecordClose").addEventListener("click", aaCloseRecord);
      document.getElementById("aaRecordSearchInput").addEventListener("input", (e) => aaRenderRecordSearch(e.target.value));
      pop.querySelectorAll(".aa-record-pick").forEach((el) => {
        el.addEventListener("click", () => aaOpenRecordDetail(el.dataset.username));
      });
    }

    async function aaOpenRecordDetail(username, date) {
      aaRecordSelectedUsername = username;
      const pop = document.getElementById("aaRecordPopover");
      pop.innerHTML = `<div class="ipa-popover-header"><p class="ipa-popover-title">🕒 Loading…</p></div>`;
      try {
        const url = "/api/presence/record?username=" + encodeURIComponent(username) + (date ? "&date=" + encodeURIComponent(date) : "");
        const res = await authFetch(url);
        const data = await res.json();
        if (!data.ok) {
          pop.innerHTML = `<div class="ipa-popover-header"><p class="ipa-popover-title">🕒 Record</p><span style="color:var(--ink-soft); cursor:pointer;" id="aaRecordClose2">✕</span></div><p class="ipa-hint">${escHtml(data.error || "Couldn't load this agent's record.")}</p>`;
          document.getElementById("aaRecordClose2").addEventListener("click", aaCloseRecord);
          return;
        }
        aaRenderRecordDetail(data);
      } catch {
        pop.innerHTML = `<p class="ipa-hint">Couldn't load this agent's record. Try again.</p>`;
      }
    }

    function aaRenderRecordDetail(data) {
      const pop = document.getElementById("aaRecordPopover");
      const lastActive = data.timeline.length ? data.timeline[0].to : null;
      pop.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span style="color:var(--ink-soft); font-size:12px; cursor:pointer;" id="aaBackToSearch">← Back to search</span>
          <span style="color:var(--ink-soft); cursor:pointer;" id="aaRecordClose3">✕</span>
        </div>
        <div style="display:flex; align-items:center; gap:10px; margin:10px 0 4px;">
          <div style="width:30px; height:30px; border-radius:8px; background:var(--field-bg); display:flex; align-items:center; justify-content:center; color:#34d399; font-weight:700; font-size:12px; flex-shrink:0;">${escHtml(data.username.charAt(0).toUpperCase())}</div>
          <span style="color:var(--ink); font-weight:600; font-size:14.5px;">${escHtml(data.username)}</span>
        </div>
        <div style="color:var(--ink-soft); font-size:11.5px; margin:8px 0 12px;">Last active: ${escHtml(fmtClock(lastActive))}</div>

        <div style="color:var(--label-blue); font-size:10px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; margin-bottom:8px;">${data.date === new Date().toISOString().slice(0,10) ? "Today's" : escHtml(data.date)} timeline</div>
        <div style="border:1px solid var(--border); border-radius:10px; margin-bottom:16px;">
          <table style="width:100%; border-collapse:collapse; font-size:11.5px; table-layout:fixed;">
            <thead><tr>
              <th style="text-align:left; padding:7px 10px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); border-right:1px solid var(--panel-border); width:17%;">From</th>
              <th style="text-align:left; padding:7px 10px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); border-right:1px solid var(--panel-border); width:17%;">To</th>
              <th style="text-align:center; padding:7px 10px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); border-right:1px solid var(--panel-border); width:15%;">Status</th>
              <th style="text-align:right; padding:7px 10px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); border-right:1px solid var(--panel-border); width:19%;">Duration</th>
              <th style="text-align:right; padding:7px 10px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); width:32%;">Device</th>
            </tr></thead>
            <tbody>
              ${data.timeline.length ? data.timeline.map((seg, i) => {
                const isLast = i === data.timeline.length - 1;
                const isOnline = seg.status === "online";
                const color = isOnline ? "#34d399" : seg.status === "inactive" ? "var(--ink-soft)" : "#5f5e5a";
                const label = isOnline ? "Online" : seg.status === "inactive" ? "Inactive" : "Offline";
                const deviceText = isOnline ? `${escHtml(seg.browser)} · ${escHtml(seg.os)}` : "—";
                const toIsOngoing = seg.to && new Date(seg.to).getTime() > Date.now() - 20000 && i === 0;
                const bb = isLast ? "" : "border-bottom:1px solid var(--panel-border);";
                return `
                  <tr>
                    <td style="padding:8px 10px; color:var(--ink); font-family:var(--font-mono); ${bb} border-right:1px solid var(--panel-border); word-break:break-word;">${escHtml(fmtClock(seg.from))}</td>
                    <td style="padding:8px 10px; color:var(--label-blue); font-family:var(--font-mono); ${bb} border-right:1px solid var(--panel-border); word-break:break-word;">${toIsOngoing ? "now" : escHtml(fmtClock(seg.to))}</td>
                    <td style="padding:8px 10px; color:${color}; font-weight:700; text-align:center; ${bb} border-right:1px solid var(--panel-border);">● ${label}</td>
                    <td style="padding:8px 10px; color:var(--ink-soft); text-align:right; font-family:var(--font-mono); ${bb} border-right:1px solid var(--panel-border); word-break:break-word;">${escHtml(fmtDuration(seg.durationSeconds))}</td>
                    <td style="padding:8px 10px; color:var(--ink-soft); text-align:right; ${bb} word-break:break-word;">${deviceText}</td>
                  </tr>
                `;
              }).join("") : `<tr><td colspan="5" class="ipa-empty" style="padding:16px;">No activity recorded for this day.</td></tr>`}
            </tbody>
          </table>
        </div>

        <div style="color:var(--label-blue); font-size:10px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; margin-bottom:8px;">Last 7 days</div>
        <div style="border:1px solid var(--border); border-radius:10px;">
          <table style="width:100%; border-collapse:collapse; font-size:11.5px;">
            <thead><tr>
              <th style="text-align:left; padding:7px 12px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); border-right:1px solid var(--panel-border);">Date</th>
              <th style="text-align:right; padding:7px 12px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); border-right:1px solid var(--panel-border);">Total online time</th>
              <th style="text-align:right; padding:7px 12px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border);">Last active time</th>
            </tr></thead>
            <tbody>
              ${data.last7.map((d, i) => {
                const isLast = i === data.last7.length - 1;
                const bb = isLast ? "" : "border-bottom:1px solid var(--panel-border);";
                const isSelected = d.date === data.date;
                return `
                  <tr class="aa-day-pick" data-date="${escAttr(d.date)}" style="cursor:pointer; ${isSelected ? "background:rgba(200,145,47,0.08);" : ""}">
                    <td style="padding:8px 12px; color:${isSelected ? "var(--accent-gold)" : "var(--ink)"}; font-weight:${i === 0 ? "700" : "400"}; ${bb} border-right:1px solid var(--panel-border);">${escHtml(d.label)}</td>
                    <td style="padding:8px 12px; color:var(--ink); text-align:right; font-family:var(--font-mono); ${bb} border-right:1px solid var(--panel-border); white-space:nowrap;">${escHtml(fmtDuration(d.totalOnlineSeconds))}</td>
                    <td style="padding:8px 12px; color:var(--ink-soft); text-align:right; font-family:var(--font-mono); ${bb} white-space:nowrap;">${escHtml(fmtClock(d.lastActiveAt))}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;
      document.getElementById("aaRecordClose3").addEventListener("click", aaCloseRecord);
      document.getElementById("aaBackToSearch").addEventListener("click", () => aaRenderRecordSearch(""));
      pop.querySelectorAll(".aa-day-pick").forEach((el) => {
        el.addEventListener("click", () => aaOpenRecordDetail(aaRecordSelectedUsername, el.dataset.date));
      });
    }
  </script>
  <style>
    .aa-dot-online { background:#34d399; animation: aaBreathe 1.8s ease-in-out infinite; }
    .aa-dot-gray { background:#5f5e5a; }
    @keyframes aaBreathe {
      0%, 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0.55); }
      50% { box-shadow: 0 0 0 6px rgba(52,211,153,0); }
    }
    .aa-record-pick:hover { background: var(--sidebar-item-hover); }
    .aa-day-pick:hover { background: var(--field-bg); }
    @media (max-width: 480px) {
      #aaRecordPopover table, #aaRecordPopover thead, #aaRecordPopover tbody, #aaRecordPopover th, #aaRecordPopover td { white-space: normal !important; }
    }
  </style>
</body>
</html>

```

---

## 9. Changes made to existing files (not new files — these are patches, described so you can find/replicate the equivalent spot in another project)

### `functions/_shared/accounts.js`
- Added `canViewActiveAgents(account)` export (see §7 above), placed right after the existing `canManageOthersAdminAccess()`.
- Added `canViewActiveAgents` as a `saveAccount()` parameter and to the persisted account object, same patch/merge semantics as the existing `canManageAdminAccess` field (`undefined` = keep existing value, explicit `true`/`false` overwrites).

### `functions/api/admin/accounts.js`
- Added a guard: `if (body.canViewActiveAgents !== undefined && auth.account?.role !== "owner") return 403` — mirrors the existing `canManageAdminAccess` owner-only guard right above it.
- Passed `canViewActiveAgents` through to the `saveAccount()` call.

### `functions/api/auth/login.js`
- Added `canViewActiveAgents: account.canViewActiveAgents` to the account object returned on login, alongside the existing `canManageAdminAccess`.

### `public/login.html`
- Added `canViewActiveAgents: data.account.canViewActiveAgents` to the object written to `localStorage["agentAuth"]`.

### `public/assets/hub-nav.js`
- Added a sidebar link (before the module links loop) shown when `authInfo?.role === "owner" || authInfo?.canViewActiveAgents`:
```js
if (authInfo?.role === "owner" || authInfo?.canViewActiveAgents) {
  html += `
    <a href="/active-agents.html" class="sidebar-item" style="--item-accent:#34d399;">
      <div class="icon" style="background:#34d39933;">🟢</div>
      <div class="text"><div class="name">Active Agents</div><div class="desc">Who's online right now</div></div>
      <span class="arrow">&rarr;</span>
    </a>
  `;
}
```

### `public/index.html` (Agent Profile edit panel)
- Added a new collapsible section, gated by `authInfo?.role === "owner" && !isSelfProfile` (owner can't toggle this on their own account, same convention as the existing delegation toggle):
```html
<div class="agent-profile-collapsible" data-section="activeAgents">
  <button type="button" class="agent-profile-collapsible-header" data-collapse-toggle>
    <span class="agent-profile-section-label agent-profile-section-label-lg">🟢 Active Agents <span class="agent-profile-section-hint">(real-time presence — Owner only, no rank floor)</span></span>
    <span class="agent-profile-chev">→</span>
  </button>
  <div class="agent-profile-collapsible-body" style="display:none;">
    <label class="agent-profile-module-check">
      <input type="checkbox" id="ap_canViewActiveAgents" ${a.canViewActiveAgents ? "checked" : ""} />
      Can view the Active Agents presence page
    </label>
  </div>
</div>
```
- In the save handler, added:
```js
const activeAgentsToggle = document.getElementById("ap_canViewActiveAgents");
if (activeAgentsToggle) payload.canViewActiveAgents = activeAgentsToggle.checked;
```

### Every page with `authguard.js` (7 files: `index.html`, `threads.html`, `form.html`, `announcements.html`, `promo.html`, `deposit-issue.html`, `deposit-backup.html`)
- Added one line right after the `authguard.js` `<script>` tag:
```html
<script src="/assets/presence-heartbeat.js"></script>
```

---

## 10. If you port this to a project WITHOUT this exact permission system

The Owner/rank hierarchy and `THREADS_KV` binding are specific to this
project. To port just the **presence mechanics** (§4–§6) elsewhere:
- Any KV-like store (or even a SQL table with a composite key) works for `presence:current:<user>` / `presence:log:<user>:<date>` / `presence:daily:<user>:<date>`.
- The heartbeat/offline-timeout logic (§4) and the client detection code (§6) have no dependency on this project's auth system — copy `presence.js`'s status-derivation logic and `presence-heartbeat.js` wholesale, swap only the fetch/auth wrapper.
- The permission model (§7) is optional — simplest port is "anyone logged in can see the list," skip `canViewActiveAgents` entirely if the target project doesn't need per-account gating.
