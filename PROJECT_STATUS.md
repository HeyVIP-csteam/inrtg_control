# PROJECT STATUS — Issue Submission Hub + TG Reply Threads (INR CS Team)

Paste this whole document as the first message in a new conversation, along
with the latest `telegram-issue-hub-updated.zip`. That gives the new chat
the complete current state of the project.

**This version was rewritten from scratch** (not incrementally appended)
to describe the system as it stands *right now* — it supersedes every
earlier version of this document, including the incremental session-by-
session notes that used to make up most of this file's length. If you
need the history of exactly how something got to its current state,
that's in the conversation transcript this doc came from, not here.

## What this is
A web form → Telegram bot + Google Sheets ticketing system for INR-market
CS teams (BetVisa, Betjili, Crickex, Jeetway, Mostplay), plus a full
two-way Telegram reply-tracking dashboard ("TG Reply Threads") with its
own per-agent account system (login, office-based IP allowlists, role
hierarchy), a Promo Code Search dashboard, and a live-editable Telegram
routing admin page ("TG Group / Channel"). Deployed on Cloudflare Pages.

- **GitHub repo:** `HeyVIP-csteam/inrtg_control`
- **Live URL:** `inrtg-control.pages.dev`
- **Deploy method:** GitHub web upload (drag the `public/` and `functions/`
  folders themselves into "Add file → Upload files", not their contents —
  wrong drag depth has repeatedly caused duplicate/misplaced files)
- **Deployment note:** the project has a `wrangler.toml` committed to the
  repo. Once that file exists, Cloudflare treats it as the source of truth
  for **Production** bindings — the dashboard's "+ Add" button for
  Production gets disabled (Preview still works via dashboard). To add/change
  a binding, edit `wrangler.toml` and re-upload; Cloudflare auto-applies it
  to Production on the next deploy.

## Architecture
- **Frontend:** static HTML/CSS/JS in `public/` — no build step
- **Backend:** Cloudflare Pages Functions in `functions/`
- **Google Sheets writes:** service account
  `reward-form-writer@fifth-trainer-500806-e7.iam.gserviceaccount.com`
  (must be shared as Editor on every new Sheet used)
- **File storage:** R2 bucket `inr-issuescreenshot`, bound as
  `SCREENSHOTS_BUCKET`, served back out via `/api/screenshot/<key>`
- **KV storage:** Cloudflare KV namespace `inr-ticket-threads`, bound as
  `THREADS_KV` — backs TG Reply Threads, the account system (accounts/
  offices), and the live TG Group/Channel routing overrides. All in one
  namespace, separated by key prefix (see each module's section below).
- **Secrets set in Cloudflare (Settings → Environment variables, Production):**
  `TELEGRAM_BOT_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
  `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `BRAND_EDIT_PASSWORD` (used ONLY
  for the `accounts-admin.html` one-time bootstrap flow now — see Account
  system below, it is NOT used for brand logo/link editing anymore),
  `TELEGRAM_WEBHOOK_SECRET` (self-chosen random string, verifies Telegram
  webhook calls — see "IMPORTANT: must be alphanumeric only, no
  spaces/symbols/non-ASCII" note under TG Reply Threads below).
  **Not yet set, optional:** `SECURITY_ALERTS_CHAT_ID` and
  `SECURITY_ALERTS_TOPIC_ID` — see "Unrecognized-IP login alerts" under
  Account system below; the feature silently no-ops until these exist.

## Key files
| File | Purpose |
|---|---|
| `public/assets/schemas.js` | Brand list (order: Crickex, Betjili, Mostplay, BetVisa, Jeetway — see "Known issues" below for a mismatch with the server-side order) + every module's form fields |
| `public/assets/app.js` | Renders the submission form dynamically from schemas.js; every input/textarea has `autocomplete="off"` |
| `public/assets/style.css` | All styling — dark starfield / light glass theme, Space Grotesk display font, gold accent, TG Reply Threads chat panel, TG Group/Channel panel, modal close-button styling |
| `public/assets/theme.js` | Theme toggle (dark/light) + live clock |
| `public/index.html` | Hub page — topbar, brand pills, sidebar, Home cards, Account Management sidebar (Create Account / Whitelist IP / TG Group Channel / Reset Password / Agent Profile) |
| `public/form.html` | Generic form page, driven by `?module=<id>` |
| `public/threads.html` | TG Reply Threads dashboard — full chat-panel UI |
| `public/promo.html` | Promo Code Search page |
| `public/login.html` | Site-wide login page — the entry gate for the whole hub |
| `public/assets/authguard.js` | Shared client-side auth guard on every gated page; redirects to login, exposes `window.AgentAuth` |
| `public/accounts-admin.html` | Hidden admin page (not linked from nav) — create/edit/delete Offices and Accounts, has its own separate bootstrap login |
| `functions/api/submit.js` | Submission handler — sends Telegram message, writes Sheets, creates a TG Reply Threads record, requires login. Checks a live KV routing override before falling back to the hardcoded default. Wrapped in a top-level try/catch safety net. |
| `functions/_shared/routing.js` | Per-brand/module Telegram + Sheet config — the hardcoded DEFAULTS (brand key order: betvisa, betjili, crickex, jeetway, mostplay — see "Known issues") |
| `functions/_shared/routes.js` | KV-backed override layer for Telegram routing (chatId/topicId) — lets TG Group/Channel change routing live without a redeploy |
| `functions/api/admin/routes.js` | `GET`/`POST` for the TG Group/Channel admin page — SuperAdmin-only for both read and write |
| `functions/_shared/googleSheets.js` | Google Sheets API helpers |
| `functions/_shared/r2.js` | R2 upload helper (used for ticket attachments — no longer used for brand logos) |
| `functions/_shared/telegram.js` | Small shared `sendTelegramMessage()` helper — new this session, used by the unrecognized-IP login alert feature (see Account system below); `submit.js`/`threads/[id].js` still have their own separate, richer Telegram senders, not refactored onto this |
| `functions/_shared/threads.js` | TG Reply Threads KV storage layer — create/read/update threads, auto-cleanup, deletion log. This session: removed the shared `"index"` KV key (was a write-contention hot spot under concurrent agents) in favor of `THREADS_KV.list()` + per-key metadata — see "Reliability & performance" below. |
| `functions/_shared/accounts.js` | Office/Account KV storage, password hashing, per-request auth (`verifyRequest`), role ranks, and the shared `officeIpCheckPasses()` office/IP rule |
| `functions/api/auth/login.js` | `POST /api/auth/login` — uses the same `officeIpCheckPasses()` as every other endpoint |
| `functions/api/admin/offices.js`, `functions/api/admin/accounts.js` | Admin-only Office/Account CRUD; `accounts.js` also has SuperAdmin-only lock/unlock (see Account system below) |
| `functions/api/account/change-password.js` | Self-service password change |
| `functions/api/telegram-webhook.js` | Receives Telegram messages, matches replies to threads |
| `functions/api/threads.js` | `GET /api/threads` — list active/solved threads, search, login-gated, brand-filtered |
| `functions/api/threads/[id].js` | Single-thread actions — solve, delete, reply, editRoot, recallRoot, editReply, recallReply |
| `functions/api/deletion-log.js` | `GET /api/deletion-log` — deletion history, requires admin-or-above (rank-based check — see "Reliability" section, this had a bug) |
| `functions/api/promo-search.js` | Search against the shared Promo Code Google Sheet (11 team tabs) |
| `functions/api/brand-config.js` | Brand pill Link editor — login-gated now, no logo upload (see "Brand config" below) |
| `functions/api/next-tid.js` | TID generator for Promotion Request |
| `functions/api/screenshot/[[path]].js` | Serves R2 objects — still has NO login gate (pre-existing, flagged, not fixed — see "Known issues") |
| `wrangler.toml` | Includes the `THREADS_KV` binding (real namespace ID) |

## Modules
QA / Account Issue / Risk Issue / Promotion Request / Daily Report / Genie
Issue — 6 modules, same as always. Promotion Request uses a single
unified Telegram message format (`PROMOTION_ROWS_UNIFIED` in
`functions/_shared/routing.js`) across all 8 brand+promotion combinations.

---

## TG Reply Threads

### ✅ Root-caused and fixed this session — Telegram replies weren't
syncing in at all ("must refresh, and even then some never show up")

This was chased for a long time under the assumption it was the same KV/
CPU issue above (it looked identical from the dashboard: things just
"don't show up"). It wasn't — this was a third, completely separate
problem, found by checking Telegram's own side via `getWebhookInfo`:
**the webhook was never actually registered (`"url":""`), with 277
updates queued up and undelivered.** Root cause: `TELEGRAM_WEBHOOK_SECRET`
contained characters Telegram's `secret_token` parameter doesn't allow
(letters/digits/`_`/`-` only) — every `setWebhook` call was failing with
`400 Bad Request: secret token contains unallowed characters`, so the
webhook silently never got (re-)registered. Likely made worse by
Telegram auto-clearing a webhook registration after enough consecutive
delivery failures during the CPU-limit 503 episode above, compounding
into "no webhook at all" rather than just "some updates dropped."

**Fixed:** replaced the secret with a compliant alphanumeric value, updated
`TELEGRAM_WEBHOOK_SECRET` in Cloudflare (Settings → Environment variables
→ Production), redeployed so it actually took effect, then re-ran
`setWebhook` — confirmed via `getWebhookInfo` showing the correct `url`
and `pending_update_count: 0`. **If this ever needs to be regenerated
again: keep it alphanumeric, no spaces/symbols/non-ASCII, and always wait
for the deploy to finish (green in Deployments) before calling
`setWebhook`** — calling it during the deploy window can 403 once
(transient, self-resolves, but confusing to see mid-verification).

### What it does
Every form submission creates a tracked "thread". Telegram replies to that
ticket sync into a chat-style dashboard (`/threads.html`) in near-real-time,
and agents can reply back into Telegram from the dashboard too (two-way).

### Matching rule
Only a **genuine, explicit Telegram reply** (long-press → Reply on a
specific message) gets matched and recorded — supports reply chains
(reply to root, reply to a reply, etc.), as long as every link explicitly
replies to a message already recorded. A plain message with no reply, or
Telegram's auto-attached "reply to the topic root," is intentionally
ignored. An explicit reply to an already-Solved ticket reopens it
(deliberate signal); nothing else can reopen a solved ticket.

### Auto-cleanup
```js
const SOLVED_RETENTION_DAYS = 30;
const STALE_RETENTION_DAYS = 90;
```
Runs opportunistically (piggy-backs on writes), now **sampled at ~5% of
writes** instead of every single write — see "Reliability & performance"
below for why.

### Recall Chat History (deletion log)
A normal collapsible sidebar section (not hidden anymore), admin-or-above
only, shown/hidden by rank comparison both client-side (`threads.html`)
and server-side (`GET /api/deletion-log`, uses the rank-based
`authenticateAdmin()`). **This had a real bug found and fixed this
session** — see "Reliability & performance."

### `/threads.html` dashboard features
Search across all ticket fields; Active/Solved/Recall sidebar sections;
reply-to-a-specific-message with quoted preview; attach screenshot/PDF to
a reply; edit/recall the root ticket message or your own replies; per-
browser unread badges; manual refresh; Twemoji rendering; poll every 6s +
on tab-refocus. Search box and reply input both have `autocomplete="off"`.

---

## Promo Code Search

`/promo.html` — search-only. Matches (contains, case-insensitive) against
the Promo Code column across 11 tabs of one shared Google Sheet
(`1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98`). Tab-name matching goes
through Unicode NFKC normalization so invisible character mismatches
(non-breaking spaces etc.) can't silently break one tab's results.

**Still open:** "Start On" column has no source data yet (always shows
"—"); the "all 11 tabs share the same A–N layout" assumption is unverified
beyond the one reference tab. Unchanged this session.

---

## Account system

### 🆕 Account locking — manual + two auto-lock triggers (built this
session)

A `locked` boolean (plus `lockedAt`, `lockedReason`) now lives on every
account record. A locked account is rejected everywhere — login
(`api/auth/login.js`) AND every already-open browser session on every
subsequent request (`verifyRequest()` in `_shared/accounts.js`, since
this system has no session/token — see the design note at the top of
that file — a browser that was logged in before the lock would otherwise
keep working via its cached credentials). The locked check runs BEFORE
the password hash in both places, which also saves real CPU time on
every request against a known-locked account (see the PBKDF2/CPU-limit
writeup above).

**Three ways an account gets locked:**
1. **Manual** — SuperAdmin only (no delegation to Admin/Senior, unlike
   most account actions), via a 🔒/🔓 button: Home sidebar → Account
   Management → Agent Profile, or the hidden `/accounts-admin.html`.
   `POST /api/admin/accounts { action: "lock"|"unlock", username }`.
2. **Auto — 5 consecutive wrong passwords.** Counter in KV
   (`pwfail:<username>`), reset to 0 the instant a correct password comes
   in — this is about a wrong-guess STREAK, not a lifetime total.
3. **Auto — 5 different unrecognized IPs within a rolling 1 hour.**
   Timestamped list in KV (`ipfail:<username>`), pruned to the last hour
   on every check. Retrying from the SAME bad IP repeatedly doesn't add
   up toward this — only genuinely different IPs do. **This trigger can
   never affect SuperAdmin accounts**, because SuperAdmin bypasses the
   office/IP check entirely (`officeIpCheckPasses()`) — the whole
   IP-related block in login.js is skipped for them, same as it always
   was.

Each auto-lock also fires its own distinct Telegram alert (🔒 Account
Auto-Locked), separate from the per-attempt ⚠️ IP-warning message — both
go to the same `SECURITY_ALERTS_CHAT_ID`/`SECURITY_ALERTS_TOPIC_ID` (see
below).

**⚠️ Known risk, flagged rather than solved (matches the existing
"account with no office = locked out, no in-app recovery" trade-off
documented elsewhere in this file):** the wrong-password auto-lock
trigger (#2 above) is NOT exempted for SuperAdmin. If someone (or a
brute-force attempt) enters 5 wrong passwords against the only existing
SuperAdmin account, THAT account locks too, and since unlocking requires
a SuperAdmin, this can dead-end with no in-app recovery — only a direct
Cloudflare KV edit (`account:<username>` → set `"locked": false`). Worth
deciding deliberately: exempt SuperAdmin from this specific trigger, or
accept the risk given how it's a much narrower window than the old
no-office trap (5 WRONG guesses in a row, not just "no office set"). Not
changed without being asked, per the pattern in the rest of this doc.

### 🆕 Unrecognized-IP login alerts + auto-lock notifications (built this
session, needs one config step before it's live)

When a real account (correct username + password) tries to log in from
an IP that's NOT on its office's approved list, a Telegram alert fires to
a security/alerts chat — user, IP, assigned office, browser/device (best
available — Cloudflare/browsers don't expose real device details, just
what the browser reports about itself), country/city/ISP (from
Cloudflare's own edge geo data on the request — `request.cf`, no extra
API call, no added latency), and both Colombo and Malaysia local time.
**Login is still blocked exactly as before — this only adds visibility.**
Notifies on EVERY such attempt, deliberately NOT de-duplicated — the
business owner wants a count of how many times an account has tried from
unapproved networks, not just a one-time flag. Switching between IPs that
are ALL already whitelisted never triggers this at all. Sent via
`context.waitUntil()` so it never adds latency to the (still instant)
rejection response, and a Telegram hiccup can't break login.

Message format (exact wording/emoji requested directly by the business
owner):
```
⚠️Login Warning (Abnormal IP Address)⚠️

👤 User: <username>
🌐 IP: <ip>
🏢 Assigned office: <office name or "none">
📱 Browser/device: <raw User-Agent string>
🗺️ Country: <spelled out via Intl.DisplayNames, e.g. "LK" -> "Sri Lanka">
🏙️ City: <from request.cf.city>
📡 ISP: <from request.cf.asOrganization>
🕒 Colombo Time: <YYYY-MM-DD HH:mm> (GMT+5:30)
🕗 Malaysia Time: <YYYY-MM-DD HH:mm> (GMT+8:00)

🚫 Login was blocked as usual — this is just a heads-up.
```

**Not fully wired up yet — one thing still needed:** set
`SECURITY_ALERTS_CHAT_ID` (and optionally `SECURITY_ALERTS_TOPIC_ID` if
it should go to a specific topic, not just the group's General) as
Cloudflare environment variables once a Telegram group/topic exists for
this. Until then, `sendTelegramMessage()` in `_shared/telegram.js` sees
no chat ID configured and silently no-ops — nothing breaks, alerts just
don't go anywhere yet.

### ✅ Root-caused and fixed this session — the mysterious, persistent 503s
across the whole site (submit, threads list, open a thread, send a reply,
even login itself)

This took a long back-and-forth to pin down because it looked like a
different bug every time it showed up (KV write contention, KV list()
eventual consistency, GitHub upload mistakes, request quotas — all real
things that were checked and ruled out or fixed along the way, but none
of them were THE cause). The actual root cause:

**Cloudflare Workers Free plan caps CPU time at 10ms per request.**
Password verification uses PBKDF2 (Web Crypto, correct primitive) at
**100,000 iterations** — and this system has no session/token (see below):
**every single request** re-verifies the password from scratch, including
every 6-second sidebar poll. Cloudflare's own docs say heavier
auth-handling workloads "typically use 10-20ms" of CPU on Free — this was
landing right at/over the ceiling on every authenticated call. Confirmed
by testing: an unauthenticated request to `/api/threads` (skips
`verifyPassword` entirely) came back clean and fast every time; anything
that went through the authenticated path failed intermittently. When a
request exceeds the CPU limit, Cloudflare kills the isolate at the
platform level — **not a catchable JS exception**, so none of this
session's try/catch safety nets (see "Reliability & performance") could
ever have caught it. It surfaces to the browser as a bare network-level
503 with no JSON body, exactly what showed up in testing.

**Fixed in `functions/_shared/accounts.js`:** lowered the iteration count
used for any NEWLY hashed password (new account, or a password reset)
from 100,000 to **10,000** — a 10x cut in the per-request CPU cost of
auth, which should comfortably clear the 10ms ceiling given Cloudflare's
own note that KV reads/writes and other I/O waiting do NOT count toward
CPU time (only actual compute does). This is a real security/CPU-budget
trade-off, done deliberately rather than silently — flagging it here for
the business owner: PBKDF2-SHA256 at 10,000 iterations is weaker
brute-force resistance than 100,000, mitigated somewhat by this being an
internal tool already gated by per-office IP allowlisting, not a public
signup surface. If ticket/traffic volume grows and 10ms still gets tight,
the more correct long-term fix is a lightweight signed session
token so most requests skip PBKDF2 entirely instead of tuning the
iteration count further — not built this session, flagging as a future
option.

**Fully backward compatible, no forced password resets:** every account
created before this fix has its password hash computed at the OLD 100,000
count, and would fail to verify against a lower count. So instead of one
global constant, each account record now stores the exact iteration count
IT was hashed with (`iterations` field). Existing accounts (which predate
this field) fall back to 100,000 automatically; new/reset passwords get
10,000. Every account, old or new, keeps working exactly as before —
nobody needs to reset anything because of this change.

### Model
- **Offices** — a name + a list of allowed IPs.
- **Accounts** — username + password (PBKDF2, 100k iterations), one of
  four roles, one `officeId`, and `allowedBrands` (array or `"all"`).
- **No session/token** — the browser saves username+password in
  `localStorage`, re-sends them as `X-Agent-User`/`X-Agent-Pass` headers
  on every request; every protected endpoint independently re-verifies
  (password hash + office/IP rule) on every call. 2-hour client-side idle
  auto-logout (not server-enforced).
- **Whole site requires login** — `/login.html` is the entry gate;
  `authguard.js` redirects any gated page there if not logged in. Server-
  side endpoints independently 401 without valid credentials too, not
  just the page redirect.

### Role hierarchy — Agent / Senior / Admin / SuperAdmin
Each tier's authority is a **literal allow-list**, not a sliding "anything
below my rank" comparison:

| Capability | Agent | Senior | Admin | SuperAdmin |
|---|---|---|---|---|
| Reset own password | ✅ | ✅ | ✅ | ✅ |
| Reset an Agent's password (assisted) | ❌ | ✅ | ✅ | ✅ |
| Reset a Senior's password (assisted) | ❌ | ❌ | ✅ | ✅ |
| Reset an Admin/SuperAdmin's password | ❌ | ❌ | ❌ | ✅ (anyone) |
| Create an Agent account | ❌ | ✅ | ✅ | ✅ |
| Create a Senior account | ❌ | ❌ | ✅ | ✅ |
| Create an Admin/SuperAdmin account | ❌ | ❌ | ❌ | ✅ (any role) |
| Delete an Agent account | ❌ | ❌ | ✅ | ✅ |
| Delete a Senior account | ❌ | ❌ | ✅ | ✅ |
| Delete an Admin/SuperAdmin account | ❌ | ❌ | ❌ | ✅ |
| View Whitelist IP (Offices) | ❌ | ❌ | 👁️ view only | ✅ view + edit |
| View / edit TG Group Channel routing | ❌ | ❌ | ❌ | ✅ only |
| Lock / unlock an account (manual) | ❌ | ❌ | ❌ | ✅ only |
| View Agent Profile table | ❌ | ❌ | ✅ view | ✅ view |
| Edit Agent Profile fullName/PID | ❌ | ❌ | ✅ | ✅ |
| Edit Agent Profile Role | ❌ | ❌ | ❌ | ✅ |

`MANAGE_SCOPE` in `functions/api/admin/accounts.js`:
`{ senior: ["agent"], admin: ["agent", "senior"] }` (superadmin bypasses
the map entirely). SuperAdmin self-promotion bootstrap: while zero
SuperAdmin accounts exist anywhere, any Admin-or-above account can
promote ONLY its own account to `superadmin` (via `accounts-admin.html`'s
Edit Account) — the instant one SuperAdmin exists, this path closes for
good.

### ✅ Office/IP rule — CHANGED this session: SuperAdmin is now the ONLY
role exempt from needing an office

**Old behavior:** an account with no `officeId` had no IP restriction at
all — could log in from anywhere, for any role. Easy to forget and
accidentally leave an account wide open.

**New behavior**, requested directly by the business owner after
confirming they understood the trade-off: `officeIpCheckPasses()` in
`_shared/accounts.js` — **SuperAdmin can still log in from anywhere,
office or not** (deliberate, so there's always at least one way to reach
admin tools remotely). **Every other role (Agent/Senior/Admin) with no
office now fails to log in outright.** This is shared by both
`verifyRequest()` (every protected endpoint) and `auth/login.js` (the
login form itself) via one function, so the two can't drift out of sync.

**Accepted trade-off, stated explicitly to the business owner:** if the
very first Admin-tier account (before any SuperAdmin exists) has no
office, that account is now locked out of everything, including its own
SuperAdmin self-promotion path — no in-app recovery, only a direct
Cloudflare KV edit. **Always assign an office to every non-SuperAdmin
account — login will fail without one, not just be unrestricted.**

### Bootstrap (first-time setup after a fresh deploy)
`accounts-admin.html` accepts the existing `BRAND_EDIT_PASSWORD` secret
as a one-time key (while zero admin-or-above accounts exist) to create
the first admin account. Steps: deploy → go to `/accounts-admin.html`
(bookmark it, not linked in nav) → "first-time setup" → enter
`BRAND_EDIT_PASSWORD` → create an Office with real IPs → create the first
admin account assigned to that office → promote it to SuperAdmin via Edit
Account (while zero SuperAdmins exist) → create real accounts for every
CS agent who uses ANY part of the hub (submitting tickets, promo search,
or TG Reply Threads — all of it requires login now).

### Account Management (Home sidebar)
Expandable sidebar entry with role-gated sub-items:
- **Everyone:** Reset Password (self-service, requires current password).
- **Senior+:** Create Account.
- **Admin (view) / SuperAdmin (edit):** Whitelist IP.
- **SuperAdmin only:** TG Group / Channel (see its own section below).
- **Admin+ (view), SuperAdmin (edit role):** Agent Profile.

**Agent Profile table — this session added:**
- **"Office" column** (name only, no IP list shown) — flags a
  non-SuperAdmin account with no office bound with a red
  "⚠️ No office — can't log in" warning, since that's now a real broken
  state instead of just "unrestricted."
- **Role filter dropdown** next to the modal title (All / Agent / Senior
  / Admin / SuperAdmin) — filters the table client-side, no extra fetch.

### Modal UX — this session: Cancel buttons removed everywhere, replaced
with an X close button
Both modals on the site (`editModalBackdrop` — brand link editor, and
`acctModalBackdrop` — the whole Account Management modal, reused for
Create Account / Whitelist IP / Reset Password / Agent Profile / TG
Group Channel) now close via a small **✕ button in the top-right corner**
instead of a "Cancel" button in the footer. Clicking outside the modal
(on the backdrop) still closes it too — unchanged. When a mode has no
Save button either (e.g. Agent Profile, TG Group/Channel, or a non-
SuperAdmin viewing read-only Whitelist IP), the entire footer actions row
is hidden rather than left as empty dead space.

---

## TG Group / Channel — live-editable Telegram routing (built this session)

### What it does
Lets a SuperAdmin change which Telegram chat/topic each brand+module
routes to, live from the browser — no code edit + redeploy needed. Before
this, every routing change required editing `functions/_shared/routing.js`
and redeploying.

### Architecture
- `functions/_shared/routes.js` — KV layer, keyed `route:<brandId>:<moduleId>`
  in `THREADS_KV`. `getRouteOverride()` — single read. `getAllRouteOverrides()`
  — batch reads all 30 brand×module combos for the admin grid.
- `functions/api/submit.js` checks `getRouteOverride()` FIRST, falls back
  to the hardcoded `brand.telegram[moduleId] || brand.telegram.default`
  from `routing.js` if nothing's stored — an empty KV changes nothing
  that already worked.
- `functions/api/admin/routes.js` — `GET` (merged grid: defaults +
  overrides, with `isOverride` per cell) and `POST { action:"save"|"reset",
  brandId, moduleId, chatId?, topicId? }`. **SuperAdmin-only for BOTH**
  read and write — stricter than Whitelist IP (which lets Admin view
  read-only), since routing controls where every ticket is actually
  delivered.

### UI
Home sidebar → Account Management → "TG Group / Channel" (SuperAdmin
only). Left column: the 5 brands. Right: the selected brand's 6 modules,
each row showing Chat ID + Topic ID + a "default"/"custom" tag, with
**Save and Reset buttons on the same line as the fields** (changed this
session from a separate button row below — Reset only appears on rows
that have been overridden). Panel height is `78vh` (was a fixed 440px)
so all 6 modules fit on one screen without scrolling on most displays;
modal width widened to 940px. Save/Reset are text buttons now (gold solid
Save, outlined Reset) instead of the original ✅/↩️ emoji icons. A divider
+ extra top spacing separates the module list from the explanatory
footnote at the bottom.

### ✅ Fixed this session — brand order mismatch
The brand list in this modal followed `functions/_shared/routing.js`'s
`BRANDS` object key order, which didn't match `public/assets/schemas.js`'s
reordered array used everywhere else in the UI (form dropdowns, Home page
brand pills). Reordered the `BRANDS` object literal in `routing.js` to
match: **crickex, betjili, mostplay, betvisa, jeetway**. Pure key-order
change — no routing values (chatId/topicId/sheetId) touched, verified with
`node --check`. These are still two entirely separate `BRANDS`
definitions (one client-side in `schemas.js`, one server-side in
`routing.js`) that just now happen to agree on order — not merged into
one source of truth, so if either list gets reordered again in the
future, remember the other one needs a matching edit by hand.

---

## Brand pill Link editor (`/api/brand-config`) — logo removed, password
removed this session

- **Logo image upload removed entirely.** It never actually worked in
  production; rather than debug it, it was deleted. The "Edit brand"
  modal now has exactly ONE field: Link (opens when the pill is
  clicked). No logo control at all for now — brand pills show colored-
  initials avatars until logo handling is redesigned. Business owner's
  words: "Logo 之后再想办法" (revisit later) — **no replacement plan has
  been chosen yet.**
- **`BRAND_EDIT_PASSWORD` gate removed from this endpoint.** Replaced
  with the same `verifyRequest()` login check every other endpoint uses
  — any logged-in agent (any role) can edit a brand's link now, same
  authorization level as submitting a ticket. This was a deliberate fix
  to an inconsistency: simply deleting the password with nothing in its
  place would have left this as the ONLY unauthenticated write endpoint
  in the whole hub. `BRAND_EDIT_PASSWORD` the secret itself is UNCHANGED
  and still required for `accounts-admin.html`'s bootstrap flow — those
  are unrelated uses of the same secret.
- Request shape changed from `multipart/form-data` to a plain JSON body
  `{ brand, link }`, sent via `window.AgentAuth.authFetch()`.
- The `{ [brandId]: { logoUrl, link } }` data shape in R2's
  `brand-config.json` is untouched — `logoUrl` just has nothing writing
  it anymore.

---

## Browser autocomplete — swept and disabled everywhere this session

Every text `<input>`/`<textarea>`/password field across the ENTIRE site
now has an explicit `autocomplete` attribute — either `"off"`, or (for
actual credential fields like login/password) the semantically correct
value (`"username"`, `"current-password"`, `"new-password"`). This fixes
the browser showing a dropdown of previously-typed values on focus — the
original complaint was the TG Reply Threads reply box visibly showing old
reply text as suggestions, but the same gap existed on every dynamically-
rendered form field (`app.js`, used by all 6 submission modules),
`form.html`'s agent-name field, the sidebar search box, and every text
field inside the Account Management / Whitelist IP / TG Group Channel /
Agent Profile / accounts-admin.html modals. Confirmed via repo-wide grep
that nothing was missed.

---

## Reliability & performance — full review this session

### ✅ Every API endpoint now has a top-level safety net
All 13 endpoint files (`submit.js`, `threads.js`, `threads/[id].js`,
`admin/routes.js`, `admin/accounts.js`, `admin/offices.js`,
`deletion-log.js`, `auth/login.js`, `account/change-password.js`,
`brand-config.js`, `promo-search.js`, `next-tid.js`,
`screenshot/[[path]].js`) now wrap their real logic in an inner handler
function called from a top-level `try/catch` in the exported
`onRequestGet`/`onRequestPost`. Any unanticipated exception now returns a
clean `{ ok:false, error }` JSON response instead of Cloudflare's raw
platform error page. Found in the process: `threads/[id].js`'s
`editRoot`/`recallRoot`/`editReply`/`recallReply` actions called the
Telegram API directly with no try/catch of their own (unlike the `reply`
action) — a network hiccup there would have thrown uncaught; now covered
by the new outer safety net.

### ✅ Fixed — the literal-"admin"-string bug existed in THREE places,
not the one a previous note claimed was "fixed"
- `threads.html`'s client-side visibility check for Recall Chat History
  — fixed in an earlier session, confirmed still correct.
- `functions/api/deletion-log.js`'s actual SERVER-SIDE gate — was still
  `account.role !== "admin"`, a literal string compare that rejects every
  SuperAdmin (whose role string is literally `"superadmin"`). Since
  `threads.html` silently swallows a 401 on this endpoint, the visible
  symptom was "Recall Chat History section renders but is permanently
  empty for SuperAdmin" — found and fixed this session, now uses the
  rank-based `authenticateAdmin()`.
- `public/accounts-admin.html`'s own login form had the identical bug —
  a real SuperAdmin account got rejected client-side with "This account
  isn't an admin." Found and fixed the same way (local rank comparison).
- Repo-wide grep swept afterward for the same pattern — nothing else
  found. A few `role === "superadmin"` comparisons in
  `admin/accounts.js` were individually checked and are legitimate
  (comparing against one specific target role for the self-promotion
  bootstrap, not a permission gate) — not the same bug class.

### ✅ Architecturally fixed this session — "replies come back slowly
under load" / KV write-contention ceiling

**Root cause (unchanged from the earlier diagnosis):** Workers KV allows
at most 1 write/sec to the SAME key. Every reply/submission/solve-toggle/
edit used to also rewrite one shared `"index"` KV key (the sidebar's data
source) — under real traffic, two of those landing in the same second was
normal, not rare, and since `telegram-webhook.js` deliberately swallows
errors, a rate-limited index write was silently dropped (the ticket/
message itself was never lost, just the sidebar entry going stale).

**What changed:** removed the shared `"index"` key entirely, in favor of
Cloudflare KV's built-in `list()` + per-key `metadata`. Every thread
already writes its own `thread:<id>` key on every update — now a
lightweight summary (title, submitter, brand, timestamps, solved state,
reply count, a capped extra-searchable-text blob) rides along as that
same key's KV *metadata* in the same `put()` call, instead of a second
write to a shared key. The sidebar (`listThreads()` in
`functions/_shared/threads.js`) now calls
`THREADS_KV.list({ prefix: "thread:" })`, which returns every thread's
metadata in one cheap call with no full-record fetch and no shared key.
Two agents touching two *different* tickets now write to two entirely
different keys and never contend with each other — the only remaining
contention surface is two edits to the exact same ticket in the same
second, which is a much smaller, much rarer case than before.

**Trade-off, stated plainly:** `list()` is eventually consistent across
Cloudflare's edge (fast in practice, but not the same instant/global
guarantee as reading one specific key), so a brand-new ticket may take a
little longer to show up in a colleague's sidebar than before. Given the
old failure mode was a write getting silently dropped/delayed under
contention, this is a straightforward trade in the sidebar's favor, not a
new class of problem.

**Migration, zero manual steps needed:** every `thread:<id>` key written
*before* this change has no metadata yet. `listThreads()` handles that
transparently — for any key missing metadata, it fetches that one thread's
full record once, builds the summary, and re-saves it with metadata
attached, so it only ever pays that cost once per pre-existing ticket, not
on every future load. The old `"index"` key itself is simply no longer
read or written — it's dead, harmless leftover data in KV, not cleaned up
automatically (fine to ignore, or delete by hand from the Cloudflare KV
dashboard if you want it gone).

**This closes the item that was previously flagged as "architectural
ceiling remains, not built."** Durable Objects / index-sharding are no
longer needed for this specific problem — they'd only come back into the
conversation for a different reason (e.g. wanting real-time push instead
of the current 6-second poll).

### ⚠️ Known gaps, NOT changed (flagging for awareness, not bugs)
- **`GET /api/screenshot/<key>`** — still no login gate at all. Security
  is purely "the key is an unguessable timestamp + random string," not
  real access control. Pre-existing, unchanged.
- **`GET /api/brand-config`** — still public/unauthenticated (reads only
  logo/link display data for the brand pills). Reasonable given the low
  sensitivity, but not covered by the "whole hub requires login" model.

---

## Still pending / needs input before it can be finished

1. **Promo Code Search** — "Start On" column has no source data (always
   "—"); "all 11 tabs share the same A–N layout" is unverified beyond one
   reference tab.
2. **Brand logo** — deliberately removed, no replacement plan chosen.
3. **`GET /api/screenshot/<key>` and `GET /api/brand-config`** — no login
   gate, pre-existing, flagged for awareness only.
4. **Live-tested end-to-end this session, after a long real-production
   debugging round** — submit, Telegram reply sync (both directions),
   solve/reopen-on-reply, sidebar updates, and the account/login path all
   confirmed working against the real Cloudflare deployment (not just
   syntax-checked). See the three root-caused-and-fixed writeups above
   (KV index contention, PBKDF2 CPU limit, webhook secret format) for
   what was actually broken and how each was found — this is no longer a
   "reasoned through, not yet verified" item.

## Recurring non-code gotcha (still true)
GitHub web upload can cause duplicate files or misplaced content if the
wrong folder depth is dragged in. Always sanity-check file contents after
upload if something looks broken post-deploy, before assuming the code
itself is wrong.
