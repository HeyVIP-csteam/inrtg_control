/**
 * POST /api/deposit-issue/search
 *
 * Live search across one brand's (or, with no `brand`, every brand the
 * account can see) Deposit Issue Google Sheet. Modeled on
 * promo-search.js's tab-resolution/caching pattern (batchGetValues +
 * getSheetTabs, so a mistyped/renamed tab 400s only that one lookup, not
 * the whole request) plus submit.js's brand-permission gate.
 *
 * Every brand starts fully unconfigured — until a link is saved for it
 * through the "Deposit Sheet Link" admin page (Account Management →
 * Deposit Sheet Link), searching that brand returns "not configured"
 * rather than guessing or reading the wrong sheet. There is no
 * hardcoded default sheet for any brand.
 *
 * "All Brands" (no `brand` in the request) fans the search out across
 * every visible brand's sheet in one request. With 5 brands today this
 * is well within Cloudflare's subrequest budget — revisit (e.g. make
 * "All Brands" directory-only, like the sheet-links.js endpoint) if this
 * project ever grows toward dozens of brands.
 */
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import { getDepositSheetOverride, DEPOSIT_HIDDEN_BRANDS } from "../../_shared/depositSheets.js";
import { batchGetValues, getSheetTabs } from "../../_shared/googleSheets.js";
import { getAccessToken } from "../../_shared/googleOAuth.js";

// Must match MODULE_SLOT in functions/api/admin/deposit-sheets.js and
// functions/api/deposit-issue/{update,sheet-links}.js.
const MODULE_SLOT = "depositIssue";

// Column layout — confirmed from a real screenshot of the INR Deposit
// Support sheet (2026-08-01). Column H (no header, checkbox-formatted,
// data shows "forwarded") is deliberately skipped — not surfaced
// anywhere below; add it back here if it turns out to matter later.
const COLS = {
  date: "A",
  time: "B",
  username: "C",
  pg: "D",
  utr: "E",
  slip: "F",
  pgStaffName: "G",
  // H — skipped, see comment above
  pgTid: "I",
  slipAmount: "J",
  status: "K",
  followUpTimes: "L",
  chatIds: "M",
  agentUpi: "N",
  pgRemarks: "O",
  csRemarks: "P", // the ONLY CS-editable column — see update.js
  paymentStatus: "Q",
  orderId: "R",
  picName: "S",
  cartId: "T",
  amount: "U",
  statusFinal: "V", // sheet has two "Status" columns (K and V) — distinct keys, same display label
  upi: "W",
};
const LAST_COL = "W"; // must match the last key in COLS above
const MAX_RESULTS = 500; // global cap across ALL brands searched in one request

function normalizeTabName(name) {
  return String(name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Sortable epoch-ms timestamp built from Date (col A) + Time (col B).
// Unparseable/missing dates sort to the very bottom (return 0) rather
// than throwing or being dropped.
function sortTimestamp(dateRaw, timeRaw) {
  const dm = String(dateRaw || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return 0;
  const tm = String(timeRaw || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const hh = tm ? tm[1].padStart(2, "0") : "00";
  const mm = tm ? tm[2] : "00";
  const ss = tm ? tm[3] || "00" : "00";
  const ts = Date.parse(`${dm[1]}-${dm[2]}-${dm[3]}T${hh}:${mm}:${ss}`);
  return Number.isNaN(ts) ? 0 : ts;
}

// Date (col A, "YYYY-MM-DD") + Time (col B, "H:MM:SS") combined into a
// single day-first display string, matching the rest of the hub's
// convention.
function formatRequestDateTime(dateRaw, timeRaw) {
  let d = String(dateRaw || "").trim();
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) d = `${m[3]}/${m[2]}/${m[1]}`;
  const t = String(timeRaw || "").trim();
  return d && t ? `${d} ${t}` : d || t;
}

// Real tab titles/gids rarely change — cache per Worker isolate for a
// few minutes instead of re-fetching metadata on every search. Keyed by
// sheetId since "All Brands" mode may query several different sheets in
// one request.
const tabCache = new Map(); // sheetId -> { tabs: [{title, gid}], expiresAt }
const TAB_CACHE_MS = 5 * 60 * 1000;

async function resolveExistingTabs(env, sheetId, token) {
  const now = Date.now();
  const cached = tabCache.get(sheetId);
  if (cached && cached.expiresAt > now) return cached.tabs;
  const tabs = await getSheetTabs(env, sheetId, token);
  tabCache.set(sheetId, { tabs, expiresAt: now + TAB_CACHE_MS });
  return tabs;
}

function colIndex(letter) {
  let n = 0;
  for (let i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n - 1;
}

export async function onRequestPost(context) {
  try {
    return await handleSearch(context);
  } catch (e) {
    return json({ ok: false, error: `Search failed: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleSearch({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    return json({ ok: false, error: "Server is missing Google OAuth credentials." }, 500);
  }
  let token;
  try {
    token = await getAccessToken(env);
  } catch (e) {
    return json({ ok: false, error: `Google OAuth error: ${String((e && e.message) || e)}` }, 502);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const raw = ((body && body.query) || "").trim();
  if (!raw) return json({ ok: false, error: "Missing query." }, 400);
  const requestedBrand = ((body && body.brand) || "").trim(); // "" = All Brands

  const queries = raw.split(/[\n,]+/).map((q) => q.trim()).filter(Boolean).map((q) => q.toLowerCase());
  if (!queries.length) return json({ ok: false, error: "No valid search terms." }, 400);

  const allBrandIds = Object.keys(BRANDS).filter((id) => !DEPOSIT_HIDDEN_BRANDS.includes(id));
  if (requestedBrand) {
    if (!BRANDS[requestedBrand] || DEPOSIT_HIDDEN_BRANDS.includes(requestedBrand)) {
      return json({ ok: false, error: `Unknown brand "${requestedBrand}".` }, 400);
    }
    if (!canSeeBrand(account, BRANDS[requestedBrand].name)) {
      return json({ ok: false, error: "You don't have access to this brand." }, 403);
    }
  }
  const brandIdsToSearch = (requestedBrand ? [requestedBrand] : allBrandIds)
    .filter((id) => canSeeBrand(account, BRANDS[id].name));

  const targets = []; // { brandId, brandName, sheetId, tabNames }
  const unconfiguredBrands = [];
  for (const brandId of brandIdsToSearch) {
    const override = await getDepositSheetOverride(env, MODULE_SLOT, brandId);
    if (override) targets.push({ brandId, brandName: BRANDS[brandId].name, sheetId: override.sheetId, tabNames: override.tabNames });
    else unconfiguredBrands.push(BRANDS[brandId].name);
  }

  if (requestedBrand && !targets.length) {
    return json({ ok: true, results: [], notConfigured: true, brand: requestedBrand });
  }

  const results = [];
  const tabWarnings = []; // [{ brand, missingTabs, actualSheetTabs, error? }]

  for (const target of targets) {
    if (results.length >= MAX_RESULTS) break;

    let realTabs;
    try {
      realTabs = await resolveExistingTabs(env, target.sheetId, token);
    } catch (e) {
      tabWarnings.push({ brand: target.brandName, missingTabs: target.tabNames, actualSheetTabs: [], error: String((e && e.message) || e) });
      continue;
    }
    const realByNormalized = new Map(realTabs.map((t) => [normalizeTabName(t.title), t]));
    const tabsToQuery = []; // [{title, gid}]
    const missingTabs = [];
    for (const configured of target.tabNames) {
      const real = realByNormalized.get(normalizeTabName(configured));
      if (real) tabsToQuery.push(real);
      else missingTabs.push(configured);
    }
    if (missingTabs.length) tabWarnings.push({ brand: target.brandName, missingTabs, actualSheetTabs: realTabs.map((t) => t.title) });
    if (!tabsToQuery.length) continue;

    // One batchGet per sheet (covers every configured tab on it) instead
    // of one fetch per tab — fewer subrequests, matters once "All
    // Brands" mode is fanning out across several sheets in one request.
    let valueRanges;
    try {
      const ranges = tabsToQuery.map(({ title }) => `'${title.replace(/'/g, "''")}'!A2:${LAST_COL}`);
      valueRanges = await batchGetValues(env, target.sheetId, ranges, token);
    } catch (e) {
      tabWarnings.push({ brand: target.brandName, missingTabs: [], actualSheetTabs: [], error: `Sheets API error reading "${target.brandName}": ${String((e && e.message) || e)}` });
      continue;
    }

    tabsToQuery.forEach(({ title: tab, gid }, tabI) => {
      if (results.length >= MAX_RESULTS) return;
      const rows = (valueRanges[tabI] && valueRanges[tabI].values) || [];
      rows.forEach((row, i) => {
        if (results.length >= MAX_RESULTS) return;
        const get = (colLetter) => row[colIndex(colLetter)] || "";
        const pgTid = get(COLS.pgTid);
        const utr = get(COLS.utr);
        const username = get(COLS.username);
        const orderId = get(COLS.orderId);
        // Match if ANY query is a substring of PG TID, UTR, Username, or Order ID.
        const haystack = (pgTid + " " + utr + " " + username + " " + orderId).toLowerCase();
        if (!queries.some((q) => haystack.includes(q))) return;

        const rowIndex = i + 2; // header is row 1
        results.push({
          _sortTs: sortTimestamp(get(COLS.date), get(COLS.time)),
          brand: target.brandId,
          brandName: target.brandName,
          tabName: tab,
          sheetId: target.sheetId,
          rowIndex,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${target.sheetId}/edit#gid=${gid}&range=A${rowIndex}`,
          transaction: pgTid,
          requestTime: formatRequestDateTime(get(COLS.date), get(COLS.time)),
          username,
          pg: get(COLS.pg),
          utr,
          slip: get(COLS.slip),
          pgStaffName: get(COLS.pgStaffName),
          slipAmount: get(COLS.slipAmount),
          status: get(COLS.status),
          followUpTimes: get(COLS.followUpTimes),
          chatIds: get(COLS.chatIds),
          agentUpi: get(COLS.agentUpi),
          pgRemarks: get(COLS.pgRemarks),
          csRemarks: get(COLS.csRemarks),
          paymentStatus: get(COLS.paymentStatus),
          orderId,
          picName: get(COLS.picName),
          cartId: get(COLS.cartId),
          amount: get(COLS.amount),
          statusFinal: get(COLS.statusFinal),
          upi: get(COLS.upi),
        });
      });
    });
  }

  // Newest first — matters most in "All Brands" mode, where results from
  // several different brands would otherwise stay grouped by brand/tab
  // order instead of interleaved by actual transaction time.
  results.sort((a, b) => b._sortTs - a._sortTs);
  results.forEach((r) => { delete r._sortTs; });

  return json({
    ok: true,
    results,
    tabWarnings: tabWarnings.length ? tabWarnings : undefined,
    unconfiguredBrands: !requestedBrand && unconfiguredBrands.length ? unconfiguredBrands : undefined,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
