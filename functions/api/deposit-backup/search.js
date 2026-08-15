/**
 * POST /api/deposit-backup/search
 *
 * Deposit Backup — read-only search across one brand's "This Month" and
 * "Last Month" backup sheets (see functions/_shared/depositSheets.js for
 * how those two are stored/rotated). Deliberately modeled on Deposit
 * Issue's search.js (same auth gate, same tab-resolution/caching, same
 * per-brand access control, same "no All-Brand search — pick a brand
 * first" scaling guard), with three differences:
 *
 *   1. No update endpoint — this module is read-only by design (see
 *      PROJECT_STATUS.md decision). Results still include the CS-facing
 *      columns (CS PIC, Status CS, etc.) for reference, just not editable.
 *   2. Two sheets per brand instead of one — "This Month" and "Last
 *      Month" are searched together by default (per business owner's
 *      request), each tagged with which one a result came from.
 *   3. No hardcoded default sheet for any brand — Deposit Backup has no
 *      Crickex-style bootstrap default; every brand starts unconfigured
 *      until a link is saved via the "Deposit Sheet Link" admin page's
 *      Deposit Backup rows.
 *
 * Column layout confirmed identical to Deposit Issue's own sheet (same
 * A–W layout, same header order) from the real "CXPKR ~ July 2026-BACK-UP"
 * screenshot — reusing search.js's COLS mapping as-is. Each month's sheet
 * has (at least) two tabs, e.g. "Success" and "Trx error" — both go in
 * that month's tabNames, same comma-separated config field Deposit Issue
 * already uses for multi-tab brands like Crickex.
 */
import { getAccessToken } from "../../_shared/googleOAuth.js";
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { PKR_BRANDS, getDepositBackup } from "../../_shared/depositSheets.js";

// Same column layout as Deposit Issue's search.js — keep these two in
// sync if a department's sheet is ever reordered (confirmed identical
// for Deposit Backup from the real screenshot as of this writing).
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
const LAST_COL = "W";
const MAX_RESULTS = 500; // global cap across This Month + Last Month combined

function normalizeTabName(name) {
  return String(name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Sheet stores Date (col F, e.g. "2026-06-28") and Request Time (col B,
// time-only, e.g. "9:28:31") as two separate columns. Combined for
// display into a single "DD/MM/YYYY HH:MM:SS" string, day-first to match
// the rest of the hub (Deposit Issue's own sheet uses the same day/month/
// year convention). Falls back gracefully if either half is missing or
// isn't in the expected shape — never throws, worst case just shows
// whatever raw text was in the cell.
function formatRequestDateTime(dateRaw, timeRaw) {
  let d = String(dateRaw || "").trim();
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) d = `${m[3]}/${m[2]}/${m[1]}`;
  const t = String(timeRaw || "").trim();
  if (d && t) return `${d} ${t}`;
  return d || t;
}

// Sortable epoch-ms timestamp built from the same raw Date (col F) +
// Request Time (col B) values used above — results are sorted newest
// first before being returned (see bottom of handleSearch). Rows with
// an unparseable/missing date sort to the very bottom (return 0 —
// effectively "1970", always older than any real row) rather than
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

// Same per-isolate tab-title cache pattern as Deposit Issue's search.js.
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
    return json({ ok: false, error: `Search failed: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleSearch({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const raw = ((body && body.query) || "").trim();
  if (!raw) return json({ ok: false, error: "Missing query." }, 400);
  const requestedBrand = ((body && body.brand) || "").trim();

  // Unlike Deposit Issue, there's no "fan out across everything" fallback
  // here at all — searching always requires a specific brand. (~100
  // brands × up to 2 sheets × up to N tabs each makes an unscoped search
  // even less viable than Deposit Issue's already-removed "All Brands"
  // search was.)
  if (!requestedBrand) {
    return json({ ok: false, error: "Please select a specific brand before searching." }, 400);
  }
  const brandMeta = PKR_BRANDS.find((b) => b.id === requestedBrand);
  if (!brandMeta) return json({ ok: false, error: `Unknown brand "${requestedBrand}".` }, 400);
  if (!canSeeBrand(account, brandMeta.name)) {
    return json({ ok: false, error: "You don't have access to this brand." }, 403);
  }

  const queries = raw.split(/[\n,]+/).map((q) => q.trim()).filter(Boolean).map((q) => q.toLowerCase());
  if (!queries.length) return json({ ok: false, error: "No valid search terms." }, 400);

  const backup = await getDepositBackup(env, requestedBrand);
  const months = [];
  if (backup.thisMonth) months.push({ key: "thisMonth", label: "This Month", sheetId: backup.thisMonth.sheetId, tabNames: backup.thisMonth.tabNames });
  if (backup.lastMonth) months.push({ key: "lastMonth", label: "Last Month", sheetId: backup.lastMonth.sheetId, tabNames: backup.lastMonth.tabNames });

  if (!months.length) {
    return json({ ok: true, results: [], notConfigured: true, brand: requestedBrand });
  }

  const accessToken = await getAccessToken(env);
  const results = [];
  const tabWarnings = []; // [{ brand, month, missingTabs, actualSheetTabs, error? }]

  for (const month of months) {
    if (results.length >= MAX_RESULTS) break;

    let realTabs;
    try {
      realTabs = await resolveExistingTabs(accessToken, month.sheetId);
    } catch (e) {
      tabWarnings.push({ brand: brandMeta.name, month: month.label, missingTabs: month.tabNames, actualSheetTabs: [], error: String((e && e.message) || e) });
      continue;
    }
    const realByNormalized = new Map(realTabs.map((t) => [normalizeTabName(t.title), t]));
    const tabsToQuery = [];
    const missingTabs = [];
    for (const configured of month.tabNames) {
      const real = realByNormalized.get(normalizeTabName(configured));
      if (real) tabsToQuery.push(real);
      else missingTabs.push(configured);
    }
    if (missingTabs.length) {
      tabWarnings.push({ brand: brandMeta.name, month: month.label, missingTabs, actualSheetTabs: realTabs.map((t) => t.title) });
    }

    for (const { title: tab, gid } of tabsToQuery) {
      if (results.length >= MAX_RESULTS) break;
      const range = `'${tab.replace(/'/g, "''")}'!A2:${LAST_COL}`;
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${month.sheetId}/values/${encodeURIComponent(range)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      if (!res.ok) {
        tabWarnings.push({ brand: brandMeta.name, month: month.label, missingTabs: [], actualSheetTabs: [], error: `Sheets API error reading "${tab}": ${data.error?.message || res.status}` });
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
        const haystack = (transactionId + " " + reference + " " + username + " " + agentNumber).toLowerCase();
        const isMatch = queries.some((q) => haystack.includes(q));
        if (!isMatch) return;

        const rowIndex = i + 2;
        results.push({
          _sortTs: sortTimestamp(get(COLS.date), get(COLS.requestTime)),
          brand: requestedBrand,
          brandName: brandMeta.name,
          month: month.key,
          monthLabel: month.label,
          tabName: tab,
          sheetId: month.sheetId,
          rowIndex,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${month.sheetId}/edit#gid=${gid}&range=A${rowIndex}`,
          transaction: transactionId,
          requestTime: formatRequestDateTime(get(COLS.date), get(COLS.requestTime)),
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

  // Newest first — This Month and Last Month (and Success/Trx error
  // within each) get interleaved by actual transaction time instead of
  // staying grouped by sheet/tab order.
  results.sort((a, b) => b._sortTs - a._sortTs);
  results.forEach((r) => { delete r._sortTs; });

  return json({
    ok: true,
    results,
    tabWarnings: tabWarnings.length ? tabWarnings : undefined,
    // Which of This Month / Last Month simply isn't linked yet (not an
    // error — perfectly normal early in a month, or before onboarding).
    missingMonths: ["thisMonth", "lastMonth"].filter((k) => !months.some((m) => m.key === k)).length
      ? ["thisMonth", "lastMonth"].filter((k) => !months.some((m) => m.key === k))
      : undefined,
  });
}

function colIndex(letter) {
  let n = 0;
  for (let i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n - 1;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
