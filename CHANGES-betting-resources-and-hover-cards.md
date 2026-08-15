# HeyVIP Betting Rules + Home card hover redesign — integrated into PKR (2026-08-14)

Full write-up of what was added/changed integrating the HeyVIP Betting
Rules link-list feature and the 7-card hover/3-column redesign into
`HeyVIP-PKR/TBC`. Nothing existing was removed or renamed; one long-
standing layout bug (see "The real bug" below) got fixed as a side
effect of widening the home grid.

## What you get

A new **HeyVIP Betting Rules** hub card (7th card, bottom-right of row 2)
that opens `/betting-resources.html` — a simple two-panel reference page,
NOT a form module:

- **Left — "HeyVIP Betting Resources"**: one fixed link (name/url/icon),
  admin-editable.
- **Right — "Results Finding Websites"**: any number of links, each with
  its own name/url/icon, add/remove freely.

Content lives entirely in KV and is editable without a redeploy via a
new **🔗 Betting Resources Links** item in the Account Management
sidebar (superadmin-only by default, same tier as TG Group/Channel —
Owner can grant it to a specific lower-ranked account same as any other
Account-Management-Access section).

Home page cards also got a redesign: 3-column layout (was 2), owner-
specified row order, and hover effects (lift + accent-color border +
rotating gradient ring + one-shot light sweep + "Open →" label).

## New files

```
functions/_shared/bettingResources.js       KV read/write + defaults/validation (core logic)
functions/api/betting-resources.js          GET /api/betting-resources — any logged-in account
functions/api/admin/betting-resources.js    GET/POST /api/admin/betting-resources — bettingLinks-gated
public/betting-resources.html               the page itself
```

Storage: same `THREADS_KV` namespace as everything else, one key —
`betting-resources:config` — holding `{ rules, results, updatedAt,
updatedBy }` as a single JSON blob. No new bindings, no new secrets.
Full-overwrite save (both `rules` and `results` written together), not
per-link — link count is small and edits are infrequent, so this is
deliberately simpler than threads.js's list()+metadata machinery.

Each link (the single `rules` link and every `results` link) carries its
own single-emoji `icon`, defaulting to 📄 (rules) / 🔗 (results) for
older saves made before this field existed — read-time sanitization, not
a migration, so nothing had to run once against existing KV data.

## Changed files

| File | What changed |
|---|---|
| `functions/_shared/accounts.js` | Added `bettingLinks` to `ADMIN_SECTIONS` / `EDITABLE_ADMIN_SECTIONS`. Not added to any rank bucket in `defaultSectionsForRank()`/`defaultEditForRank()` — falls through to "superadmin -> all", same pattern every other section used the first time it was introduced. |
| `functions/_shared/featureStatus.js` | Registered `betting_resources` in `FEATURE_STATUS_ITEMS` (🎰). Unlike the very first pass at this feature, the GET endpoint actually enforces it now — see below. |
| `functions/api/betting-resources.js` | Calls `getFeatureStatus(env, "betting_resources")` and returns 503 when not active and the caller can't bypass — mirrors `announcements.js`'s check exactly. This closes the one real gap from the first draft of this feature (status was registered in Settings but never actually checked). |
| `public/index.html` | Cards reordered into 3 rows per the owner's spec; new HeyVIP Betting Rules card added; new sidebar subitem + full admin panel (see below); `ADMIN_SECTIONS_LIST`/`EDITABLE_ADMIN_SECTIONS` client mirrors updated to match `accounts.js`. |
| `public/assets/style.css` | `.hub-main .inner` 480px → 980px (the real bug, see below); `.tool-cards` rebuilt as a 3-column responsive grid; hover ring/sweep/"Open →" added; new `.br-*` rules for the results page and the admin editor. |

## Card order (owner spec)

```
Row 1: TG Reply Threads | Deposit Issue      | Deposit Backup
Row 2: Promo Code Search | Announcement       | HeyVIP Betting Rules
Row 3: Active Agents
```

## The real bug — `.inner { max-width: 480px }`

Several rounds of resizing `.tool-cards` itself (tried 780px, then
960px) had **zero visible effect** — cards stayed roughly 152px wide no
matter what. The actual bottleneck was a pre-existing, unrelated-looking
rule one level up:

```css
.hub-main .inner { max-width: 480px; }
```

`#viewHome` (the home card area) carries the `inner` class, so this had
been capping the *entire content column* at 480px the whole time — 3
columns squeezed into that is ~152px each, which is exactly the
symptom. `.tool-cards`' own `max-width` was never the problem.

Confirmed `.inner` under `.hub-main` is used in exactly two places
project-wide (home page + the new `betting-resources.html`), so raising
it to 980px is safe everywhere it applies. **Lesson for next time:** if
a grid/flex child "won't get wider no matter what," check every
ancestor's `max-width` before touching the child's own rules again —
this cost a few rounds of guessing that a two-minute ancestor check
would have skipped.

Two things that looked related during debugging but weren't the cause,
for the record:
- **Cache** — `/assets/*` has a year-long immutable cache; forgetting to
  run `node update-asset-versions.js` after a CSS edit is a real and
  separate issue (this integration DID run it — see below), but it
  wasn't why the width was stuck.
- **`aspect-ratio`** — tried briefly to stop cards squashing into
  squares, then suspected (wrongly) of causing a rendering glitch. Left
  out of this integration in favor of a plain `min-height: 108px` — this
  project has no real browser in its dev/verification loop (owner
  screenshots only), and `aspect-ratio`'s interaction with `display:flex`
  + CSS Grid `1fr` tracks is a genuine cross-browser rough edge not worth
  the risk here.

The rotating gradient ring and sweep animation are a comparable
risk-bearing choice (same "no real browser to verify against" caveat),
but they're explicitly requested, standard, and widely supported in
current evergreen browsers — kept in, flagged here in case a future
visual bug report ever needs to rule them in or out.

## Admin panel layout

Mirrors the existing TG Group/Channel panel's shape (left list, right
form) rather than inventing a new pattern:

- **Left**: 2 fixed categories — "HeyVIP Betting Resources" /
  "Results Finding Websites" (not brands — this feature has no brand
  routing).
- **Right**: Icon / Name / URL fields side-by-side (`.edit-fields-row`,
  collapses to stacked under 480px). Rules category is a single row;
  Results category is a card per link with a remove (✕) button and a
  "+ Add link" button at the bottom.
- **Save**: one global footer button (not per-row like TG Group/Channel)
  — writes both categories together in one POST. Switching the left list
  syncs the currently-visible form back into in-memory state first, so
  an edit on one side is never lost by looking at the other.

## A near-miss: `data-route` on the new card

First draft of the card copied the `data-feature-item` + `data-route`
pattern from the other 6 cards (`data-route="betting_resources"`).
`spa-shell.js`'s click listener unconditionally `preventDefault()`s any
click on `[data-route="..."]` and hands it to `mount(view, ...)` —
`mount()` only proceeds for views listed in its own `ROUTES` table (see
`spa-shell.js`), so an unregistered `data-route` value means the click
gets swallowed and nothing happens: no SPA mount (not registered) AND no
normal navigation (prevented). Caught before shipping by tracing what
the shell's click handler actually does with an unknown route, not by
visual inspection. Fixed by dropping `data-route` from this card
entirely — it just does a plain full-page navigation to
`/betting-resources.html`, same as `activeAgentsCard`'s pre-existing
`href="#"` pattern but with a real destination. Registering
`betting_resources` in `spa-shell.js`'s `ROUTES` (for a smooth in-app
transition like the other 6 cards get) is a reasonable follow-up but
wasn't attempted here — getting a new route's `select` fragment list
right needs verifying against the live DOM the shell extracts from, and
this environment has no real browser to check that against.

## Known state after this integration

- KV has no real link data yet — needs filling in via the new admin
  panel (name/url/icon for the Rules link, however many Results links
  are wanted).
- `node update-asset-versions.js` was run as part of this integration —
  every HTML file's `?v=` hashes are already current, nothing further
  needed before deploy.
- Still no real browser in this dev environment — the hover ring/sweep/
  3-column grid are unverified beyond visual code review. Recommend
  checking on a real deploy preview before treating the visual polish as
  final.

## Follow-up: admin panel restyled to match owner-provided mockup (2026-08-14)

The Betting Resources Links panel's form layout was reworked a second
time after the owner shared a reference mockup screenshot showing a
more polished treatment than the first pass:

- Each editable link (the single Rules link, and every Results link)
  now renders inside its own small card (`.br-form-card`) with a header
  row — a boxed icon preview + a one-line description of which home-card
  panel that link feeds ("Single link — shown in the left panel" /
  "Link #N — shown in the right panel"). First pass had no such card or
  header, just bare fields.
- Icon / Name / URL are now ONE row (`.edit-fields-row` with 3
  `.field`s) instead of the first pass's icon+name row followed by a
  separate URL row below it.
- The footer note text now matches the mockup's wording exactly:
  *"Powers the "HeyVIP Betting Rules" home card — left panel is a single
  link, right panel is the link list. Click Save (bottom) to publish
  changes to both sections at once."*
- The Save button needed NO change — `.btn-submit` (used by
  `acctModalSave` already, same button every other Account Management
  section's global Save uses) is already the gradient indigo→sky-blue
  pill the mockup shows. Only the standalone preview artifact (a static
  mockup outside the actual app, built to demo the layout without a live
  deploy) had used a plain gold button instead and needed updating to
  match.
- `.field label`'s existing uppercase/bold/letter-spaced styling
  (already used everywhere else in the app) means "Icon"/"Name"/"URL" in
  the markup render as "ICON"/"NAME"/"URL" automatically — no separate
  CSS needed for that part, it was already project-wide.

## Second follow-up: dropped the per-row header banner in Results (2026-08-14)

Two more reference screenshots — the live panel with a real, longer
Results list, and a second mockup of that same list — showed the
per-link header line added in the previous pass ("Link #N — shown in
the right panel", boxed icon + border-bottom divider) didn't hold up
once there were more than a couple of links: with a dozen+ results
rows it's a lot of repeated boilerplate text eating vertical space in
an already-scrolling list, and the second mockup dropped it entirely.

- Results rows (`.br-result-row`) are now a single flex line — ICON /
  NAME / URL fields (each still with its own label, unchanged) plus a
  remove button, no header banner and no `.br-form-card` wrapper/divider
  around each one.
- The remove button changed from a plain "✕" in a bordered circle to a
  filled reddish-pink 🗑 square (`.br-result-remove`), inline at the end
  of the row instead of floated in a header — matches the second
  mockup's trash-icon treatment.
- The "HeyVIP Betting Resources" (single link) category is UNCHANGED —
  it still uses `.br-form-card` with the header line, per the first
  mockup, since that one's only ever a single card and the extra
  context line isn't a density problem there.
- `renderBettingLinks()`'s results branch, `syncBettingLinksFormIntoData()`,
  and the remove-button click handler all updated together (class rename
  `.br-result-card` → `.br-result-row`) — there's no leftover reference
  to the old header-card markup for this category.

