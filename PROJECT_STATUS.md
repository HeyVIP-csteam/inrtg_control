# PROJECT STATUS — Issue Submission Hub + TG Reply Threads (INR CS Team)

Paste this whole document as the first message in a new conversation, along
with the latest `telegram-issue-hub-updated.zip`. That gives the new chat
the complete current state of the project — this supersedes the original
handoff doc from the start of this project.

## What this is
A web form → Telegram bot + Google Sheets ticketing system for INR-market
CS teams (BetVisa, Betjili, Crickex, Jeetway, Mostplay), **plus a full
two-way Telegram reply-tracking dashboard ("TG Reply Threads") with its
own per-agent account system (login, office-based IP allowlists, brand
permissions), and a Promo Code Search dashboard**, all built on top of
it. Deployed on Cloudflare Pages.

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
- **TG Reply Threads storage:** Cloudflare KV namespace `inr-ticket-threads`,
  bound as `THREADS_KV` (in both `wrangler.toml` and the dashboard —
  confirmed working)
- **Secrets set in Cloudflare (Settings → Environment variables, Production):**
  `TELEGRAM_BOT_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
  `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `BRAND_EDIT_PASSWORD`,
  `TELEGRAM_WEBHOOK_SECRET` (self-chosen random string, used to verify
  Telegram webhook calls)

## Key files
| File | Purpose |
|---|---|
| `public/assets/schemas.js` | Brand list + every module's form fields |
| `public/assets/app.js` | Renders the submission form dynamically from schemas.js |
| `public/assets/style.css` | All styling — dark starfield / light glass theme, Space Grotesk display font, gold accent, TG Reply Threads chat panel styling |
| `public/assets/theme.js` | Theme toggle (dark/light) + live clock |
| `public/index.html` | Hub page — topbar, brand pills, sidebar, Home cards (TG Reply Threads + Promo Code Search with unread badge/unsolved count) |
| `public/form.html` | Generic form page, driven by `?module=<id>` |
| `public/threads.html` | **TG Reply Threads dashboard** — full chat-panel UI (see below) |
| `public/promo.html` | **Promo Code Search page — fully wired this session** (see below) |
| `public/login.html` | **New this session** — the site-wide login page; the entry gate for the whole hub |
| `public/assets/authguard.js` | **New this session** — shared client-side auth guard, included on every gated page; redirects to login, exposes `window.AgentAuth` (authFetch/renderWhoami/logout) |
| `public/accounts-admin.html` | Hidden admin page, not linked from nav; create/edit/delete Offices and Accounts |
| `functions/api/submit.js` | Submission handler — sends Telegram message, writes Sheets, creates a TG Reply Threads record — **now also requires login** |
| `functions/_shared/routing.js` | Per-brand/module Telegram + Sheet config; `MODULE_META` now includes `accent` color too |
| `functions/_shared/googleSheets.js` | Google Sheets API helpers — now also `batchGetValues` (read-only, multi-range) for Promo Code Search |
| `functions/_shared/r2.js` | R2 upload helper |
| `functions/_shared/threads.js` | **TG Reply Threads KV storage layer** — create/read/update threads, index, auto-cleanup, deletion log |
| `functions/_shared/accounts.js` | **New this session** — Office/Account KV storage, password hashing, per-request auth verification, brand-permission check |
| `functions/api/auth/login.js` | **New this session** — `POST /api/auth/login` |
| `functions/api/admin/offices.js`, `functions/api/admin/accounts.js` | Admin-only Office/Account CRUD — used by `accounts-admin.html` AND the new Home-page Account Management modals |
| `functions/api/account/change-password.js` | **New this session** — self-service password change, any logged-in account, own password only |
| `functions/api/telegram-webhook.js` | **Receives Telegram messages**, matches replies to threads |
| `functions/api/threads.js` | `GET /api/threads` — list active/solved threads, search — **now login-gated and brand-filtered** |
| `functions/api/threads/[id].js` | `GET`/`POST` single thread — solve, delete, reply, editRoot, recallRoot, editReply, recallReply — **now login-gated, brand-filtered, and delete/recall no longer need a separate password** |
| `functions/api/deletion-log.js` | `GET /api/deletion-log` — deletion history — **now requires an admin-role login** |
| `functions/api/promo-search.js` | Real search against the shared Promo Code Google Sheet (11 team tabs), matches (contains) the Promo Code column, groups results by tab — **now also requires login** |
| `functions/api/brand-config.js` | Brand link editor — login-gated now, logo upload removed this session (see below) |
| `functions/api/next-tid.js` | TID generator for Promotion Request — **now also requires login** |
| `functions/api/screenshot/[[path]].js` | Serves R2 objects (unchanged) |
| `wrangler.toml` | Now includes the `THREADS_KV` binding (real namespace ID, not a placeholder) |

## Modules — all 6 unchanged functionally, descriptions updated
QA / Account Issue / Risk Issue / Promotion Request / Daily Report / Genie
Issue — same as before. Sidebar descriptions were shortened this session
(e.g. "OTP & Domain issue etc.", "Account verify & otp etc.").

### Promotion Request — Telegram message format unified across all brands
Previously 3 different row layouts depending on brand+promotion (one for
Crickex/Betjili/Mostplay Birthday Bonus, one for BetVisa/Jeetway with an
extra Tier Level row, one for the Review-type bonuses). Business owner
wanted ONE format everywhere — `PROMOTION_ROWS_UNIFIED` in
`functions/_shared/routing.js` now backs all 8 brand+promotion
combinations (verified by code that they're literally the same array
reference, not just visually identical copies). Exact casing/punctuation
was specified and must NOT be "cleaned up":

```
Particular information
TID:
Date:
Username:
Amount to be Added:
Remarks:
NID NO:
Processed BY:
Platform:
To be added:
```

Tier Level (BetVisa/Jeetway) and Number of Deposits (Betjili/Mostplay)
are still collected on the web form and still auto-fill Amount exactly
as before — they just no longer get their own row in the Telegram
message. Google Sheet writes (`PROMOTION_SHEET_CONFIG`) are untouched.
**Not yet live-tested** — verified by rendering a sample message in Node
and diffing it character-for-character against the spec above; a real
BetVisa Birthday Bonus submission hasn't been sent through Telegram yet
to confirm.

---

## TG Reply Threads — fully built this session

### What it does
Every form submission creates a tracked "thread". Telegram replies to that
ticket sync into a chat-style dashboard (`/threads.html`) in near-real-time,
and agents can reply back into Telegram from the dashboard too (two-way).

### Matching rule (current, final state — went through several iterations)
- Only a **genuine, explicit Telegram reply** (long-press → Reply on a
  specific message) gets matched and recorded.
- Matching supports **chains**: reply to the root ticket message, reply to
  a reply, reply to that reply, etc. — as long as every link explicitly
  replies to a message we've already recorded (works across different
  people/teams, e.g. someone @-tags another team who then replies).
- A plain message typed with no reply, or Telegram's auto-attached
  "reply to the topic root" (which happens automatically for any message
  typed in a forum topic, not a real user action) — **intentionally
  ignored**, not guessed at.
- If a ticket is already marked **Solved**, an explicit reply **reopens
  it** (deliberate signal); nothing else can reopen a solved ticket.
- We deliberately chose strict/no-guessing after testing looser
  auto-matching and finding it risked misattributing messages when
  multiple tickets were open in the same Telegram topic at once.

### Known prerequisite gotcha (already resolved once, but good to remember)
Telegram bots default to **Privacy Mode ON**, which only forwards
messages that are commands/@mentions/replies to the webhook. We turned it
off via @BotFather → `/mybots` → Bot Settings → Group Privacy → Turn off —
**but existing group memberships don't pick up the change automatically**;
the bot had to be removed and re-added to each group for it to take effect.
(Alternative that also works without this dance: promote the bot to group
admin — admins always see everything regardless of Privacy Mode.)

### Auto-cleanup (keeps free-tier KV usage sustainable)
In `functions/_shared/threads.js`:
```js
const SOLVED_RETENTION_DAYS = 30;  // solved tickets auto-delete after this many days
const STALE_RETENTION_DAYS = 90;   // untouched tickets (solved or not) auto-delete after this many days
```
Cleanup runs opportunistically (piggy-backs on normal reads/writes), not on
a schedule, since Cloudflare Pages Functions don't support Cron Triggers.
Deleting an "over-limit" sidebar entry (>500) or an expired thread also
cleans up its `msgid:` KV pointers, so nothing leaks silently.

### `/threads.html` dashboard features (all built + screenshot-tested)
- Sidebar: search (now matches **all ticket fields** — TID, UID, etc., not
  just username/agent — via a precomputed `searchText` blob in the index),
  Active Threads / Solved-Done collapsible sections, unread badges (see
  below).
- Thread detail panel: fixed header (title, submitter, **Not Solved (red) /
  Solved (green)** toggle, edit/recall-root, delete, refresh icons) +
  independently-scrolling conversation + **genuinely pinned reply bar at
  the bottom** (fixed a real layout bug where the whole page could scroll
  because the height math didn't account for the "Back to Home" row —
  now `body.threads-page` is a flex column so nothing overflows the
  viewport, at any zoom level).
- Messages: self on the right (gold), others on the left, colored avatar
  initials, delivered ✓ checkmark, attachment tag, edited-at marker.
- **Reply-to-a-specific-message**: hover a message → small blue ↳ icon
  appears → click sets it as the reply target → a "↳ Replying to X: ..."
  banner appears above the input (cancel-able) → next send targets that
  exact message. Replies that targeted a specific message also show a
  small quoted preview inside the bubble (Telegram-style).
- Attach a screenshot/PDF to a reply (📎 icon embedded in the input field,
  no separate boxed button); shows a removable preview chip before sending.
- Edit/recall the **root ticket message** or any of your own sent replies
  directly from the dashboard (calls Telegram's `editMessageText` /
  `deleteMessage`); edits show a "✏️ Edited — current message text" block
  so the summary card (which is a point-in-time snapshot) doesn't look
  stale.
- **Unread badges**: per-browser (localStorage `lastseen:<threadId>`), not
  shared team-wide — matches how Telegram's own unread counts work. Shown
  both in the `/threads.html` sidebar and as a red badge on the Home
  page's "TG Reply Threads" card, plus a **red, breathing-light-animated**
  "N unsolved" line under that same card (turns to "All caught up ✓" and
  stops animating when there's nothing outstanding).
- Manual 🔄 refresh icon (in the thread's action-icon row, not a
  standalone button) — spins red for a **minimum of 2 seconds** so it's
  actually visible even if the fetch itself is instant.
- Twemoji integration (`cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2`) so
  emoji render crisp/colorful and consistent across browsers, like
  Telegram's own.
- **Hidden deletion history log** — a nearly-invisible dim dot at the very
  bottom of the sidebar (not labeled, easy to miss on purpose — the
  business owner does not want CS agents to know it exists). Clicking it
  reveals a small panel listing every delete-thread / recall-root /
  recall-reply action (what, when, which ticket, the actual content that
  was removed). **The "who did it" field (`by`) is wired up server-side
  but always null for now** — an identity/auth field will be added to the
  delete confirmation UI later once the business owner decides how to
  identify agents (this was deliberately deferred, see Pending below).
  No password gate on `/api/deletion-log` yet either (also deferred).
- No caching anywhere in the polling path — `Cache-Control: no-store` on
  both thread API responses, `cache: "no-store"` on every fetch, so
  refreshes always hit KV fresh (fixed an earlier "looks delayed"
  complaint that turned out to be partly this and partly the matching
  rule being stricter than expected).
- Poll every 6s + an immediate refresh on `visibilitychange` (catches up
  fast when the agent switches back to this tab after it was
  backgrounded/throttled by the browser).

### Explicitly declined / discussed and NOT done
- Converting the 6 submission forms (`form.html`) from full-page
  navigation into an in-page SPA-style switch (like `/threads.html`'s own
  internal panel switching) — discussed the tradeoffs, business owner
  decided the current page-navigation approach is fine, **do not build
  this** unless asked again.
- Team-wide (shared) "read" state instead of per-browser — considered,
  not requested; current design is intentionally per-agent.

---

## Promo Code Search — built this session (needs live verification)

### What it does
`/promo.html` — search-only, no ticket/form submission involved. Agent
types one or more promo codes (comma-separated), it exact-matches against
the **Promo Code** column across all 11 team tabs of one shared Google
Sheet, and shows results grouped by tab (matches the reference screenshot
the business owner supplied — collapsible group card per tab, "N found"
pill, full-width table).

### Data source
- Sheet ID: `1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98`
- Tabs searched (all assumed same A–N layout — see caveat above):
  Welcome Call Team, Retention team (Outsource), Retention Team (BDT),
  Retention Team (PKR), Retention Team (INR), Retention Team (PHP),
  Retention Team FT & TIRESIAS (BDT), Retention Team (VND),
  Retention Team (NPR), LIVE Streaming, FB Ads (BDT)
- **Prerequisite, not yet confirmed done:** this sheet must be shared
  (Viewer is enough — it's read-only) with the same service account used
  for form-submission writes:
  `reward-form-writer@fifth-trainer-500806-e7.iam.gserviceaccount.com`
- Column mapping (`functions/api/promo-search.js`):
  A Brand, B Bonus Code, C Promo Code (the search key), D Deposit Range,
  E Bonus % (not shown in UI), F Per Spin Value (not shown in UI),
  G Max Bonus, H Wager, I Max Withdraw, J Expired Day, K Products,
  L Excluded Products/GAMES, M Under Group/Affiliate/VIP Level,
  N Expired On. "Start On" is a UI-only placeholder — always "—" (no
  source column yet).

### How the search works
- Matching is **contains/partial** (case-insensitive) on the Promo Code
  column — changed from the original exact-match spec after the business
  owner tried it live and wanted "1500" to also surface "1500PKR", etc.
  Any one of the comma-separated search terms being a substring of the
  code counts as a hit.
- One `spreadsheets.values.batchGet` call reads all 11 tab ranges
  (`A2:N1000` each) at once — new `batchGetValues()` helper added to
  `functions/_shared/googleSheets.js`, read-only, reused nowhere else yet.
- Only tabs with at least one match are shown, grouped, each as its own
  collapsible card.
- The page also does one throwaway `GET /api/promo-search` (no `codes`
  param) on load just to populate the "Open Sheet" button's link from the
  server response, so the raw sheet ID doesn't need to live in
  client-side JS.

### Not yet done / explicitly deferred
- No caching of search results — every search hits the Sheets API fresh
  (fine at current volume; revisit if this gets heavy traffic). Tab
  *names* (metadata only, not the code data) are cached 5 minutes per
  Worker isolate — see next section.
- No loading skeleton beyond a plain "Searching…" state.
- Styling was built to match the reference screenshot as closely as
  possible from a description — the business owner said they'd send
  more screenshots/feedback to refine it further, so treat the current
  visual polish as a first pass, not final.

### Fixed this session: one bad tab name broke the whole search
First deploy failed on every search with `Sheets batchGet failed (400):
Unable to parse range: 'Retention Team (NPR)'!A2:N1000` — Google's
`values.batchGet` is all-or-nothing, so a single tab name in the
`PROMO_CODE_SHEET.tabs` list not matching the sheet's real tab exactly
(rename, typo, not created yet, etc.) 400'd every search across all 11
tabs, not just that one.

Fix: `functions/api/promo-search.js` now first calls a new
`getSheetTabTitles()` (in `googleSheets.js`, metadata-only, no cell data)
to get the sheet's real tab names, cached 5 minutes per isolate, and only
ever queries `batchGetValues` for configured tabs that actually exist
(case-insensitive match). Any configured tab that doesn't match comes
back in the response as `missingTabs`, shown as a small non-blocking
amber warning above the results — so a rename/typo degrades gracefully
(that one tab's results are just missing) instead of breaking the whole
feature.

**Still needs a real check:** whether "Retention Team (NPR)" (and
possibly others) is actually a typo in `PROMO_CODE_SHEET.tabs`, or a tab
that doesn't exist on the sheet yet. If the dashboard shows it under
`missingTabs` after a search, compare the exact tab name in
`functions/api/promo-search.js` against the sheet.

**Update — this turned out to be an invisible-character mismatch, not a
typo.** Business owner confirmed the tab is visibly named "Retention
Team (NPR)" in the Sheet UI, same as configured — the exact-string
comparison was still failing, most likely because of a non-breaking
space or fullwidth punctuation that looks identical but isn't the same
character. Fixed: tab-name matching now goes through `normalizeTabName()`
(Unicode NFKC + collapse all whitespace variants + lowercase) before
comparing, and once a configured tab matches, the query uses the sheet's
**real** title string (not the configured one) so this class of bug
can't resurface at the actual API-call step either. The `missingTabs`
warning now also includes `actualSheetTabs` (the sheet's real tab list)
so any future mismatch is visible side-by-side instead of requiring a
guess.

---

## Account system — built this session (needs live verification)

### What it does
TG Reply Threads now requires login, with real per-agent accounts:
- **Offices** — a name + a small list of allowed IPs (business owner
  confirmed CS agents work from fixed office networks, ~2-3 IPs per
  office). Deleting or misconfiguring an office locks out every account
  assigned to it (fails closed, not open — tested).
- **Accounts** — username + password (PBKDF2-hashed, 100k iterations),
  `role` (`agent` | `admin`), one `officeId`, and `allowedBrands` (an
  array of brand names, or the string `"all"`).
- **No session/token** — deliberate "medium tier" tradeoff discussed with
  the business owner. The browser saves the username+password in
  `localStorage` after login and re-sends them as `X-Agent-User` /
  `X-Agent-Pass` headers on every request; every protected endpoint
  independently re-verifies the password hash AND the request's IP
  against the account's office, every single call. A whoami pill next to
  "Back to Home" in `/threads.html` shows who's logged in + a Log Out
  link that clears the saved credentials.
- **2-hour idle auto-logout (client-side only).** Tracked in
  `localStorage` (`agentLastActivity`), updated on real user activity
  (click/keydown/mousemove/touch, or switching back to the tab) — NOT on
  the background 6s poll, so an unattended-but-open tab doesn't look
  "active" forever. A once-a-minute check, plus a check on page load and
  on tab-visibility-return, force back to the login screen once 2 hours
  pass with no real interaction. **Caveat, said plainly:** since there's
  no server-side session, this is enforced by the browser, not the
  server — the server has no concept of "this login expired 2 hours ago"
  and will still accept those exact credentials if sent directly (e.g.
  someone manually replaying a request from devtools). Good enough for
  normal use (locked screens, agents leaving for lunch); a real
  server-enforced expiry would need the heavier session/token tier that
  was discussed and deliberately not chosen.
- **IMPORTANT caveat, not obvious from the UI:** an account with **no
  office assigned** (`officeId: null`) has **no IP restriction at all**
  — it can log in from anywhere. Intentional (e.g. a remote admin), but
  easy to forget and accidentally leave an account wide open. Always
  assign an office unless that's specifically wanted.

### What's gated now
| Surface | Before this session | Now |
|---|---|---|
| **Every page** (`index.html` / `form.html` / `promo.html` / `threads.html`) | Only `/threads.html` needed login | **Whole site requires login** — a dedicated `/login.html` is the entry gate; any protected page redirects there if not logged in (see "Site-wide login gate" below) |
| `GET /api/threads` (sidebar list) | Open | Login required; results filtered server-side to the account's `allowedBrands` |
| `GET /api/threads/<id>` + all POST actions | Open (delete/recallRoot/recallReply needed `BRAND_EDIT_PASSWORD`) | Login required; a thread outside the account's brands 404s (verified an agent can't fetch it directly by ID either) |
| Delete / recall actions | Needed `BRAND_EDIT_PASSWORD` prompt | **No extra password** — being logged in as an account that can see the brand is the authorization. `by` on every deletion-log entry is auto-filled from the logged-in username |
| `GET /api/deletion-log` | URL-obscurity only, no auth | **Requires `role: admin`** |
| `POST /api/submit`, `POST /api/next-tid`, `GET /api/promo-search` | Open | **Now also require login server-side** — not just the page redirect; hitting these directly (curl, etc.) without valid credentials 401s |
| `accounts-admin.html` | N/A (new this session) | Its own separate admin+bootstrap login — deliberately NOT wired to the general site-wide gate, so the very first admin account can still be created from zero |

### New files
- `functions/_shared/accounts.js` — Office/Account KV storage, PBKDF2
  password hashing, `verifyRequest()` (the per-request auth check used
  everywhere), `canSeeBrand()`, `authenticateAdmin()` (real admin login
  OR the one-time bootstrap password, see below).
- `functions/api/auth/login.js` — `POST /api/auth/login`.
- `functions/api/admin/offices.js`, `functions/api/admin/accounts.js` —
  admin-only CRUD, used by the new admin page below.
- `public/accounts-admin.html` — **hidden admin page, not linked from
  anywhere in the nav** (same "URL-only" pattern the deletion log used) —
  lets an admin create/edit/delete Offices and Accounts.

### First-time setup (bootstrap) — do this once after deploying
`accounts-admin.html` needs an admin account to log in, but there isn't
one yet on a fresh deploy. So: **as long as zero admin accounts exist in
KV**, that page accepts the existing `BRAND_EDIT_PASSWORD` secret as a
one-time key (click "No admin account yet — first-time setup" on the
login screen) purely to create the first real admin account. The instant
one admin account exists anywhere in KV, this fallback stops being
accepted for good. No new Cloudflare secret was needed.

**Steps to actually go live:**
1. Deploy this zip.
2. Go to `/accounts-admin.html` (not linked anywhere — bookmark it).
3. Click "first-time setup", enter the existing `BRAND_EDIT_PASSWORD`.
4. Create at least one Office with the real office IP(s).
5. Create the first admin account, assign it to that Office.
6. Log out of bootstrap mode, log back in with the real admin account to
   confirm it works, then create accounts for **every CS agent who uses
   any part of the hub** (each with its brand access + office) — see the
   "Site-wide login gate" section below for why this now includes people
   who only submit tickets or search promo codes, not just TG Reply
   Threads users.

### Verified with an automated test this session (not yet live-tested)
Exercised end-to-end against a fake in-memory KV (bootstrap → office and
account creation → IP allow/deny → brand-filtered list AND direct-by-ID
access → password-less delete with auto `by` → admin-only deletion log →
office deletion locks out its accounts) — 20/20 checks passed. **Still
needs a real run against the live Cloudflare deployment** (real KV, real
`CF-Connecting-IP` through Cloudflare's edge, real office Wi-Fi) before
trusting it in production.

### Site-wide login gate — built this session (bigger scope change)
Originally only `/threads.html` required login. Business owner then asked
to widen this to **the entire hub** — nobody gets past a login page at
all now, not even to see the Home page's brand pills or submit a ticket.
**Practical implication worth restating: every CS agent now needs an
account**, not just the ones using TG Reply Threads — including anyone
who only ever submits tickets or searches promo codes. Create their
accounts from `/accounts-admin.html` before rolling this out, or they'll
just be stuck at the login screen.

How it works:
- **`public/login.html`** — new standalone login page, the only page NOT
  behind the gate (plus `accounts-admin.html`, which has its own separate
  admin/bootstrap flow). Posts to the existing `/api/auth/login`, saves
  credentials to `localStorage` on success, then redirects to whatever
  page the person was trying to reach (`?redirect=`, defaults to `/`).
- **`public/assets/authguard.js`** — new shared script, included near the
  top of `<head>` on every other page (`index.html`, `form.html`,
  `promo.html`, `threads.html`). Runs synchronously before the page
  renders: no saved credentials, or idle-timed-out (still the same 2-hour
  rule)? → immediate `location.replace()` to `/login.html?redirect=...`.
  Otherwise it exposes `window.AgentAuth` with `getAuth()`, `authFetch()`,
  `renderWhoami(elementId)`, and `logout()` for every page to share —
  this replaced a fair amount of code that used to be duplicated inside
  `threads.html` alone (that page's own login form, idle-timer, and
  `authFetch` were all removed in favor of this shared version).
- **Server-side, not just the page redirect:** `POST /api/submit`,
  `POST /api/next-tid`, and `GET /api/promo-search` now all call the same
  `verifyRequest()` used everywhere else and 401 without valid
  credentials — otherwise someone could just curl the API directly and
  skip the login page entirely. `accounts-admin.html`'s own endpoints
  were already admin-gated from earlier in the session and didn't need
  touching.
- Every gated page now shows the same `User: name ROLE` pill + red
  circular logout icon (`window.AgentAuth.renderWhoami("agentWhoami")`) —
  previously only `index.html` had this.

**Not yet tested live** — same caveat as the rest of the account system
this session: logic was reasoned through carefully and the underlying
`verifyRequest()` path is the same one already covered by the 20/20
automated test, but the actual page-redirect flow (login → land back on
the right page with the right query string, idle-timeout redirect from a
random page, etc.) hasn't been clicked through on a live deployment yet.


### Sidebar visual pass (this session, after the account system landed)
- "Solved / Done" renamed to **"Solved Chat History"**.
- All three sidebar sections (Active Threads / Solved Chat History /
  Recall Chat History) now share one visual template: a boxed,
  bordered list under each collapsible header, instead of Active/Solved
  floating with no visible container. Recall Chat History gets a subtle
  red tint on its box + count badge to read as "sensitive" at a glance.
- **Deletion-log retention — no time limit, only a count cap.** Kept
  simple on purpose: `MAX_LOG_SIZE = 500` in `functions/_shared/threads.js`
  (same file as the thread-retention constants) — the 501st deletion
  bumps the oldest entry off, no date-based expiry. If that's ever worth
  changing (e.g. auto-clear entries older than N days like threads
  already do), it's the same `isExpired()`-style pattern, just not built
  yet — business owner was fine with count-only for now.
- The whoami pill + red circular logout icon originally moved to live only
  on the Home page topbar (removing a duplicate that was also on
  `/threads.html`'s topline). **Superseded by the site-wide login gate
  below** — now every gated page shows its own pill via the shared
  `window.AgentAuth.renderWhoami()`, since every page requires login now
  anyway.
- 2-hour idle auto-logout added (client-side, tied to real activity —
  click/keydown/mousemove/touch/tab-refocus — not the background poll).
  See the Account system section above for the honest caveat about this
  being browser-enforced, not server-enforced.

### Account Management sidebar (this session, on top of the login gate)
Home page sidebar now has an expandable **"Account Management"** entry
(same level as QA / Account Issue / etc.), always visible to everyone,
with role-based sub-items:
- **Everyone:** "Reset Password" — self-service only. Requires typing
  the current password again (on top of already being logged in) as a
  deliberate safety net against an unattended-but-logged-in browser. New
  endpoint: `POST /api/account/change-password` — checks two independent
  proofs of identity (session headers + the typed current password), and
  can only ever change the caller's own account, never anyone else's.
  After a successful change, `window.AgentAuth.updateStoredPassword()`
  patches the browser's saved credentials in place so the agent isn't
  immediately logged out right after proving who they are.
- **Admin only, two more:** "Create Account" and "Whitelist IP" — small
  focused modals (not the full `accounts-admin.html` page) that call the
  same existing `/api/admin/accounts` and `/api/admin/offices`
  endpoints. "Reset Password" for an admin is different from the
  self-service version above — picks any account from a dropdown and
  overwrites its password directly, no old password needed (admin
  authority), while carefully preserving that account's existing
  role/office/brand settings (fetches the account list first so the
  "just changing the password" request doesn't accidentally wipe those
  other fields — `saveAccount()` treats missing role/officeId/
  allowedBrands as "reset to defaults", not "leave alone").
- `accounts-admin.html` is unchanged and still the place for full
  list/edit/delete — these are just fast common-action shortcuts
  layered on top, reusing its same backend.

**Not yet live-tested** — same caveat as everything else in the account
system this session. Verified the self-service change-password endpoint
end-to-end against a fake KV (wrong current password rejected, correct
flow succeeds, old password stops working, new password works, and
role/office/brands survive the change) — all passing, but the actual
modals haven't been clicked through in a browser yet.

### Role hierarchy — Agent/Senior/Admin/SuperAdmin (this session, replaces the old binary agent/admin)
Business owner wanted finer-grained control than just "agent vs admin".
New hierarchy, each tier strictly scoped (not a vague "higher rank can
do everything lower ranks can" — the actual rules below are literal,
not a sliding rank comparison):

| Capability | Agent | Senior | Admin | SuperAdmin |
|---|---|---|---|---|
| Reset own password | ✅ | ✅ | ✅ | ✅ |
| Reset an **Agent's** password (assisted) | ❌ | ✅ | ✅ | ✅ |
| Reset a **Senior's** password (assisted) | ❌ | ❌ | ✅ | ✅ |
| Reset an Admin/SuperAdmin's password | ❌ | ❌ | ❌ | ✅ (anyone) |
| Create an **Agent** account | ❌ | ✅ | ✅ | ✅ |
| Create a **Senior** account | ❌ | ❌ | ✅ | ✅ |
| Create an Admin/SuperAdmin account | ❌ | ❌ | ❌ | ✅ (any role) |
| Delete an **Agent** account | ❌ | ❌ (no delete access at all) | ✅ | ✅ |
| Delete a **Senior** account | ❌ | ❌ | ✅ | ✅ |
| Delete an Admin/SuperAdmin account | ❌ | ❌ | ❌ | ✅ |
| View Whitelist IP (Offices) | ❌ | ❌ | 👁️ view only | ✅ view + edit |
| View Agent Profile table | ❌ | ❌ | ✅ view | ✅ view |
| Edit Agent Profile fullName/PSD | ❌ | ❌ | ✅ | ✅ |
| Edit Agent Profile Role | ❌ | ❌ | ❌ | ✅ |

Key point: each tier's authority is a **literal allow-list** ("Senior
manages Agent"; "Admin manages Agent + Senior"), not a sliding "anything
below my own rank" comparison — Admin's reach stops at Senior, it never
extends to other Admins or SuperAdmin regardless of how the numbers
compare. This went through two rounds of correction with the business
owner: v1 used "below my rank" (wrong), v2 used "Agent only for
everyone above Agent" (also wrong — Admin was supposed to reach Senior
too), this is the corrected v3. `MANAGE_SCOPE` in
`functions/api/admin/accounts.js` is the literal allow-list:
`{ senior: ["agent"], admin: ["agent", "senior"] }` (superadmin bypasses
the map entirely). Profile-field editing (fullName/pid) is its own
separate rank check (`rank >= admin`), independent of the manage-scope
allow-list, since it applies to editing ANY account's profile, not
scoped by the target's role the way create/reset/delete are.

**SuperAdmin self-promotion bootstrap.** Changing an EXISTING account's
role now requires SuperAdmin — but that's a chicken-and-egg problem for
the very first SuperAdmin (an Admin can't grant themselves a rank they
don't have). Solution: **while zero SuperAdmin accounts exist anywhere**,
any Admin-or-above account can promote **only its own account** to
`superadmin` (via `accounts-admin.html`'s Edit Account, or Home's Agent
Profile once you're already Admin-tier — Agent Profile edit itself is
SuperAdmin-gated, so realistically this has to happen via
`accounts-admin.html`). The instant one SuperAdmin account exists
anywhere, this path closes for good — same "one-time door, not a
permanent backdoor" pattern as the original BRAND_EDIT_PASSWORD
bootstrap. **To actually do this: log into `accounts-admin.html` as your
existing Admin account, click Edit on your own row, change Role to
`superadmin`, save.**

Implementation: `functions/_shared/accounts.js` now exports `ROLE_RANK`
(`{agent:0, senior:1, admin:2, superadmin:3}`) and a rank-parameterized
`authenticateStaff(request, env, minRank)` (replacing the old binary
`authenticateAdmin`, kept as a thin alias for `deletion-log.js` which is
still simply "admin-or-above"). `functions/api/admin/accounts.js` and
`functions/api/admin/offices.js` both got a full rewrite of their
permission checks along these exact lines — see the comment blocks at
the top of each file for the precise rule for each action.

**Verified with a new 24-check automated test** (`role_hierarchy_test.mjs`,
not shipped in the repo, was a throwaway verification script) covering:
bootstrap can still create the first Office + Admin (regression-checked,
since tightening Whitelist IP to SuperAdmin-only initially broke this —
fixed by making bootstrap grant full trust while zero admin-or-above
accounts exist, not capped at admin-equivalent), SuperAdmin
self-promotion works once and then locks out, Senior capped to Agent
only, Admin's expanded scope (Agent + Senior) for create/reset/delete
but confirmed still blocked from touching other Admins, Admin can now
edit profile fields but still can't change role, SuperAdmin unrestricted
everywhere. All 24/24 passing, plus the original 20-check account-system
suite and 10-check Agent Profile suite were re-run and still pass (54
total across the whole account system this session). **Not yet
live-tested** in the actual browser UI.

### Agent Profile (this session, 4th Account Management sub-item)
New admin-only sub-item under the Home sidebar's Account Management —
opens a wide table modal listing every account with:
- **Full Name** and **PID** — free-text profile fields, editable inline
  per row (pencil icon → inputs appear in that row → ✅ saves, ✖️
  cancels). Also addable at account-creation time now (Create Account
  modal has both fields), and shown/editable in `accounts-admin.html`'s
  full account table too.
- **Last Active Time** — updates from `functions/_shared/accounts.js`'s
  `verifyRequest()`, the same function every single protected endpoint
  already calls. **Throttled to at most once per 5 minutes per
  account** — writing on literally every request (a logged-in agent's
  tab polls every 6s) would blow through Cloudflare KV's free-tier daily
  write limit fast with more than a couple of active agents. This means
  Last Active is accurate to within ~5 minutes, not to-the-second —
  fine for "has this account gone quiet", not meant as a live presence
  indicator.
- **Password Changed** — timestamp + **who changed it**, not just when.
  Self-service changes (`/api/account/change-password`) record the
  account's own username; an admin-driven reset (via the Reset Password
  modal or `accounts-admin.html`) records the **admin's** username
  instead. Both paths funnel through the same `saveAccount()` — the
  caller just says who's responsible via `passwordChangedBy`.

**Underlying refactor worth knowing about:** `saveAccount()` in
`accounts.js` changed from "rebuild the whole record every call" to
proper **patch/merge semantics** — any field left `undefined` now keeps
its existing value instead of being reset to a default. This is what
makes "just update fullName/pid" or "just touch lastActiveAt" safe
without those callers having to also resend role/officeId/allowedBrands/
password to avoid wiping them. Re-verified the full 20-check account
system test suite plus 10 new checks specific to this (patch semantics
preserve unrelated fields, admin-reset records the admin not the
target, throttled lastActiveAt doesn't rewrite on rapid repeated calls)
— all 30/30 passing against a fake KV. **Not yet live-tested.**

**Explicitly paused, not built:** the business owner's original ask also
included being able to see an agent's *actual current password* at any
time, even after they change it themselves. That requires storing
passwords reversibly (encrypted or plaintext) instead of the one-way
PBKDF2 hash used everywhere else in this system — a real security
trade-off, not just a feature flag. Flagged this explicitly and the
business owner said to pause it for now; nothing password-visibility
related was built. If revisited, the discussion to have is exactly that
trade-off (who could read plaintext passwords if this were added, and
whether that's acceptable for this internal tool).

### Not yet done / explicitly deferred (account system)
- `public/index.html`'s "TG Reply Threads" home card doesn't mention
  login is now required — cosmetic, low priority.
- No "forgot password" flow — an admin resets it manually via
  `accounts-admin.html` (leave the password field blank when editing to
  keep the old one, type a new one to overwrite it).
- No rate-limiting on login attempts — acceptable given the IP allowlist
  already blocks anyone off the approved networks entirely.

---

## Still pending / needs input before it can be finished

1. **Promo Code Search — confirmed working live.** Wired this session
   against the real sheet (`1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98`),
   matching now switched from exact to **contains/partial** per business
   owner's live testing (e.g. "1500" surfaces "1500PKR"). Two smaller
   open items remain:
   - **"Start On" column** — the reference layout screenshot has a
     Start On field, but no matching column exists in the sheet as shown.
     Currently always renders as "—". If there is a real source column,
     say which one and it's a one-line fix in `functions/api/promo-search.js`.
   - Assumed **all 11 tabs share the same A–N column layout** as the one
     tab shown in the reference screenshot (Welcome Call Team). If any
     tab is laid out differently, that tab's results will come out wrong
     until it gets its own column mapping.

2. **Deletion log — "who deleted it"** — ✅ **Resolved this session**,
   see the Account system section above. `by` is now auto-filled from the
   logged-in username on every delete/recall action.

3. **Deletion log — visibility/access** — ✅ **Resolved this session**
   (twice — see below). `GET /api/deletion-log` requires a logged-in
   account ranked **admin or above** (admin or superadmin — uses the
   rank-based `authenticateAdmin` alias from the later Role Hierarchy
   work, see below); **the UI itself changed too**: what used to be a
   nearly-invisible dot at the bottom of the sidebar is now a normal
   collapsible section — "**Recall Chat History**" — styled exactly like
   Active Threads / Solved Chat History (same boxed list, count badge,
   expand/collapse). It's admin-or-above-only (hidden entirely for
   agent/senior accounts, server-enforced), so the original "hide it so
   agents don't know it exists" goal is now handled by real permissions
   instead of obscurity — no more reason to keep it disguised as a tiny
   dot. Each entry shows a type badge (Deleted / Recalled / Recalled
   reply), who did it, when, and a short preview of what was removed.
   Refreshes on the same 6s poll as the other sidebar sections
   (admin-or-above accounts only — never fetched at all for agent/senior).
   **Bug partially fixed this session (see 4b below for the rest):**
   `threads.html`'s own visibility check for this section (separate from
   the server-side gate) was still doing a literal `auth.role === "admin"`
   string match — missed during the Role Hierarchy rollout, so it
   silently excluded SuperAdmin (whose role string is literally
   `"superadmin"`, not `"admin"`) from seeing the section rendered at
   all. Fixed to use the same `ROLE_RANK` comparison (`rank >= admin`) as
   everywhere else. **This note originally claimed that fully solved it —
   it didn't.** The server-side gate (`/api/deletion-log`) and
   `accounts-admin.html`'s own login form had the exact same bug and were
   still live; see item 4b for what that actually looked like for a
   SuperAdmin and how it was found/fixed.

4. **Free-tier KV limits** — good to remind a fresh conversation: Cloudflare
   KV free tier is 1,000 writes/day, 1,000 deletes/day, 100,000 reads/day,
   1 GB storage. A single form submission costs ~3 writes; each reply
   costs ~2. The account system adds a small amount more (one write per
   login-adjacent action, none per read). If the team's ticket volume
   grows a lot, the fix is simply upgrading to the Workers Paid plan
   ($5/mo minimum) — no code changes needed, limits jump to ~1M/month.

4b. **✅ Fixed this session — the literal-"admin"-string bug was NOT
    fully fixed, despite this doc previously saying so.** The earlier fix
    only landed in `threads.html`'s client-side visibility check. Two
    more instances of the exact same bug class were still live and got
    fixed just now:
    - **`functions/api/deletion-log.js`** (the actual server-side gate for
      Recall Chat History) — was still `account.role !== "admin"`, a
      literal string compare. Since SuperAdmin's role string is literally
      `"superadmin"`, every SuperAdmin request 401'd here. `threads.html`
      silently swallows a 401 on this endpoint (`if (res.status === 401)
      return;`), so the visible symptom was: SuperAdmin sees the "Recall
      Chat History" section (client-side check was fine), but it's
      permanently empty / stuck at count 0 — looks exactly like "can't
      see it" from the outside even though the section itself renders.
      Fixed to use the existing rank-based `authenticateAdmin()` alias
      from `_shared/accounts.js` (same one `admin/offices.js` etc. use)
      instead of the literal string.
    - **`public/accounts-admin.html`**'s own login form — same bug,
      different surface: logging in with a real SuperAdmin account
      rejected the login client-side with "This account isn't an admin,"
      again from a literal `data.account.role !== "admin"` check. Fixed
      to a local rank comparison (`ROLE_RANK[role] >= ROLE_RANK.admin`),
      matching the pattern used everywhere else.
    - **Swept the rest of the codebase** for the same pattern
      (`grep -rn 'role\s*===\s*"admin"\|role\s*!==\s*"admin"'` across
      `functions/` and every `public/*.html`) — nothing else found.
      `admin/accounts.js`'s few `body.role === "superadmin"` /
      `existingTarget.role` comparisons were checked individually and are
      legitimate (comparing against a specific literal target role for
      the self-promotion bootstrap, or diffing old vs new value) — not
      permission gates, so not the same bug.
    - **Lesson for next time this class of bug is suspected:** don't
      trust a past session's "fixed" note at face value if the actual
      symptom (SuperAdmin can't see something) is still being reported —
      grep for the literal string pattern across the whole repo, not just
      the one file mentioned in the note. This doc said the bug was fixed
      after only patching one of three call sites.
    **Not yet live-tested** — same caveat as everything else this
    session; reasoned through and grep-verified, not clicked through
    against a real deployment with a real SuperAdmin account yet.

5. **TG Group/Channel management UI — ✅ built this session.**
   Business owner was tired of every routing change (chatId/topicId per
   brand per module) requiring a code edit + redeploy from a fresh
   conversation. Built exactly to the agreed design:
   - New Account Management sub-item **"TG Group / Channel"**,
     **SuperAdmin-only** — unlike Whitelist IP (Admin can view read-only,
     SuperAdmin edits), this one is SuperAdmin-only for *viewing* too,
     since routing controls where every ticket actually gets delivered.
   - UI (`public/index.html`, new `tgroutes` mode inside the existing
     Account Management modal): left column lists the 5 brands; clicking
     one shows its 6 modules on the right (QA, Account Issue, Risk Issue,
     Promotion Request, Daily Report, Genie Issue), each with editable
     Chat ID + Topic ID fields, a "default"/"custom" tag, and inline
     ✅ Save / ↩️ Reset-to-default buttons per row (no single global Save
     — too many independently-editable rows for that to mean anything).
   - **Architecture change (as planned):** new `functions/_shared/routes.js`
     — KV layer for overrides, keyed `route:<brandId>:<moduleId>` in
     `THREADS_KV` (same namespace as accounts/offices). `getRouteOverride()`
     is a single KV read; `getAllRouteOverrides()` batch-fetches all
     30 brand×module combos in parallel for the admin grid (no index
     needed at this scale).
   - `functions/api/submit.js` now checks `getRouteOverride(env, brandId,
     moduleId)` **first**, falling back to the existing hardcoded
     `brand.telegram[moduleId] || brand.telegram.default` exactly as
     before if nothing is stored — so shipping this with an empty KV
     changes nothing that already worked; only brand/module combos
     someone actually edits through the new UI diverge from the code
     defaults.
   - New endpoint `functions/api/admin/routes.js` — `GET` returns the
     merged grid (defaults + overrides, with `isOverride` per cell);
     `POST { action:"save"|"reset", brandId, moduleId, chatId?, topicId? }`
     writes/clears one override. Both gated `authenticateStaff(request,
     env, ROLE_RANK.superadmin)`, same pattern as
     `functions/api/admin/offices.js`.
   - **Not yet live-tested** — same caveat as the rest of the account
     system: code reviewed and syntax-checked, but hasn't been clicked
     through against a real Cloudflare deployment yet (create an
     override, confirm the next real submission for that brand+module
     actually lands in the new chat/topic, confirm Reset reverts it).

### Brand dropdown order + "Platform: X INR" formatting (this session)
- `public/assets/schemas.js`'s `BRANDS` array reordered to Crickex,
  Betjili, Mostplay, BetVisa, Jeetway — every module's brand dropdown
  (and the Home page brand-pill row) follows this array's order directly,
  so this one change updates all of them.
- Every TG-message "Platform"/"Brand" labeled **row** (not the title/
  header lines, not the Google Sheet columns — those stay as the plain
  brand name) now reads `"<Brand> INR"`, e.g. `Platform: Crickex INR`.
  Centralized in a `brandInrLabel()` helper in `functions/api/submit.js`,
  applied at the three places a labeled brand row gets rendered:
  `buildPromotionRequestMessage`, `resolveFieldValue` (the shared
  MESSAGE_TEMPLATE row renderer used by QA/Risk Issue/Genie Issue/Daily
  Report), and the Account Issue / Risk Issue dynamic-fallback message
  builders. Verified by rendering sample output in Node — not yet sent
  through a live Telegram message.
- **Done:** all 5 modules unified across all 5 brands — QA (topic 3),
  Account Issue (topic 10), Risk Issue (topic 17), Daily Report (topic
  22), Genie Issue (topic 24), all in chat `-1004488354399`; Promotion
  Request stays in the separate group/topic set up earlier this session
  (`-1003844665813` / topic 30). No more `-100XXXXXXXXXX` placeholders
  left anywhere in `BRANDS`. BetVisa's Risk Issue topic changed from 26
  to 17 to match the new shared value (was the only brand with a real
  value before, and it didn't match what the business owner gave for
  the unified setup).

## Recurring non-code gotcha (from the original handoff, still true)
GitHub web upload can cause duplicate files or misplaced content if the
wrong folder depth is dragged in. Always sanity-check file contents after
upload if something looks broken post-deploy, before assuming the code
itself is wrong.

---

## Full reliability review — this session (in response to "this system
can't crash")

Went through every backend file (`functions/_shared/*.js`, every
`functions/api/**/*.js`) and the highest-risk frontend files
(`authguard.js`, `threads.html`, `index.html`) specifically looking for
places an unexpected error could surface as something worse than a clean
JSON error — a raw platform crash page, a stuck UI, or silently lost data.

### ✅ Fixed: every single API endpoint now has a top-level safety net
Before this session, error handling was inconsistent — some actions
(e.g. `submit.js`'s Telegram-with-attachments send, `threads/[id].js`'s
`reply` action) wrapped their risky calls in `try/catch` and returned a
clean `{ ok:false, error }`; others (`threads/[id].js`'s `editRoot` /
`recallRoot` / `editReply` / `recallReply`, which call the Telegram API
directly) did not. A network hiccup calling Telegram, or Telegram
returning something that isn't valid JSON (happens on their occasional
5xx gateway errors), would throw **uncaught**, with no top-level
`try/catch` in `onRequestPost` to stop it — Cloudflare would return its
own generic platform error page instead of this app's JSON contract, and
the frontend (which always expects `res.json()` to work) would fail in
an ugly, hard-to-diagnose way.

Fixed by renaming every `onRequestGet`/`onRequestPost` to an inner
`handleX()` function and wrapping the outer exported handler in a
`try/catch` that always returns `{ ok:false, error: "Unexpected server
error: ..." }` (status 500, or 502 for the screenshot proxy) on anything
unexpected. This is a **pure safety net** — it changes nothing about
normal operation or existing error messages, it only catches the
unanticipated case that used to fall through. Applied to all 13 endpoint
files: `submit.js`, `threads.js`, `threads/[id].js`, `admin/routes.js`,
`admin/accounts.js`, `admin/offices.js`, `deletion-log.js`,
`auth/login.js`, `account/change-password.js`, `brand-config.js`,
`promo-search.js`, `next-tid.js`, `screenshot/[[path]].js`.
Syntax-checked (`node --check`) and brace-balance-checked on every file
after the change.

### ✅ Fixed — "replies come back slowly under load" (reported live this
session, root-caused and fixed)

**Root cause, confirmed against Cloudflare's own docs, not a guess:**
Workers KV has a hard platform limit of **1 write per second to the same
key** — writing faster than that throws a 429
(https://developers.cloudflare.com/kv/api/write-key-value-pairs/). Every
single reply (webhook or dashboard-sent), new ticket submission,
solve/unsolve toggle, and edit all wrote the exact same shared `"index"`
KV key (the one the sidebar reads). Under real load — two replies to
*different* tickets landing within the same second is completely normal
once there's real traffic — the second write to `index` hits that limit
and throws. `telegram-webhook.js` deliberately swallows ALL errors (so a
sync bug can never make Telegram think the webhook is down and start
retrying), so that failed index write was silently dropped. The
underlying ticket/message itself was NOT lost — `thread:<id>` and the
`msgid:` pointer are separate keys, written first, and succeeded — but
the sidebar entry for that ticket went stale until the next successful
write to that SAME ticket, which is exactly what "feels slow" from an
agent's chair. Not something introduced by this session's earlier
top-level-try/catch hardening — that only changed HTTP API error
*responses*; this is the webhook → KV index write path, unaffected by
that change, and was always going to surface once real ticket volume hit
it.

**Fixed in `functions/_shared/threads.js`:**
- **`writeIndex()` (and `logDeletion()`, same shared-key pattern) now
  retry with backoff** (`kvPutWithRetry` — up to 3 attempts, ~150–400ms
  backoff with jitter) instead of throwing straight through on the first
  429. Turns "silently dropped under load" into "arrives a couple hundred
  ms later" for the transient-contention case, with zero added delay in
  the common case where the first write just succeeds.
- **The expensive full-list expiry sweep (`sweepExpired`) no longer runs
  on every single write.** It used to run on every reply/submission —
  a date check over up to 500 index entries, plus a chain of extra
  deletes whenever anything actually was expired — right on the hot path
  that's already contending for the rate-limited `index` key. Retention
  windows are measured in DAYS (30/90), so sampling it at ~5% of writes
  (`SWEEP_SAMPLE_RATE`) is still more than prompt enough and cuts the
  common-case write down to just the filter/sort/put it actually needs.
- **Independent-key writes parallelized instead of sequential:**
  `createThread()` and `appendMessage()` each write a `thread:<id>` key
  and a `msgid:<chatId>:<mid>` key — different keys, no rate-limit
  interaction between them, so there was no reason to `await` them one
  after another. Now `Promise.all`'d. Same for `purgeThread()`'s per-
  message `msgid:` deletes and the index's own overflow-eviction purge —
  both were sequential `for...of await` loops before, now parallel.
- **Net effect:** less work done per write in the common case (sweep
  mostly skipped), less wall-clock time per write (parallel deletes/puts
  instead of chained), and index updates that hit real contention now
  self-heal within ~1 second instead of vanishing until the next lucky
  write to that same ticket.

**Still true, NOT fixed (same architectural note as last session, now
with a live symptom behind it):** the retry makes contention *survive*
better, it doesn't remove the ceiling — `index` is still a single KV key
shared by every ticket, so there's still a real (now much higher, but
non-zero) volume at which even 3 retries with backoff won't be enough.
If ticket/reply volume keeps growing, the actual fix is moving the index
off a single KV key entirely (Durable Objects, which serialize writes
with no such limit, or sharding the index by e.g. brand or date). That's
a real architecture change — flagging it again rather than building it
unprompted, same as last session.


**KV index race condition.** Several records are shared, single KV keys
that every write does a full read-modify-write against with no locking
or compare-and-swap: the thread sidebar `index`, the `deletion-log`,
`accounts-index`, `offices-index`. Cloudflare KV has no atomic
read-modify-write primitive available here. If two writes land close
together — e.g. two Telegram replies arrive via webhook within the same
moment, or an agent submits a new ticket at the exact instant another
reply is being recorded — both requests read the same starting index,
both write back, and whichever finishes last "wins," silently discarding
the other's index update.

**What this does NOT do:** lose the underlying `thread:<id>` record
itself, or a message inside it — those are each their own KV key, written
directly, never affected by this. **What it CAN do:** make the sidebar
list (and unread badges) briefly miss/misorder an entry until the next
write to that same thread corrects it (e.g. the next reply, or toggling
solved/unsolved). Not caught by anything above, since KV simply doesn't
throw in this scenario — it succeeds at overwriting, it just overwrites
with slightly stale data. Given real traffic volume here (a handful of CS
teams, not high-frequency concurrent writes), the actual odds of this
firing are low, but it's worth stating plainly rather than leaving
undocumented: this is the one place in the system where a "must not
lose/corrupt data" guarantee is architecturally soft. Fixing it properly
would mean moving the index off a single KV key (e.g. Durable Objects for
serialized writes, or accepting eventual-consistency reconciliation) —
a real design change, not something to silently patch in. Flagging for a
decision rather than fixing it, since Durable Objects would be a bigger
architecture shift than this session should make unprompted.

### ⚠️ Known gap, NOT changed (pre-existing, flagging for awareness)
- **`GET /api/screenshot/<key>`** (serves uploaded attachments) still has
  no login gate at all — security is "the key is an unguessable
  timestamp + random string," not real access control. Pre-existing,
  unchanged. Fine for now given the low sensitivity of CS attachments,
  but worth knowing if that changes.

### ✅ Fixed this session — brand logo/link editor: password removed,
logo upload removed entirely

Two changes, both driven by the business owner directly (with a
screenshot of the actual modal):

1. **Logo image upload removed — it never actually worked in
   production.** Rather than debug/fix the file-upload path, the
   business owner asked to just delete it. `public/index.html`'s "Edit
   brand" modal now has ONE field: Link (opens when the pill is
   clicked). No logo field at all for now. `functions/api/brand-config.js`
   dropped the entire multipart-form / R2-upload / `logoUrl` write path.
   The data shape (`{ [brandId]: { logoUrl, link } }`) is untouched —
   `logoUrl` just has nothing writing it anymore, so brand pills fall
   back to their colored-initials avatar until logo handling gets
   redesigned (business owner's words: "Logo 之后再想办法" — revisit
   later, no plan chosen yet).
2. **The standalone `BRAND_EDIT_PASSWORD` gate on this one endpoint is
   gone.** This closes the inconsistency flagged earlier this session
   (see the "Known gap" note that used to be here) — the business owner
   asked to remove the password entirely, and simply deleting it with
   nothing in its place would have made this THE ONLY unauthenticated
   write endpoint in the whole hub (worse than before, not just
   unchanged). Replaced it with the same `verifyRequest()` login check
   every other endpoint uses instead of removing the gate outright — any
   logged-in agent (any role) can edit a brand's link now, the same way
   they can submit tickets; there's no extra rank restriction on this
   specific action. `BRAND_EDIT_PASSWORD` the Cloudflare secret itself is
   NOT removed — it's still used for the separate `accounts-admin.html`
   bootstrap flow (creating the very first admin account), which is
   unrelated to this endpoint.

**Frontend request shape changed too:** was `multipart/form-data` (to
carry the file), now a plain JSON body `{ brand, link }` sent through
`window.AgentAuth.authFetch()` (adds the login headers automatically),
same pattern every other admin-ish action in `index.html` already uses.

Syntax-checked (`node --check` on the backend file, and the extracted
inline `<script>` from `index.html`). **Not yet live-tested** — same
caveat as everything else touched this session.


### Everything else checked and found solid
- `telegram-webhook.js` — already had exactly the right shape (outer
  `try/catch` swallowing everything, always returns 200 fast) so a
  broken reply-sync can never make Telegram think the webhook is down
  and start retrying/backing off. No changes needed.
- `googleSheets.js`, `r2.js` — every exported function throws on failure
  as designed, and every caller already wraps them (`submit.js` captures
  `sheetError`/`r2Errors` and still returns success for the parts that
  worked — a Sheets outage never blocks the Telegram send that already
  succeeded).
- `accounts.js` — `verifyRequest()` returns `null` on any failure
  (bad username, bad password, bad IP) without ever leaking which one
  failed; the PBKDF2 hashing path has no unguarded external calls.
- Permission-check logic in `admin/accounts.js` (self-promotion
  bootstrap, manage-scope allow-lists) re-read carefully — all the
  literal-vs-rank comparisons in that file are legitimate (comparing
  against one specific target role, or diffing old vs new value), not
  the same bug class as the earlier admin-string fixes.
