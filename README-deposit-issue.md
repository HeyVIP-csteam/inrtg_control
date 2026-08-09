# Deposit Issue module — now merged into your real repo

## Fix: "Deposit Sheet Link" modal was slow to open
`GET /api/admin/deposit-sheets` was fetching each brand's Deposit Backup
config one at a time (9 sequential KV round-trips) instead of in
parallel like the Deposit Issue sheets fetch already did — noticeably
slow. Now uses `Promise.all` the same way, should open close to
instantly.

## Update: "Deposit Backup" This Month / Last Month rotation (config only)
Added to the same "Deposit Sheet Link" admin page, two more rows per
brand — this is config/prep only, no actual Deposit Backup search page
built yet (that's a separate future feature, this just gets the Sheet
links ready for it, same idea as how Deposit Issue's own admin config
came before its search page).

- **💻 Deposit Backup — This month**: directly editable, same as Deposit
  Issue's row (paste URL + tab name(s), Save/Clear).
- **💻 Deposit Backup — Last month**: **read-only** — no Save/Reset, by
  design. It only ever changes via the rollover button below.
- **🔄 Roll to Next Month** button: shifts whatever's currently in This
  Month into Last Month (discarding whatever Last Month held before),
  and clears This Month out. Two-step workflow, exactly as you
  described: (1) click Roll — This Month's July sheet becomes the new
  Last Month, old June is discarded, This Month goes empty; (2) paste
  the new August link into This Month and Save. Confirms before running,
  since it's destructive to the old Last Month.

**New KV shape** (`functions/_shared/depositSheets.js`): one combined
entry per brand at `deposit-backup:<brandId>` holding both
`{thisMonth, lastMonth}` together — the rollover is a single atomic
write, not two separate ones, so there's no window where it could end
up half-updated.

## Update: clickable ↗️ jumps straight to the row in Google Sheets
The merged "Crickex - CX PKR" pill on each result card now has a small
↗️ icon — clicking it opens that exact row, in that exact tab, directly
in Google Sheets (new tab), instead of just opening the spreadsheet at
its default view. Works via `#gid=<tab's internal id>&range=A<row>` in
the URL, which Google Sheets understands natively.

- `search.js` now also fetches each tab's `gid` (its internal numeric
  sheet ID — different from the spreadsheet's own ID) alongside its
  title, and includes a ready-to-use `sheetUrl` on every result.
- `deposit-issue.html` renders it as a tiny link inside the pill; if a
  result somehow has no `sheetUrl` (shouldn't normally happen), the icon
  is simply omitted rather than showing a broken link.

## Update: "All Brands" redesigned as a Sheet directory (not a search)
Instead of removing "All Brands" outright, it's now repurposed: selecting
it (or just landing on the page — it's the default) shows a simple list
of every accessible brand's own Sheet, each with its logo and an
"📄 Open Sheet" button that opens that brand's actual Google Sheet in a
new tab — same idea as the "HEYVIP Deposit Backup" reference card you
sent. It's a directory, not a search: trying to actually search while
"All Brands" is selected shows an inline message ("Please select a
specific brand before searching...") instead of firing a request, so the
scaling problem (fanning a search out across up to ~100 sheets) never
happens — searching still requires picking one specific brand first.

**New file:**
- `functions/api/deposit-issue/sheet-links.js` — GET-only, returns each
  accessible brand's Sheet ID (or `null` if not linked yet) for the
  directory view. Same `canSeeBrand()` filtering as search.js/update.js —
  an agent scoped to one brand only ever gets that one brand back.

**Changed:**
- `public/deposit-issue.html` — "All Brands" is back in the dropdown
  (first item, above the real brands), defaults to selected on load;
  `showBrandDirectory()` renders the card list; `doDep()` now guards
  against searching while in this mode.

## Update: "All Brands" removed + real per-brand access control
Two related changes, both about scaling toward ~100 brand sheets:

1. **"All Brands" option removed from the search dropdown.** Fanning a
   search out across every configured brand's sheet doesn't scale — each
   brand is a separate round-trip to the Sheets API, sequentially. At 9
   brands it's tolerable; approaching 100 it would blow past Cloudflare's
   sub-request limit per request and take far too long either way. A
   specific brand must now be selected before searching (defaults to the
   first brand in the list). The backend (`search.js`) still technically
   supports an empty `brand` (fans out, same as before) as a safety net /
   for any future internal use, but nothing in the UI can trigger it
   anymore.
2. **Real per-brand access control, finally wired in.** Previously
   flagged as a known gap (any logged-in agent could search/update any
   brand regardless of their assigned scope) — now uses the exact same
   mechanism as the rest of the hub, on both ends:
   - **Frontend**: the brand dropdown is filtered through
     `window.AgentAuth.filterAllowedBrands()` — the same helper the home
     page and ticket submission form already use. An agent scoped to
     Crickex only never even SEES the other 8 brands as an option, not
     just gets blocked after picking one.
   - **Backend** (defense in depth, in case anyone ever calls the API
     directly instead of through the page): `search.js` rejects an
     explicitly-requested brand the account can't see (403) via
     `canSeeBrand()`, same check `submit.js` uses. `update.js` resolves
     which brand a given `sheetId` belongs to, then checks `canSeeBrand()`
     before allowing the write — so an agent scoped to Crickex only can't
     update Betjili's sheet even if they somehow knew/guessed its Sheet ID.
   - An account with `allowedBrands: "all"` (or Admin/SuperAdmin rank)
     still sees/can act on everything, same as everywhere else in the hub.
   - **Nothing to configure** — this reuses each account's existing
     `allowedBrands` setting from Account Management; if it was already
     set up for the ticket modules, Deposit Issue now respects the same
     scoping automatically.

## Update: now covers all 9 PKR brands (not just Crickex)
The "Deposit Sheet Link" admin page has been restructured to fully mirror
TG Group/Channel's layout: a left-side list of all 9 PKR brands
(Crickex, Betjili, Mostplay, Jeetwin, Sbj66, Heybaji, Superbaji, KV8,
Darazplay), click one, edit/save its Sheet URL + tab name(s) on the
right. This replaces the earlier single "Deposit Issue" row version.

**Why:** only Crickex's sheet is actually in hand right now, but this
gets the other 8 brands ready as slots — as you get access to each
department's sheet, just click that brand and paste the link in, no code
changes needed, ever.

**What changed:**
- `functions/_shared/depositSheets.js` — now keyed by `(moduleSlot,
  brandId)` instead of just `moduleSlot`; exports `PKR_BRANDS` and
  `getAllDepositSheetOverrides()` for batch reads.
- `functions/api/admin/deposit-sheets.js` — GET now returns `{ brands,
  sheets: { [brandId]: {...} } }` (same shape as `/api/admin/routes`);
  POST takes `brandId` instead of `slotId`. Only Crickex has a hardcoded
  default; every other brand starts at `sheetId: ""` (unconfigured) until
  you save one.
- `functions/api/deposit-issue/search.js` — now takes an optional `brand`
  in the request body:
  - **A specific brand selected** → searches only that brand's sheet. If
    it has no link saved yet, returns `{ notConfigured: true }` instead
    of a confusing empty result set.
  - **"All Brands" (no brand sent)** → fans the search out across every
    *currently configured* brand's sheet (skips any brand with no link
    saved, listed back as `unconfiguredBrands` so you can see what's
    still missing), merging results together, respecting the 500-result
    cap across the whole batch. Each result now carries `brand`/
    `brandName` so the UI can show which brand it came from.
  - Tab-name mismatches are now reported per-brand in a `tabWarnings`
    array (was a single flat `missingTabs`/`actualSheetTabs` pair before)
    — necessary since "All Brands" can hit several sheets in one request.
- `functions/api/deposit-issue/update.js` — now requires `sheetId` in the
  request body (since different brands may write to different sheets;
  before, there was only ever one sheet, so this wasn't needed). Validates
  the given `sheetId` is actually one of the currently-configured brand
  sheets before writing, so a logged-in agent can't point an update at an
  arbitrary Sheet ID.
- `public/deposit-issue.html` — search request now includes
  `brand: _selBrand` (the existing brand dropdown, previously UI-only,
  now actually drives which sheet(s) get searched); update request now
  includes `sheetId: curDep.sheetId`; result cards show a brand pill;
  handles the `notConfigured` and per-brand `tabWarnings` responses.
- `public/index.html` — Deposit Sheet Link now uses the exact same
  brand-sidebar markup/CSS classes as TG Group/Channel
  (`.tgroute-layout` / `.tgroute-brands` / `.tgroute-brand`), including
  the same click-to-select-brand behavior.

**Nothing needs re-entering** — Crickex's existing working config (the
`1HByPuZMuuYZL9S5fPPGjb8RAmCwNVgKXvuLgVBbVM-E` / `CX PKR` you already
have live) is preserved as its hardcoded default, exactly as before.

## New: "Deposit Sheet Link" admin page
Added under Account Management, next to TG Group / Channel (same
override-over-code-default pattern, same permission system). Lets a
SuperAdmin (or anyone granted the new `depositSheets` admin-section
access) paste in a new Google Sheets URL whenever the other department
swaps the Deposit Issue sheet out — no code edit, no redeploy.

**New files:**
- `functions/_shared/depositSheets.js` — KV layer (mirrors `routes.js`)
- `functions/api/admin/deposit-sheets.js` — GET/POST admin API (mirrors `functions/api/admin/routes.js`)

**Changed files:**
- `functions/_shared/accounts.js` — registered `depositSheets` in
  `ADMIN_SECTIONS`/`EDITABLE_ADMIN_SECTIONS` (same rank-tiered default as
  `tgRoutes`: only SuperAdmin sees/edits it by default; an Owner can grant
  it to specific accounts, same as every other admin section)
- `functions/api/deposit-issue/search.js` and `update.js` — now resolve
  the Sheet ID + tab names via `getDepositSheetOverride()` first, falling
  back to the hardcoded `SHEET_ID`/`TAB_NAMES` constants only if nothing's
  been saved through the admin page yet
- `public/index.html` — new sidebar item "Deposit Sheet Link", reusing
  the exact same `tgroute-*` CSS classes as TG Group/Channel so it looks
  native, not bolted on

**How to use it:** Account Management → Deposit Sheet Link → paste the
new Sheet's full URL (or just its ID) → type the tab name(s), comma-
separated if more than one → Save. Takes effect on the very next search,
no deploy needed. "Reset" reverts to the hardcoded default in `search.js`.

**Built for extensibility, per your Deposit Backup plan**: this isn't
hardcoded to a single sheet — it's keyed by "slot" (`depositIssue` today).
When Deposit Backup gets built, its search/update files just need to call
`getDepositSheetOverride(env, "depositBackup")` the same way, and add one
line to the `SLOTS` array in `deposit-sheets.js` — no new UI pattern, no
new permission system, it reuses everything here.


This version is merged directly into the actual `pkr-issue-hub` project you
sent (using your real `functions/_shared/accounts.js`, `authguard.js`, and
`index.html` — not placeholders anymore). Everything below is already done
for you in this zip; you just need to fill in the 2 placeholders and deploy.

## What changed vs. the first draft
- ✅ **Login gate wired for real** — `search.js` and `update.js` now import
  `verifyRequest` from your actual `functions/_shared/accounts.js` and
  reject with 401 if not logged in, exactly like `submit.js` does.
- ✅ **Frontend uses your real auth** — `deposit-issue.html` now loads
  `/assets/authguard.js` (redirects to login if not authenticated) and
  calls the two new APIs via `window.AgentAuth.authFetch(...)`, which
  automatically attaches the `X-Agent-Token` header and bounces back to
  login on a 401 (account locked, IP changed, token expired, etc.) — same
  behavior as every other page in your hub.
- ✅ **Real home page card added** — `public/index.html` now has a
  "Deposit Issue" tool-card next to "Promo Code Search", linking to
  `/deposit-issue.html`.
- ✅ **Restyled to match your real site** — `deposit-issue.html` now uses
  your actual `/assets/style.css` (same `--card-bg`/`--border`/`--ink`
  variables, `.topbar`, `.back-pill`, light/dark theme toggle, starfield
  background) instead of its own standalone dark theme. Same visual
  language as `promo.html`/`threads.html`, just with its own `dep-`
  prefixed classes for the parts unique to this page (brand dropdown,
  result cards, edit panel).
- ✅ **Tab-name mismatch is no longer silent** — this is what caused your
  "No results found" earlier: `search.js` now calls the Sheets API to get
  the sheet's REAL tab names first, and only queries tabs that actually
  match `TAB_NAMES` (same trick `promo-search.js` already used). If a
  configured tab doesn't exist, the page shows a yellow warning banner
  listing exactly what's missing and what the sheet's real tab names are
  — so a typo/rename shows up immediately instead of quietly returning 0
  results forever.

## Sheet ID & tab name — already filled in
```
SHEET_ID:  1HByPuZMuuYZL9S5fPPGjb8RAmCwNVgKXvuLgVBbVM-E
TAB_NAME:  CX PKR
```
`bjpkr2024@gmail.com` (the OAuth account) already has Editor access on this
Sheet, so no extra sharing step was needed — the code in this zip is ready
to deploy as-is, no placeholders left to fill in.

## 1. Confirm the 3 OAuth secrets are set
Already added earlier to Cloudflare Pages → Settings → Environment
variables — just confirm both **Production** and **Preview** have all three:
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`.

## 2. Deploy and test
1. Push/upload this whole zip's contents into your repo (merges cleanly —
   only new files + the two small edits inside `index.html`).
2. Open your site, log in normally, click the new **Deposit Issue** card.
3. Search a real Transaction ID / Reference / Username / Agent Number that
   exists in the sheet.
4. Click Edit, change a field, Submit — confirm the row updates in the
   real Google Sheet.
5. Confirm logging out and hitting `/deposit-issue.html` directly redirects
   to login (proves the gate is actually enforced, not just hidden in the UI).

## Notes / things you may want to revisit later
- **Brand filter**: the dropdown (9 PKR brands, real logos) is fully wired
  on the frontend, but `search.js` doesn't filter by brand server-side yet
  — it searches the whole sheet regardless of which brand is selected.
  Your sample data was all Crickex — worth confirming with the other
  department whether this Sheet is single-brand (in which case the
  dropdown could just be removed) or covers multiple brands (in which case
  I can wire real filtering once we know how brand is represented in the
  sheet — a column? separate tabs?).
- **Per-account access control**: submit.js also checks `canSeeBrand` /
  `canSeeModule` so an agent scoped to specific brands/modules can't act
  outside them. This module doesn't have an equivalent yet — right now
  any logged-in agent can search/update anything in this sheet. Worth
  adding once you decide whether Deposit Issue should be scoped per-agent
  like the ticket modules are.
- **Search matches** Transaction ID (A), Reference (K), Username (E), and
  Agent Number (D) — substring, case-insensitive.
- **Image Link (col G)**: if a row has a value here, a small "🖼️ Image"
  button appears next to the Transaction ID in the result card. Clicking
  it opens a fullscreen lightbox (reuses the exact same
  `.attach-lightbox` styling/markup as `threads.html`) showing that URL
  directly as an `<img>` — no server proxy, no KV, no storage of any
  kind, exactly as asked. This assumes the sheet's Image Link values are
  direct image URLs; if they're actually Google Drive "view" links or
  something else that doesn't render as a raw `<img src>`, the lightbox
  will show a "couldn't load" message instead — let me know if that
  happens and I'll adjust (e.g. converting a Drive share link to its
  direct-image form).
- **Transaction Error (col H)**: shown as a colored pill like Status PG,
  but since you didn't give me a fixed list of possible values for this
  column (unlike Status PG's ~30 values), each distinct string gets a
  color deterministically hashed from its text — the same error message
  always gets the same color, picked from a 5-color vibrant palette,
  never gray. If you want exact per-message colors instead (e.g. all
  bank-related errors red, all "pending" ones orange), send me the real
  list of values like you did for Status PG and I'll swap this for an
  explicit map.
- **Edit panel now has a "Clear All — Update Sheet" button** below Submit
  — one click blanks CS PIC / Player Contact No / Status CS / Correct UID
  AND writes the blanks to the Sheet immediately (not just clearing the
  boxes on screen). Confirms first (since it's destructive) unless all 4
  fields were already empty. Re-opening Edit on the same result always
  shows whatever was last successfully written (this was already true
  before this change — Submit updates the local copy of that row, so
  re-clicking Edit shows the latest values, not stale ones).
- **Player's Cart ID (col T)** and **Payment Status (col U)** are now
  shown in each result card. Payment Status is colored to match your
  Sheet's own conditional formatting (maroon for Not Receive/Duplicate/
  Agent Close, lavender for Refund Success, amber for CS-Ignore, green
  for Manually Credited, navy for Provide Correct UID, blue for Approved
  by System). Any value not in that list falls back to the same
  hash-based color assignment as Transaction Error — still never gray.
- **Edit Record panel height now matches the first result card** — it's
  no longer a fixed size; JS measures the first `.dep-rcard`'s actual
  rendered height after every search and applies it as the panel's
  `min-height`, re-measuring on window resize/zoom too, so the two stay
  visually aligned at any window size.
- **Fixed a pre-existing display bug**: the yellow tab-mismatch warning
  banner used to disappear whenever the search actually found some
  results (it only survived when there were zero results) — it now
  always shows above the results when applicable.
- **Result card layout widened** — fields now show 3 per row (was 2) on
  desktop, with larger gaps and more card padding, so cards read as less
  cramped/tall. Auto-drops to 2 columns under 1100px width and 1 column
  under 640px (mobile), so it never feels squeezed on smaller screens.
- **Performance**: reads the whole tab on every search — fine for a few
  thousand rows, may need optimizing if this sheet gets very large.
