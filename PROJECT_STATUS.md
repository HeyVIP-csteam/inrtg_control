# PROJECT STATUS — Issue Submission Hub (INR CS Team)

Paste this whole document as the first message in a new conversation, along
with the attached `telegram-issue-hub.zip`. That gives the new chat the
complete current state of the project.

## What this is
A web form → Telegram bot + Google Sheets ticketing system for INR-market
CS teams (BetVisa, Betjili, Crickex, Jeetway, Mostplay). Deployed on
Cloudflare Pages.

- **GitHub repo:** `HeyVIP-csteam/inrtg_control`
- **Live URL:** `inrtg-control.pages.dev`
- **Deploy method:** GitHub web upload (drag the `public/` and `functions/`
  folders themselves into "Add file → Upload files", not their contents —
  wrong drag depth has repeatedly caused duplicate/misplaced files)

## Architecture
- **Frontend:** static HTML/CSS/JS in `public/` — no build step
- **Backend:** Cloudflare Pages Functions in `functions/`
- **Google Sheets writes:** service account
  `reward-form-writer@fifth-trainer-500806-e7.iam.gserviceaccount.com`
  (must be shared as Editor on every new Sheet used)
- **File storage:** R2 bucket `inr-issuescreenshot`, bound as
  `SCREENSHOTS_BUCKET`, served back out via `/api/screenshot/<key>`
- **Secrets set in Cloudflare (Settings → Environment variables, Production):**
  `TELEGRAM_BOT_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
  `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `BRAND_EDIT_PASSWORD`

## Key files
| File | Purpose |
|---|---|
| `public/assets/schemas.js` | Brand list + every module's form fields (incl. conditional `showIf`, `optionsByBrand`, `fixedAmounts`, `generate` TID button) |
| `public/assets/app.js` | Renders the form dynamically from schemas.js; conditional fields, brand-dependent dropdowns, amount auto-lock, file uploads, TID generate button |
| `public/assets/style.css` | All styling — dark starfield theme (default) + light glass theme, topbar, brand row, sidebar |
| `public/assets/theme.js` | Theme toggle (dark/light, saved via localStorage) + live clock |
| `public/index.html` | Hub page — topbar, editable brand pills (logo/link), sidebar module list |
| `public/form.html` | Generic form page, driven by `?module=<id>` |
| `functions/api/submit.js` | Main submission handler — builds Telegram message, sends photo(s)+caption, writes to Sheets |
| `functions/_shared/routing.js` | ALL per-brand/per-module config: Telegram chat/topic IDs, Sheet layouts, message templates, TID sequences, auto-remarks |
| `functions/_shared/googleSheets.js` | Google Sheets API helpers (auth, append, date-paired write for Daily Report, TID sequence lookup) |
| `functions/_shared/r2.js` | R2 upload helper for screenshots |
| `functions/api/next-tid.js` | Generates the next TID for Promotion Request |
| `functions/api/brand-config.js` | Password-protected brand logo/link editor (stored in R2 as `brand-config.json`) |
| `functions/api/screenshot/[[path]].js` | Serves any R2 object back out (screenshots AND brand logos) |

## Modules — all 6 fully built (web form + Telegram + Sheets)
1. **QA** — Motive-based (6 types incl. Domain Issue with its own field set), writes to `QA OTP & Domain` tab
2. **Account Issue** — 10 issue types, each with its own conditional fields, dynamic emoji-styled Telegram message, writes to `Account Issue` tab
3. **Risk Issue** — 11 issue types, dynamic emoji Telegram message, auto-remark lookup (certain selections auto-fill Remark + append a 💬 note), writes to `Risk Issue` tab
4. **Promotion Request** — Brand-dependent Promotion dropdown, Tier/Deposits-based Amount auto-lock, TID auto-generate button, 8 brand+promotion combos each with their own Sheet + Telegram template (BetVisa/Crickex/Betjili/Mostplay/Jeetway × Birthday Bonus/Review Bonus variants)
5. **Daily Report** — Day/Night shift, writes into paired left/right column blocks on the SAME row by date, Telegram uses "Nil" placeholder + loose spacing
6. **Genie Issue** — Simple flat form (Issue Details, Chat Link(s), PIC), writes to `Genie Issues` tab

## Recent additions (this session, not yet fully confirmed working)
- Hub redesign: dark starfield theme, topbar with logo/clock, brand pill row, translucent "glass" panels (light theme)
- Uploaded HeyVIP logo (`public/assets/img/logo.webp`), wordmark renamed to "INR CS TEAM - TBC"
- Brand pill edit feature: hover shows a pencil icon → password-gated modal to upload a custom logo + set a link per brand, shared for everyone via R2

## Known issue being debugged when this handoff was written
Brand logo upload (via the edit modal) reports "Saved" successfully but
`logoUrl` never appears in the saved config — only `link` gets saved. Added
a visible "Selected: filename.png (XX KB)" confirmation under the file
input in `index.html` to check whether file selection itself is working —
**this hasn't been confirmed yet, still needs testing.**

## Recurring non-code gotcha (not a bug, just a process reminder)
GitHub web upload has repeatedly caused: (a) duplicate files when the same
batch gets dragged in twice, (b) wrong file content landing under the wrong
filename (this happened once — `style.css` on GitHub briefly contained
`index.html`'s content). Always sanity-check line count / content after
upload if something looks broken after a deploy, before assuming the code
itself is wrong.
