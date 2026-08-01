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
 * Column layout differs from Deposit Issue's — per MODULE, not per
 * brand — see functions/_shared/depositColumns.js. Confirmed 2026-08-01
 * from BetVisa's real backup sheet screenshot; applies to every brand's
 * Deposit Backup sheet the same way.
 */
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import { getDepositBackup, DEPOSIT_HIDDEN_BRANDS } from "../../_shared/depositSheets.js";
import { batchGetValues, getSheetTabs } from "../../_shared/googleSheets.js";
import { getAccessToken } from "../../_shared/googleOAuth.js";
import { BACKUP_COLUMNS as cols } from "../../_shared/depositColumns.js";

// Column layout is the SAME for every brand's Deposit Backup sheet — see
// depositColumns.js. (Deposit Issue uses a different layout, also
// per-module not per-brand — don't confuse the two.)
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
      realTabs = await resolveExistingTabs(env, month.sheetId, token);
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
      const ranges = tabsToQuery.map(({ title }) => `'${title.replace(/'/g, "''")}'!A2:${cols.lastCol}`);
      valueRanges = await batchGetValues(env, month.sheetId, ranges, token);
    } catch (e) {
      tabWarnings.push({ brand: BRANDS[requestedBrand].name, month: month.label, missingTabs: [], actualSheetTabs: [], error: `Sheets API error: ${String((e && e.message) || e)}` });
      continue;
    }

    tabsToQuery.forEach(({ title: tab, gid }, tabI) => {
      if (results.length >= MAX_RESULTS) return;
      const rows = (valueRanges[tabI] && valueRanges[tabI].values) || [];
      rows.forEach((row, i) => {
        if (results.length >= MAX_RESULTS) return;
        const get = (colLetter) => (colLetter ? row[colIndex(colLetter)] || "" : "");
        const pgTid = get(cols.pgTid);
        const utr = get(cols.utr);
        const username = get(cols.username);
        const orderId = get(cols.orderId);
        const haystack = (pgTid + " " + utr + " " + username + " " + orderId).toLowerCase();
        if (!queries.some((q) => haystack.includes(q))) return;

        const rowIndex = i + 2;
        results.push({
          _sortTs: sortTimestamp(get(cols.date), get(cols.time)),
          brand: requestedBrand,
          brandName: BRANDS[requestedBrand].name,
          month: month.key,
          monthLabel: month.label,
          tabName: tab,
          sheetId: month.sheetId,
          rowIndex,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${month.sheetId}/edit#gid=${gid}&range=A${rowIndex}`,
          transaction: pgTid,
          requestTime: formatRequestDateTime(get(cols.date), get(cols.time)),
          username,
          pg: get(cols.pg),
          utr,
          slip: get(cols.slip),
          pgStaffName: get(cols.pgStaffName),
          slipAmount: get(cols.slipAmount),
          status: get(cols.status),
          followUpTimes: get(cols.followUpTimes),
          chatIds: get(cols.chatIds),
          agentUpi: get(cols.agentUpi),
          pgRemarks: get(cols.pgRemarks),
          csRemarks: get(cols.csRemarks),
          paymentStatus: get(cols.paymentStatus),
          orderId,
          picName: get(cols.picName),
          cartId: get(cols.cartId),
          amount: get(cols.amount),
          statusFinal: get(cols.statusFinal),
          upi: get(cols.upi),
          remarkPic: get(cols.remarkPic),
          memo: get(cols.memo),
          condition: get(cols.condition),
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
