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
| `public/accounts-admin.html` | **New this session** — hidden admin page, not linked from nav; create/edit/delete Offices and Accounts |
| `functions/api/submit.js` | Submission handler — sends Telegram message, writes Sheets, **creates a TG Reply Threads record** |
| `functions/_shared/routing.js` | Per-brand/module Telegram + Sheet config; `MODULE_META` now includes `accent` color too |
| `functions/_shared/googleSheets.js` | Google Sheets API helpers — now also `batchGetValues` (read-only, multi-range) for Promo Code Search |
| `functions/_shared/r2.js` | R2 upload helper |
| `functions/_shared/threads.js` | **TG Reply Threads KV storage layer** — create/read/update threads, index, auto-cleanup, deletion log |
| `functions/_shared/accounts.js` | **New this session** — Office/Account KV storage, password hashing, per-request auth verification, brand-permission check |
| `functions/api/auth/login.js` | **New this session** — `POST /api/auth/login` |
| `functions/api/admin/offices.js`, `functions/api/admin/accounts.js` | **New this session** — admin-only Office/Account CRUD, used by `accounts-admin.html` |
| `functions/api/telegram-webhook.js` | **Receives Telegram messages**, matches replies to threads |
| `functions/api/threads.js` | `GET /api/threads` — list active/solved threads, search — **now login-gated and brand-filtered** |
| `functions/api/threads/[id].js` | `GET`/`POST` single thread — solve, delete, reply, editRoot, recallRoot, editReply, recallReply — **now login-gated, brand-filtered, and delete/recall no longer need a separate password** |
| `functions/api/deletion-log.js` | `GET /api/deletion-log` — deletion history — **now requires an admin-role login** |
| `functions/api/promo-search.js` | **Real search this session** — reads the shared Promo Code Google Sheet (11 team tabs), exact-matches the Promo Code column, groups results by tab |
| `functions/api/brand-config.js` | Password-protected brand logo/link editor (unchanged this session) |
| `functions/api/next-tid.js` | TID generator for Promotion Request (unchanged) |
| `functions/api/screenshot/[[path]].js` | Serves R2 objects (unchanged) |
| `wrangler.toml` | Now includes the `THREADS_KV` binding (real namespace ID, not a placeholder) |

## Modules — all 6 unchanged functionally, descriptions updated
QA / Account Issue / Risk Issue / Promotion Request / Daily Report / Genie
Issue — same as before. Sidebar descriptions were shortened this session
(e.g. "OTP & Domain issue etc.", "Account verify & otp etc.").

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
| Surface | Before | Now |
|---|---|---|
| `/threads.html` | Open to anyone with the URL | **Requires login** |
| `GET /api/threads` (sidebar list) | Open | Login required; filtered server-side to the account's `allowedBrands` |
| `GET /api/threads/<id>` + all POST actions | Open (delete/recallRoot/recallReply needed `BRAND_EDIT_PASSWORD`) | Login required; a thread outside the account's brands 404s — verified an agent can't fetch it directly by ID either, not just hidden from the list |
| Delete / recall actions | Needed `BRAND_EDIT_PASSWORD` prompt | **No extra password** — being logged in as an account that can see the brand is the authorization. `by` on every deletion-log entry is now auto-filled from the logged-in username instead of always `null` |
| `GET /api/deletion-log` | URL-obscurity only, no auth | **Requires `role: admin`** |
| `form.html` (ticket submission), `promo.html` (Promo Code Search) | Open | **Unchanged, still open** — confirmed these should NOT be gated |

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
   confirm it works, then create the rest of the agent accounts (each
   with its brand access + office) from there.

### Verified with an automated test this session (not yet live-tested)
Exercised end-to-end against a fake in-memory KV (bootstrap → office and
account creation → IP allow/deny → brand-filtered list AND direct-by-ID
access → password-less delete with auto `by` → admin-only deletion log →
office deletion locks out its accounts) — 20/20 checks passed. **Still
needs a real run against the live Cloudflare deployment** (real KV, real
`CF-Connecting-IP` through Cloudflare's edge, real office Wi-Fi) before
trusting it in production.

### Not yet done / explicitly deferred
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

3. **Deletion log — visibility/access** — ✅ **Resolved this session**,
   see the Account system section above. `GET /api/deletion-log` now
   requires a logged-in account with `role: admin`; the dot in the
   sidebar is hidden client-side for non-admins too (defense in depth —
   the real enforcement is server-side).

4. **Free-tier KV limits** — good to remind a fresh conversation: Cloudflare
   KV free tier is 1,000 writes/day, 1,000 deletes/day, 100,000 reads/day,
   1 GB storage. A single form submission costs ~3 writes; each reply
   costs ~2. The account system adds a small amount more (one write per
   login-adjacent action, none per read). If the team's ticket volume
   grows a lot, the fix is simply upgrading to the Workers Paid plan
   ($5/mo minimum) — no code changes needed, limits jump to ~1M/month.

## Recurring non-code gotcha (from the original handoff, still true)
GitHub web upload can cause duplicate files or misplaced content if the
wrong folder depth is dragged in. Always sanity-check file contents after
upload if something looks broken post-deploy, before assuming the code
itself is wrong.
