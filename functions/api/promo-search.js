/**
 * GET /api/promo-search?codes=CODE1,CODE2
 *
 * Search-only — never writes anything. Reads directly from the shared
 * Promo Code Google Sheet (one workbook, 11 team tabs, each hand-
 * maintained by a different team) and returns every match of the Promo
 * Code column (contains/partial match, not exact — e.g. searching "1500"
 * matches "1500PKR"), grouped by tab, so the dashboard can show "which
 * team's sheet has this code" the same way the reference screenshot did.
 *
 * Requires the sheet to be shared (Viewer is enough) with the service
 * account: reward-form-writer@fifth-trainer-500806-e7.iam.gserviceaccount.com
 *
 * Columns are located by HEADER TEXT, not by a hardcoded column index —
 * see functions/_shared/dynamicSheetColumns.js and
 * PROMO_CODE_LOGIC_NOTES.md. This sheet is edited by hand by several
 * teams, and each of its 11 tabs has broken the "columns are always in
 * the same order" assumption in a different way at one point or another
 * (a missing column shifting everything after it, vertically-merged
 * cells, a section-title row instead of a real header, the header row
 * repeated mid-data, an inserted column) — matching by header text is
 * what makes all of those non-issues instead of silent data corruption.
 *
 * "Start On" has no source column yet in this sheet — always returned as
 * "" until one exists; the frontend shows it as a dash.
 */
import { batchGetValues, getSheetTabTitles } from "../_shared/googleSheets.js";
import { verifyRequest } from "../_shared/accounts.js";
import { PROMO_CODE_SHEET_DEFAULT, getPromoCodeSheetOverride } from "../_shared/promoCodeSheetOverride.js";
import { createColumnMapper } from "../_shared/dynamicSheetColumns.js";

// Read range is intentionally wide (full A1:Z1000, header row included) —
// a narrower range that "should be enough" is exactly what truncated the
// last field on the tab whose columns had shifted right by one. A few
// extra empty columns cost nothing; a truncated real column costs a
// silently-wrong value. Header row is included (not skipped) because
// the mapper scans for the real header itself — it isn't always row 1.
const RANGE = "A1:Z1000";

// Order matters here: for any single column, the FIRST field in this
// list whose pattern matches wins that column. "excluded" is listed
// before "products" so "Excluded Products/GAMES" is claimed by
// `excluded`, not `products` — otherwise the real "Products" column
// would end up empty and "Excluded Products/GAMES" would show up twice.
const FIELDS = [
  ["brand", /brand/],
  ["bonusCode", /bonus\s*code/],
  ["promoCode", /promo\s*code/],
  ["depositRange", /deposit\s*range/],
  ["bonusPercent", /bonus\s*%|bonus\s*percent/],
  ["perSpinValue", /per\s*spin/],
  ["excluded", /excluded/],
  ["maxBonus", /max\s*bonus/],
  ["wager", /wager/],
  ["maxWithdraw", /max\s*withdraw/],
  ["expiredDay", /expired\s*day/],
  ["products", /products/],
  ["groupVip", /group|affiliate|vip/],
  ["expiredOn", /expired\s*on/],
];

// Brand / Bonus Code / Promo Code are what tell rows apart, so they must
// never inherit a value from a merged cell above them (Welcome Call
// Team's tab groups several brand rows under one shared value for the
// other columns via vertical merge — the identity columns themselves
// are never merged).
const columnMapper = createColumnMapper({
  fields: FIELDS,
  requiredField: "promoCode",
  identityFields: ["brand", "bonusCode", "promoCode"],
});

function sheetEditUrl(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
}

// Real tab titles rarely change, so cache them for a few minutes per Worker
// isolate instead of re-fetching metadata on every single search. Keyed by
// sheetId (not just a single slot) because the Promo Code Gsheet admin
// page (see functions/api/admin/promo-code-sheet.js) can swap the active
// sheetId via a KV override — a stale cache for the OLD sheet must never
// get served once a new one is saved.
const tabTitleCache = new Map(); // sheetId -> { titles, expiresAt }
const TAB_CACHE_MS = 5 * 60 * 1000;

async function resolveExistingTabs(env, sheetId) {
  const now = Date.now();
  const cached = tabTitleCache.get(sheetId);
  if (cached && cached.expiresAt > now) return cached.titles;
  const titles = await getSheetTabTitles(env, sheetId);
  tabTitleCache.set(sheetId, { titles, expiresAt: now + TAB_CACHE_MS });
  return titles;
}

// Live-editable (Integration Portal → Promo Code Gsheet admin page) takes
// priority over the hardcoded default — see _shared/promoCodeSheetOverride.js.
// An empty/unset KV means this resolves to exactly the same sheet/tabs this
// endpoint always used, so shipping this override capability can't change
// anything until someone actually saves a new sheet in the admin page.
async function resolveActiveSheet(env) {
  const override = await getPromoCodeSheetOverride(env);
  return override || PROMO_CODE_SHEET_DEFAULT;
}

// Normalizes a tab name for comparison so invisible differences — non-
// breaking spaces, double spaces, fullwidth punctuation, stray
// leading/trailing whitespace — don't cause a false "missing tab" even
// when the name looks identical to the human eye. NFKC folds fullwidth
// parentheses etc. into their plain-ASCII equivalents; \s in JS already
// matches the non-breaking space character.
function normalizeTabName(name) {
  return String(name)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function onRequestGet(context) {
  try {
    return await handleSearch(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleSearch({ request, env }) {
  // Whole hub requires login now — see submit.js for the same note.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const activeSheet = await resolveActiveSheet(env);

  const codes = (new URL(request.url).searchParams.get("codes") || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  // No search yet (e.g. the page's initial load, just to fetch sheetUrl
  // for the "Open Sheet" button) — nothing to look up.
  if (!codes.length) {
    return json({ ok: true, groups: [], sheetUrl: sheetEditUrl(activeSheet.sheetId) });
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return json({ ok: false, error: "Server is missing Google service account credentials." }, 500);
  }

  const needles = codes.map((c) => c.toUpperCase());

  // Google's batchGet is all-or-nothing: a single mistyped/renamed/deleted
  // tab name 400s the ENTIRE request. So resolve which configured tabs
  // actually exist on the live sheet first, and only ever ask for those —
  // a missing tab becomes a warning in the response, not a hard failure.
  let realTitles;
  try {
    realTitles = await resolveExistingTabs(env, activeSheet.sheetId);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 502);
  }
  // Map normalized -> the sheet's actual title string, so once matched we
  // query Google using the REAL title (not our possibly-slightly-off
  // config string) — avoids a second, subtler mismatch at the API call.
  const realByNormalized = new Map(realTitles.map((t) => [normalizeTabName(t), t]));

  const tabsToQuery = []; // { configured, real }
  const missingTabs = [];
  for (const configured of activeSheet.tabNames) {
    const real = realByNormalized.get(normalizeTabName(configured));
    if (real) tabsToQuery.push({ configured, real });
    else missingTabs.push(configured);
  }

  let valueRanges = [];
  if (tabsToQuery.length) {
    try {
      const ranges = tabsToQuery.map(({ real }) => `'${real.replace(/'/g, "''")}'!${RANGE}`);
      valueRanges = await batchGetValues(env, activeSheet.sheetId, ranges);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 502);
    }
  }

  const groups = [];
  tabsToQuery.forEach(({ real }, i) => {
    const rawRows = (valueRanges[i] && valueRanges[i].values) || [];
    const { colMap, dataRows } = columnMapper.prepare(rawRows);
    const col = (field, row) => columnMapper.col(colMap, field, row);

    const matches = [];
    for (const row of dataRows) {
      const promoCode = col("promoCode", row);
      // No identity field = not a real data row (blank row, stray
      // formatting row, section divider, etc.) — skip it.
      if (!promoCode) continue;
      const upperCode = promoCode.toUpperCase();
      // Contains match, not exact — e.g. searching "1500" should surface
      // "1500PKR". Any one of the comma-separated search terms being a
      // substring of the code counts as a hit.
      if (!needles.some((n) => upperCode.includes(n))) continue;
      matches.push({
        brand: col("brand", row),
        bonusCode: col("bonusCode", row),
        promoCode,
        depositRange: col("depositRange", row),
        maxBonus: col("maxBonus", row),
        wager: col("wager", row),
        maxWithdraw: col("maxWithdraw", row),
        expiredDay: col("expiredDay", row),
        products: col("products", row),
        excluded: col("excluded", row),
        groupVip: col("groupVip", row),
        startOn: "", // no source column yet — see file header
        expiredOn: col("expiredOn", row),
      });
    }
    if (matches.length) groups.push({ tab: real, count: matches.length, matches });
  });

  return json({
    ok: true,
    groups,
    sheetUrl: sheetEditUrl(activeSheet.sheetId),
    missingTabs: missingTabs.length ? missingTabs : undefined,
    // Only included when something's missing — lets whoever's debugging
    // this see the sheet's real tab names side-by-side with what's
    // configured, without having to open the sheet.
    actualSheetTabs: missingTabs.length ? realTitles : undefined,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
