# Integration Portal (2026-08)

## What changed

A new expandable sidebar group, **Integration Portal**, positioned above
**Account Management** in the "ISSUE SUBMISSION" nav (both on the Home
page's own sidebar and on every other page via the shared `hub-nav.js`
component).

It holds 4 items:

- **TG Group / Channel** — moved out of Account Management (same modal,
  same `/api/admin/routes` backend, unchanged).
- **Deposit Sheet Link** — moved out of Account Management (same modal,
  same `/api/admin/deposit-sheets` backend, unchanged).
- **Betting Resources Links** — moved out of Account Management (same
  modal, same `/api/admin/betting-resources` backend, unchanged).
- **Web Link** *(new)* — the URL each brand's pill on the Home page's
  marquee row (`#brandRow`) opens when clicked. This used to be editable
  inline via a pencil-icon (✏️) button right on the pill, open to **any**
  logged-in agent with no permission gate at all. That inline shortcut
  has been **removed entirely** — editing a brand's pill link now only
  happens from this new panel, and is properly section-gated (see
  below). Same underlying storage/endpoint as before
  (`/api/brand-config`, R2-backed), just a stricter door into it and a
  proper place in the nav instead of a hidden pencil icon.

Account Management keeps: Create Account, IP Access, Settings, Reset
Password, Agent Profile.

## Permissions

Two additions to the existing Account Management Access system
(`functions/_shared/accounts.js`):

- **`webLink`** — a new entry in `ADMIN_SECTIONS`/`EDITABLE_ADMIN_SECTIONS`,
  gating the Web Link panel exactly like its 3 siblings (View only / Can
  Edit, defaults to SuperAdmin-and-above like `tgRoutes`/`depositSheets`/
  `bettingLinks` already did).
- **`integrationPortal`** — a *visibility-only* flag (not in
  `EDITABLE_ADMIN_SECTIONS` — there's no separate content to view vs.
  edit) that gates whether the whole Integration Portal group shows up
  in the sidebar at all, on top of each item's own individual gate.
  Same single-checkbox-grants-both-View-and-Edit treatment as
  `announcements` already has in Agent Profile's Topic Access list —
  surfaced as a new **🔗 Integration Portal** checkbox there.

In the Agent Profile modal, the old single "Account Management Access"
collapsible box is now **two** boxes side by side in the same
Owner/delegate-only area:

- **Account Management Access** — Create Account, IP Access, Settings,
  Agent Profile (unchanged sections, just 3 fewer items than before).
- **Integration Portal Access** *(new)* — TG Group/Channel, Deposit
  Sheet Link, Betting Resources Links, Web Link, each with its own View
  only / Can Edit radio, same as before.

Both boxes write to the exact same `allowedAdminSections` /
`adminSectionEditAccess` fields on the account record — this is a UI
reorganization, not a new storage shape. `functions/api/admin/accounts.js`
gained a `integrationPortalView`/`integrationPortalEdit` request-body
pair (mirroring the existing `announcementsView`/`announcementsEdit`
pair) for the Topic Access checkbox specifically.

## `/api/brand-config` tightened

`POST /api/brand-config` (saves a brand's pill link) previously only
required *being logged in* — any agent, any rank, no section check. It
now also requires `canEditAdminSection(account, "webLink")`. `GET`
(used to render the pills themselves) is unchanged — still public.

## Fixed while in the area

`openAdminModalFromQuery()` in `index.html` (handles `/?admin=<mode>`
deep-links sent from `hub-nav.js` on other pages) was missing a
`bettinglinks` → `bettingLinks` entry in its `modeToSection` map — the
Betting Resources Links sidebar item on every *other* page has always
linked to `/?admin=bettinglinks`, but that landed on a silent no-op
instead of opening the modal. Fixed alongside adding the new `weblink`
entry.

## Files touched

- `functions/_shared/accounts.js` — new sections.
- `functions/api/admin/accounts.js` — Integration Portal Topic Access
  toggle handling.
- `functions/api/brand-config.js` — permission check on POST.
- `public/index.html` — sidebar markup + script (new group, new
  `weblink` modal mode, split Agent Profile permission boxes, removed
  the old pencil-icon edit modal).
- `public/assets/hub-nav.js` — same sidebar reorg for every other page.
- `public/assets/style.css` — removed the now-dead `.pill-edit` rules
  (no new CSS needed — the new group reuses the existing generic
  `.am-group`/`.am-toggle` styles).
