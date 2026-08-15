import { getAccessToken } from "../../_shared/googleOAuth.js";
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { PKR_BRANDS, getDepositSheetOverride } from "../../_shared/depositSheets.js";

// Stable identifier for this module's slot in the "Deposit Sheet Link"
// admin page — must match MODULE_SLOT in functions/api/admin/deposit-sheets.js.
const MODULE_SLOT = "depositIssue";

/**
 * ══════════════════════════════════════════════════════════════════
 *  HARDCODED DEFAULT — only used for Crickex, and only if nothing's
 *  been saved for Crickex through the "Deposit Sheet Link" admin page
 *  yet. Every other brand has NO hardcoded fallback: until someone
 *  saves a link for that brand in the admin page, searching that brand
 *  returns "not configured" rather than guessing.
 * ══════════════════════════════════════════════════════════════════
 */
const DEFAULT_CRICKEX = { sheetId: "1HByPuZMuuYZL9S5fPPGjb8RAmCwNVgKXvuLgVBbVM-E", tabNames: ["CX PKR"] };

// Resolves the { sheetId, tabNames } to use for ONE brand: live KV
// override if one exists, else the hardcoded Crickex default, else null
// ("not configured yet" — every non-Crickex brand until it's set up).
async function resolveBrandSheet(env, brandId) {
  const override = await getDepositSheetOverride(env, MODULE_SLOT, brandId);
  if (override) return { sheetId: override.sheetId, tabNames: override.tabNames };
  if (brandId === "crickex") return DEFAULT_CRICKEX;
  return null;
}

// Column layout confirmed from the real sheet (row 1 = headers, data
// starts row 2). If a department ever reorders columns, update here.
// (Assumes every brand's sheet uses this same layout — true for Crickex
// today; revisit if a future brand's sheet turns out to differ.)
const COLS = {
  transactionId: "A",
  requestTime: "B",
  channel: "C",
  agentNumber: "D",
  username: "E",
  date: "F",
  imageLink: "G",
  transactionError: "H",
  statusPG: "I",
  cartId: "J",
  reference: "K",
  cashOutNumber: "L",
  amount: "M",
  supportPIC: "N",
  pg: "O",
  csPIC: "P",
  playerContactNo: "Q",
  statusCS: "R",
  correctUid: "S",
  playersCartId: "T",
  paymentStatus: "U",
  pytPsd: "V",
  remark: "W",
};
const LAST_COL = "W"; // must match the last key in COLS above
const MAX_RESULTS = 500; // global cap across ALL brands searched in one request

// Same normalization promo-search.js uses — folds invisible differences
// (double spaces, stray whitespace, fullwidth punctuation) so a tab name
// that LOOKS identical to the human eye still matches.
function normalizeTabName(name) {
  return String(name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Sortable epoch-ms timestamp built from Date (col F) + Request Time
// (col B) — results are sorted newest first before being returned (see
// bottom of handleSearch), instead of staying grouped by
// brand/tab/sheet-row order. Rows with an unparseable/missing date sort
// to the very bottom (return 0 — effectively "1970") rather than
// throwing or being dropped.
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

// Sheet's real tab titles rarely change — cache per Worker isolate for a
// few minutes instead of re-fetching metadata on every search. Keyed by
// sheetId (a Map, since "All Brands" mode may query several different
// sheets in one request). Now also carries each tab's `gid` (its
// internal numeric sheetId — different from the spreadsheet's own ID),
// needed to build a direct link straight to that specific tab in Google
// Sheets: https://docs.google.com/spreadsheets/d/<sheetId>/edit#gid=<gid>
const tabTitleCache = new Map(); // sheetId -> { tabs: [{title, gid}], expiresAt }
const TAB_CACHE_MS = 5 * 60 * 1000;

async function resolveExistingTabs(accessToken, sheetId) {
  const now = Date.now();
  const cached = tabTitleCache.get(sheetId);
  if (cached && cached.expiresAt > now) return cached.tabs;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties(title,sheetId)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Could not read sheet tab list: ${data.error?.message || res.status}`);
  const tabs = (data.sheets || []).map((s) => ({ title: s.properties.title, gid: s.properties.sheetId }));
  tabTitleCache.set(sheetId, { tabs, expiresAt: now + TAB_CACHE_MS });
  return tabs;
}

export async function onRequestPost(context) {
  try {
    return await handleSearch(context);
  } catch (e) {
    return json({ ok: false, error: `Search failed: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleSearch({ request, env }) {
  // Same gate every other protected endpoint uses (see submit.js) — requires
  // a valid X-Agent-Token from a logged-in, non-locked account whose office
  // IP still matches. The frontend's authguard.js/authFetch() already
  // attaches this header automatically.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const raw = (body && body.query || "").trim();
  if (!raw) return json({ ok: false, error: "Missing query." }, 400);
  const requestedBrand = (body && body.brand || "").trim(); // "" = All Brands

  // Same comma/newline-separated multi-query parsing as the rest of the hub.
  const queries = raw.split(/[\n,]+/).map((q) => q.trim()).filter(Boolean).map((q) => q.toLowerCase());
  if (!queries.length) return json({ ok: false, error: "No valid search terms." }, 400);

  // Figure out which brand(s) to actually search, and resolve each one's
  // { sheetId, tabNames } up front. Brand-level permission (same
  // canSeeBrand() used by submit.js) is enforced here — an agent scoped
  // to only Crickex, for example, can't search or see any other brand's
  // Deposit Issue data, same as every other module in the hub.
  if (requestedBrand) {
    const brandMeta = PKR_BRANDS.find((b) => b.id === requestedBrand);
    if (!brandMeta) return json({ ok: false, error: `Unknown brand "${requestedBrand}".` }, 400);
    if (!canSeeBrand(account, brandMeta.name)) return json({ ok: false, error: "You don't have access to this brand." }, 403);
  }
  const brandsToSearch = (requestedBrand ? PKR_BRANDS.filter((b) => b.id === requestedBrand) : PKR_BRANDS)
    .filter((b) => canSeeBrand(account, b.name));

  const targets = []; // { brandId, brandName, sheetId, tabNames }
  const unconfiguredBrands = [];
  for (const b of brandsToSearch) {
    const sheet = await resolveBrandSheet(env, b.id);
    if (sheet) targets.push({ brandId: b.id, brandName: b.name, sheetId: sheet.sheetId, tabNames: sheet.tabNames });
    else unconfiguredBrands.push(b.name);
  }

  // Specifically asked for one brand, and it has no Sheet linked yet —
  // tell the frontend plainly instead of returning a confusing "0 results".
  if (requestedBrand && !targets.length) {
    return json({ ok: true, results: [], notConfigured: true, brand: requestedBrand });
  }

  const accessToken = await getAccessToken(env);
  const results = [];
  const tabWarnings = []; // [{ brand, missingTabs, actualSheetTabs }] — only for sheets with a mismatch

  for (const target of targets) {
    if (results.length >= MAX_RESULTS) break;

    let realTabs;
    try {
      realTabs = await resolveExistingTabs(accessToken, target.sheetId);
    } catch (e) {
      // One brand's sheet being unreachable shouldn't kill results from
      // the others — record it as a warning and keep going.
      tabWarnings.push({ brand: target.brandName, missingTabs: target.tabNames, actualSheetTabs: [], error: String(e.message || e) });
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

    for (const { title: tab, gid } of tabsToQuery) {
      if (results.length >= MAX_RESULTS) break;
      const range = `'${tab.replace(/'/g, "''")}'!A2:${LAST_COL}`;
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${target.sheetId}/values/${encodeURIComponent(range)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      if (!res.ok) {
        tabWarnings.push({ brand: target.brandName, missingTabs: [], actualSheetTabs: [], error: `Sheets API error reading "${tab}": ${data.error?.message || res.status}` });
        continue;
      }
      const rows = data.values || [];
      rows.forEach((row, i) => {
        if (results.length >= MAX_RESULTS) return;
        const get = (colLetter) => row[colIndex(colLetter)] || "";
        const transactionId = get(COLS.transactionId);
        const reference = get(COLS.reference);
        const username = get(COLS.username);
        const agentNumber = get(COLS.agentNumber);
        // Match if ANY query is a substring of Transaction ID, Reference,
        // Username, or Agent Number.
        const haystack = (transactionId + " " + reference + " " + username + " " + agentNumber).toLowerCase();
        const isMatch = queries.some((q) => haystack.includes(q));
        if (!isMatch) return;

        const rowIndex = i + 2; // actual row number in the sheet (header is row 1)
        results.push({
          _sortTs: sortTimestamp(get(COLS.date), get(COLS.requestTime)),
          brand: target.brandId,
          brandName: target.brandName,
          sheetName: target.brandName,
          tabName: tab,
          sheetId: target.sheetId,
          rowIndex,
          // Direct link to this exact row, in this exact tab — Google
          // Sheets understands #gid=<tab> + range=<cell> in the URL and
          // will jump straight there, scroll included.
          sheetUrl: `https://docs.google.com/spreadsheets/d/${target.sheetId}/edit#gid=${gid}&range=A${rowIndex}`,
          transaction: transactionId,
          requestTime: get(COLS.requestTime),
          channel: get(COLS.channel),
          agentNumber: get(COLS.agentNumber),
          username: get(COLS.username),
          date: get(COLS.date),
          imageLink: get(COLS.imageLink),
          transactionError: get(COLS.transactionError),
          statusPG: get(COLS.statusPG),
          cartId: get(COLS.cartId),
          reference,
          cashOutNumber: get(COLS.cashOutNumber),
          amount: get(COLS.amount),
          supportPIC: get(COLS.supportPIC),
          pg: get(COLS.pg),
          csPIC: get(COLS.csPIC),
          playerContactNo: get(COLS.playerContactNo),
          statusCS: get(COLS.statusCS),
          correctUid: get(COLS.correctUid),
          playersCartId: get(COLS.playersCartId),
          paymentStatus: get(COLS.paymentStatus),
        });
      });
    }
  }

  // Newest first — matters most in "All Brands" mode, where results from
  // several different brands' sheets would otherwise stay grouped by
  // which brand/sheet they came from instead of being interleaved by
  // actual transaction time.
  results.sort((a, b) => b._sortTs - a._sortTs);
  results.forEach((r) => { delete r._sortTs; });

  return json({
    ok: true,
    results,
    tabWarnings: tabWarnings.length ? tabWarnings : undefined,
    // Brands with no Sheet linked at all yet — only surfaced in "All
    // Brands" mode, as a gentle heads-up, not an error (perfectly normal
    // while you're still onboarding the other 8 brands).
    unconfiguredBrands: !requestedBrand && unconfiguredBrands.length ? unconfiguredBrands : undefined,
  });
}

// Converts a column letter like "P" to a 0-based array index (15).
function colIndex(letter) {
  let n = 0;
  for (let i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n - 1;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
