# Integration Portal — Promo Code Gsheet + Issue Submission Gsheet

Adds two new rows to the existing Integration Portal sidebar dropdown,
following the exact same "KV override + code default" pattern as Deposit
Sheet Link / Web Link (see INTEGRATION-PORTAL-PATTERNS.md if you have it —
this is a port of that architecture into INR-active-agents).

## ⚠️ One manual step still required — `functions/_shared/accounts.js`

This zip's `functions/_shared/` directory was received empty (no
`accounts.js`, `routing.js`, etc.), so everything below was built by
importing already-known export names from those files, never by editing
their contents blind. Every file that genuinely needed changes and that I
could see (submit.js, promo-search.js, index.html, deposit-sheets.js's
sibling admin endpoints) has been edited or added.

**The one exception is `functions/_shared/accounts.js` itself** — the two
new admin-section ids below need to be registered there or
`canSeeAdminSection()`/`canEditAdminSection()` will always return `false`
for them (except for the literal Owner role, which always passes). Add,
mirroring however `depositSheets`/`webLinks` are already registered there:

```js
// ADMIN_SECTIONS (or equivalent registry array)
"promoCodeSheet", "issueSubmissionSheet",

// EDITABLE_ADMIN_SECTIONS (both support Can-Edit)
"promoCodeSheet", "issueSubmissionSheet",
```

If there's also a floor-rank concept there (this project's client-side
mirror in `public/index.html` uses `ROLE_RANK.superadmin` for both, same
as `depositSheets`/`webLinks`), use the same floor. Don't need to touch
`ADMIN_SECTIONS_DEFAULT_SEEN`/`DEFAULT_EDIT` — leaving both new ids out of
those maps means only the Owner sees them by default (matches how the
whole Integration Portal group is already gated behind an Owner-granted
`integrationPortal` topic, so this doesn't change anything for anyone
until the Owner explicitly grants it per-account, same as shipping any
other section here).

## What's new

### `functions/_shared/promoCodeSheetOverride.js` (new)
KV-override layer for Promo Code Search's sheet. Single global slot (no
brand dimension) — one shared workbook used across every team. Hardcoded
default (`PROMO_CODE_SHEET_DEFAULT`) moved here from `promo-search.js` so
the admin endpoint and the actual search endpoint can't drift apart on
what "the default" is.

### `functions/_shared/issueSubmissionSheets.js` (new)
KV-override layer for "which sheet + tab does this brand's module write
to" — one entry per (brandId, moduleId). Promotion Request (which varies
by promotion type, not just brand) reuses this same layer via a synthetic
key from `promotionModuleId(promotion)`, rather than a second storage
layer. Includes `resolveWriteTab()`, which picks the first of the saved
comma-separated candidate tab names that actually exists on the live
sheet (falls back to the first candidate if none match, so a write still
goes somewhere and surfaces a real Sheets API error rather than silently
no-opping).

### `functions/api/admin/promo-code-sheet.js` (new)
`GET`/`POST save`/`POST reset` for the single global slot. Gated on
`canSeeAdminSection`/`canEditAdminSection(..., "promoCodeSheet")`.

### `functions/api/admin/issue-submission-sheet.js` (new)
`GET`/`POST save`/`POST reset` for the brand × module grid, plus dynamic
Promotion Request rows (one per `PROMOTION_SHEET_CONFIG` entry for that
brand). Gated on `..., "issueSubmissionSheet"`.

### `functions/api/promo-search.js` (edited)
Now resolves the active sheet via `getPromoCodeSheetOverride()` before
falling back to `PROMO_CODE_SHEET_DEFAULT`. Tab-title cache is now keyed
by `sheetId` (was a single slot) so a saved override never serves a stale
cache for the previous sheet.

### `functions/api/submit.js` (edited)
Resolves an `issueSheetOverride` right before the existing sheet-write
block and threads `effectiveSheetId`/`effectiveTab` through all three
write paths (Promotion Request, `pairByDate` shift sheets, plain
`appendRowByColumns`). **Only ever overrides sheetId/tab** — `startColumn`
and `columns` (the actual column layout) always stay the hardcoded
routing.js default, same reasoning as Deposit Sheet Link.

### `public/index.html` (edited)
- Two new sidebar sub-items under the existing Integration Portal group
  (`subPromoCodeSheet`, `subIssueSubmissionSheet`), gated the same way as
  the other four.
- `ADMIN_SECTIONS_LIST`/`EDITABLE_ADMIN_SECTIONS` (client-side mirror of
  accounts.js) updated with the two new ids — **needs its server-side
  counterpart, see the warning above.**
- `INTEGRATION_PORTAL_SECTION_IDS` (Agent Profile modal's checkbox
  grouping) updated so the two new Can-See/Can-Edit checkboxes render
  under the "Integration Portal" header instead of "Account Management".
- `openAcctModal()` dispatch: two new modes, `promocodesheet` and
  `issuesubmissionsheet`, both using the existing `tgroute-*` CSS classes
  (Promo Code Gsheet skips the brand-list column — it's a single global
  form).
- Full load/render/save/reset JS for both modals, same shape as the
  existing Deposit Sheet Link / Web Link sections right above them.

## Not touched

- `functions/_shared/routing.js`, `accounts.js`, `googleSheets.js`, and
  every other file that was already missing from this zip — none of them
  needed their *contents* changed, only new files importing already-known
  names from them (`BRANDS`, `MODULE_META`, `SHEET_LAYOUT`,
  `PROMOTION_SHEET_CONFIG`, `authenticateStaff`, `canSeeAdminSection`,
  etc.) — same interface every other admin endpoint in this project
  already relies on.
