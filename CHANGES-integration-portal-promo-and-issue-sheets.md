# Integration Portal — Promo Code Gsheet + Issue Submission Gsheet

Adds two new rows to the existing Integration Portal sidebar dropdown,
following the exact same "KV override + code default" pattern as Deposit
Sheet Link / Web Link.

This version is built on the complete project upload (the one with real
`functions/_shared/*.js` content) — `accounts.js` is now fully wired, so
there's no manual step left.

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

### `functions/_shared/accounts.js` (edited)
- `ADMIN_SECTIONS_LIST`: two new entries, `promoCodeSheet` and
  `issueSubmissionSheet`, both `floorRank: ROLE_RANK.superadmin` — same
  tier as `depositSheets`/`webLinks`.
- `ADMIN_SECTIONS_DEFAULT_SEEN.superadmin` / `ADMIN_SECTIONS_DEFAULT_EDIT.superadmin`:
  both new ids added, matching the other Integration Portal items — a
  SuperAdmin sees + can edit both by default (no Owner action needed
  beyond what's already required for the group itself).
- `EDITABLE_ADMIN_SECTIONS`: both new ids added (Can-Edit is a
  meaningful distinct state for both, same as the other 4).
- Note: this only affects the per-item Can-See/Can-Edit layer. The
  sidebar group itself is STILL gated behind the separate
  `integrationPortal` entry in `OWNER_TOPIC_ITEMS`, which defaults to
  nobody (not even superadmins) until the Owner explicitly grants it per
  account — unchanged, not modified here.

### `public/index.html` (edited)
- Two new sidebar sub-items under the existing Integration Portal group
  (`subPromoCodeSheet`, `subIssueSubmissionSheet`), gated the same way as
  the other four.
- `ADMIN_SECTIONS_LIST`/`EDITABLE_ADMIN_SECTIONS` (client-side mirror of
  `accounts.js`) updated with the two new ids, kept in sync with the
  server file above.
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

Every other file in the project — including `routing.js`, `googleSheets.js`,
`threads.js`, `messageBuilders.js`, and the rest of `_shared/` — is
untouched, content identical to what was uploaded. Nothing was deleted.
