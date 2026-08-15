# Settings Maintenance/Coming-soon removal + Deposit Backup "Last month" removal (2026-08)

## 1. Settings → Maintenance/Coming soon toggle — removed entirely

Per direct business-owner request ("already useless"). This wasn't just
hidden from the Settings modal — it was pulled out of the whole app,
front-to-back:

**Deleted files:**
- `functions/_shared/featureStatus.js` (the KV-backed status store)
- `functions/api/feature-status.js` (public read endpoint)
- `functions/api/admin/feature-status.js` (admin read/write endpoint)
- `public/assets/apply-feature-status.js` (Home-card gray-out/badge script)
- `public/assets/feature-status.css`
- `public/assets/settings-dropdown.js` / `settings-dropdown.css` (the
  status/role dropdown widget — this feature was its only user)

**Edited to remove the gate check + import:**
- `functions/api/submit.js`
- `functions/api/betting-resources.js`
- `functions/api/deposit-issue/search.js` and `update.js`
- `functions/api/announcements.js`
- `functions/api/deposit-backup/search.js`
- `functions/api/threads/[id].js` (also removed the now-orphaned
  `checkThreadsFeatureGate()` helper)
- `functions/api/promo-search.js`
- `functions/api/threads.js`

**Edited in `public/index.html`:**
- Removed the 4 `<link>`/`<script>` includes for the deleted assets.
- Removed `data-feature-item="..."` from all 6 Home tool cards.
- Removed the `applyFeatureStatuses()` call that ran the gray-out pass.
- Settings modal: `loadFeatureStatus()`/`renderFeatureStatus()`/
  `saveFeatureStatusRow()` and their `FS_*` constants are gone, replaced
  by a much smaller `renderSettingsPanel()` that only renders the two
  unrelated features that happened to live in the same modal:
  **@ Tag Username — historical backfill** and **Announcement rotation
  speed**. Both work exactly as before.

**Edited elsewhere:**
- `public/assets/spa-shell.js` — removed the two deleted scripts from
  `SHELL_OWNED_SCRIPTS`.
- `public/assets/style.css` — removed the now-dead `.fs-fields`/
  `.fs-dropdown` sizing rules.

Nothing else changes: `allowedAdminSections`/`adminSectionEditAccess`
and the `"settings"` admin section itself are untouched — Settings still
exists, it just no longer has a maintenance toggle in it.

## 2. Deposit Sheet Link → "Deposit Backup — Last month" row removed

The read-only "Last month" row and its "Transfer from This Month" button
are gone from the Deposit Sheet Link admin modal. Only **📊 Deposit
Issue** and **💻 Deposit Backup — This month** remain.

**Scope note:** this is a UI-only removal. `functions/api/deposit-backup/
search.js` (the actual search tool on `/deposit-backup.html`) is
untouched — if a brand already has a Last Month sheet configured in KV,
it's still searched alongside This Month exactly as before. What's
gone is the ability to *view, clear, or roll over* that Last Month link
from this panel — there's no more "Transfer" button to refresh it going
forward. The backend `rollBackup` action in
`functions/api/admin/deposit-sheets.js` is also left in place
(unreachable from the UI now, but not deleted) in case this needs
reverting.

If you'd also like Last Month dropped from the search itself (or the
backend endpoint fully removed), that's a separate, slightly bigger
change — just say so.
