# Settings / Maintenance-toggle — integrated into PKR (2026-08-01)

Full write-up of what was added/changed when integrating the
`settings-maintenance-toggle-package` into `HeyVIP-PKR/TBC`. This is a
NEW admin section — nothing existing was removed or renamed.

## What you get

A new **Settings** item in the Account Management sidebar (next to
Deposit Sheet Link), superadmin-only by default, same tier as TG
Group/Channel. It lists all 11 of PKR's real controllable items and lets
you flip each one to **Active / Maintenance / Coming soon**, plus choose
which roles can bypass it while it's off:

```
qa, account_issue, withdraw_issue, risk_issue, promotion_request,
daily_report, genie_issue   (the 7 form modules)
deposit_issue, deposit_backup, tg_reply_threads, promo_code_search
   (the 4 non-form hub features)
```

When an item isn't "Active": its Home-page card / sidebar link goes
grayed out with a breathing badge (🚧 Maintenance / 🔜 Coming soon), AND
— this is the part that actually matters — the matching API endpoint
returns a 403 for anyone whose role isn't in that item's bypass list,
even if they call the API directly instead of clicking through the UI.

## New files

```
functions/_shared/featureStatus.js        KV-backed status store (core logic)
functions/api/admin/feature-status.js     /api/admin/feature-status (view/edit, gated)
functions/api/feature-status.js           /api/feature-status (read-only, any logged-in user)
public/assets/feature-status.css          breathing-light badge styling
public/assets/apply-feature-status.js     client-side gray-out/badge/block-click
```

Storage: same `THREADS_KV` namespace as everything else, under its own
`feature-status:<itemId>` prefix — nothing collides with threads/
accounts/offices/routes. No new secrets, no new bindings, no
`wrangler.toml` changes needed.

## Changed files

- **`functions/_shared/accounts.js`** — added `"settings"` to
  `ADMIN_SECTIONS`/`EDITABLE_ADMIN_SECTIONS`. Falls into the existing
  `defaultSectionsForRank()` tiering automatically (superadmin sees/edits
  everything already includes any new section id) — no other accounts.js
  logic needed touching, and no existing account's access changed.
- **`functions/api/submit.js`** — after the existing `canSeeModule()`
  check, added a `getFeatureStatus()`/`accountCanBypass()` check for the
  submitted module. This is a SEPARATE gate from `allowedModules` — an
  agent can be allowed to see a module and it can still be toggled off
  hub-wide.
- **`functions/api/threads.js`**, **`functions/api/threads/[id].js`** —
  gated on the `tg_reply_threads` item (both the list endpoint and the
  single-thread GET/POST actions).
- **`functions/api/promo-search.js`** — gated on `promo_code_search`.
- **`functions/api/deposit-issue/search.js`**,
  **`functions/api/deposit-issue/update.js`** — gated on `deposit_issue`.
- **`functions/api/deposit-backup/search.js`** — gated on
  `deposit_backup`.
- **`public/index.html`** —
  - loads `feature-status.css` + `apply-feature-status.js`
  - added `data-feature-item="..."` to the 4 Home tool-cards and to each
    dynamically-rendered module sidebar link
  - calls `applyFeatureStatuses()` once the sidebar is built
  - new `subSettings` sidebar item + `"settings"` mode in `openAcctModal`
    (same per-row-save pattern as Deposit Sheet Link/TG Group Channel —
    native `<select>` + role checkboxes, no portal-dropdown needed since
    this modal doesn't have Deposit Sheet Link's scroll-clipping problem)
- **`public/assets/style.css`** — added `.fs-status-select` /
  `.fs-role-grid` / `.fs-role-check` rules, reusing the existing
  `.tgroute-row` / `.route-tag` / `.tgroute-action-btn` classes for
  everything else so the new modal matches the rest of the app visually.

## What was deliberately NOT changed

- `functions/api/telegram-webhook.js` — incoming Telegram messages
  aren't gated; blocking `tg_reply_threads` stops agents from opening
  the dashboard/replying, not Telegram delivery itself.
- `functions/api/screenshot/[[path]].js`,
  `functions/api/attachment/[fileId].js` — unchanged; these serve
  already-existing attachments and aren't a "controllable item" the
  business owner would toggle independently of TG Reply Threads itself.
- The dedicated maintenance/coming-soon **destination pages**
  (`threads.html`, `promo.html`, `deposit-issue.html`,
  `deposit-backup.html`, `form.html`) don't yet show a friendly
  full-page "under maintenance" screen if someone lands there directly
  via URL while blocked — right now they'll just get a 403 JSON error
  surfaced through whatever that page's existing error-note UI is. The
  Home page dimming + click-block covers the normal click-through path;
  a nicer full-page state for direct URL visits would be a good next
  step if you want it.

## How to use it

1. Log in as SuperAdmin/Owner → Account Management → **Settings**.
2. Pick a status for any item, tick which roles can still get in while
   it's off, hit Save. Takes effect on the very next request — no
   redeploy.
3. "Reset to Active" just deletes the override (same as every other
   KV-override feature here) — safe, reversible, no data loss.
