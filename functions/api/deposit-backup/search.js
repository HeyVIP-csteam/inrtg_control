/**
 * POST /api/deposit-backup/search
 *
 * Deposit Backup — read-only search across one brand's "This Month" and
 * "Last Month" backup sheets (see functions/_shared/depositSheets.js for
 * how those two are stored/rotated). Modeled on Deposit Issue's
 * search.js (same auth gate, same tab-resolution/caching, same
 * per-brand access control), with three differences:
 *
 *   1. No update endpoint — read-only by design. Results still include
 *      the CS-facing columns (CS PIC, Status CS, etc.) for reference,
 *      just not editable.
 *   2. Two sheets per brand — "This Month" and "Last Month" are searched
 *      together by default, each result tagged with which one it came
 *      from.
 *   3. No "All Brands" fan-out at all (stricter than Deposit Issue,
 *      which at least still has a directory mode) — a specific brand is
 *      always required. No hardcoded default sheet for any brand.
 *
 * Column layout is assumed identical to Deposit Issue's own sheet (same
 * A–W order) — confirm this against a real INR backup sheet before
 * relying on it (see the COLS comment in deposit-issue/search.js).
 */
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import { getDepositBackup, DEPOSIT_HIDDEN_BRANDS } from "../../_shared/depositSheets.js";
import { batchGetValues, getSheetTabs } from "../../_shared/googleSheets.js";

// Column layout — confirmed identical to Deposit Issue's own sheet (same
// screenshot, same A–W order, 2026-08-01). Column H (no header,
// checkbox-formatted, data shows "forwarded") is deliberately skipped.
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
  csRemarks: "P",
  paymentStatus: "Q",
  orderId: "R",
  picName: "S",
  cartId: "T",
  amount: "U",
  statusFinal: "V",
  upi: "W",
};
const LAST_COL = "W";
const MAX_RESULTS = 500; // global cap across This Month + Last Month combined

function normalizeTabName(name) {
  return String(name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Date (col A) + Time (col B) combined into a single day-first display
// string. Falls back gracefully if either half is missing/malformed.
function formatRequestDateTime(dateRaw, timeRaw) {
  let d = String(dateRaw || "").trim();
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) d = `${m[3]}/${m[2]}/${m[1]}`;
  const t = String(timeRaw || "").trim();
  return d && t ? `${d} ${t}` : d || t;
}

// Computed from the RAW date/time (before formatRequestDateTime
// overwrites the display value), so This Month + Last Month interleave
// by actual transaction time rather than staying grouped by sheet.
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

const tabCache = new Map(); // sheetId -> { tabs: [{title, gid}], expiresAt }
const TAB_CACHE_MS = 5 * 60 * 1000;

async function resolveExistingTabs(env, sheetId) {
  const now = Date.now();
  const cached = tabCache.get(sheetId);
  if (cached && cached.expiresAt > now) return cached.tabs;
  const tabs = await getSheetTabs(env, sheetId);
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

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return json({ ok: false, error: "Server is missing Google service account credentials." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const raw = ((body && body.query) || "").trim();
  if (!raw) return json({ ok: false, error: "Missing query." }, 400);
  const requestedBrand = ((body && body.brand) || "").trim();

  // Unlike Deposit Issue, there's no "fan out across everything"
  // fallback here at all — searching always requires a specific brand.
  if (!requestedBrand) {
    return json({ ok: false, error: "Please select a specific brand before searching." }, 400);
  }
  if (!BRANDS[requestedBrand] || DEPOSIT_HIDDEN_BRANDS.includes(requestedBrand)) {
    return json({ ok: false, error: `Unknown brand "${requestedBrand}".` }, 400);
  }
  if (!canSeeBrand(account, BRANDS[requestedBrand].name)) {
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

  const results = [];
  const tabWarnings = []; // [{ brand, month, missingTabs, actualSheetTabs, error? }]

  for (const month of months) {
    if (results.length >= MAX_RESULTS) break;

    let realTabs;
    try {
      realTabs = await resolveExistingTabs(env, month.sheetId);
    } catch (e) {
      tabWarnings.push({ brand: BRANDS[requestedBrand].name, month: month.label, missingTabs: month.tabNames, actualSheetTabs: [], error: String((e && e.message) || e) });
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
      tabWarnings.push({ brand: BRANDS[requestedBrand].name, month: month.label, missingTabs, actualSheetTabs: realTabs.map((t) => t.title) });
    }
    if (!tabsToQuery.length) continue;

    let valueRanges;
    try {
      const ranges = tabsToQuery.map(({ title }) => `'${title.replace(/'/g, "''")}'!A2:${LAST_COL}`);
      valueRanges = await batchGetValues(env, month.sheetId, ranges);
    } catch (e) {
      tabWarnings.push({ brand: BRANDS[requestedBrand].name, month: month.label, missingTabs: [], actualSheetTabs: [], error: `Sheets API error: ${String((e && e.message) || e)}` });
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
        const haystack = (pgTid + " " + utr + " " + username + " " + orderId).toLowerCase();
        if (!queries.some((q) => haystack.includes(q))) return;

        const rowIndex = i + 2;
        results.push({
          _sortTs: sortTimestamp(get(COLS.date), get(COLS.time)),
          brand: requestedBrand,
          brandName: BRANDS[requestedBrand].name,
          month: month.key,
          monthLabel: month.label,
          tabName: tab,
          sheetId: month.sheetId,
          rowIndex,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${month.sheetId}/edit#gid=${gid}&range=A${rowIndex}`,
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

  results.sort((a, b) => b._sortTs - a._sortTs);
  results.forEach((r) => { delete r._sortTs; });

  return json({
    ok: true,
    results,
    tabWarnings: tabWarnings.length ? tabWarnings : undefined,
    missingMonths: ["thisMonth", "lastMonth"].filter((k) => !months.some((m) => m.key === k)).length
      ? ["thisMonth", "lastMonth"].filter((k) => !months.some((m) => m.key === k))
      : undefined,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
