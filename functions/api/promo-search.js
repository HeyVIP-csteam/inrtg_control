/**
 * GET /api/promo-search?codes=CODE1,CODE2
 *
 * Search-only — never writes anything. Reads directly from the shared
 * Promo Code Google Sheet (one workbook, many team tabs) and returns
 * every EXACT match of the Promo Code column, grouped by tab, so the
 * dashboard can show "which team's sheet has this code" the same way
 * the reference screenshot did.
 *
 * Requires the sheet to be shared (Viewer is enough) with the service
 * account: reward-form-writer@fifth-trainer-500806-e7.iam.gserviceaccount.com
 *
 * Column layout (same across all tabs below, columns A-N, header in row 1,
 * data starts row 2):
 *   A Brand | B Bonus Code | C Promo Code | D Deposit Range | E Bonus % |
 *   F Per Spin Value | G Max Bonus | H Wager | I Max Withdraw |
 *   J Expired Day | K Products | L Excluded Products/GAMES |
 *   M Under Group/Affiliate/VIP Level | N Expired On
 *
 * "Start On" has no source column yet in this sheet — always returned as
 * "" until one exists; the frontend shows it as a dash.
 */
import { batchGetValues } from "../_shared/googleSheets.js";

const PROMO_CODE_SHEET = {
  sheetId: "1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98",
  range: "A2:N1000",
  tabs: [
    "Welcome Call Team",
    "Retention team (Outsource)",
    "Retention Team (BDT)",
    "Retention Team (PKR)",
    "Retention Team (INR)",
    "Retention Team (PHP)",
    "Retention Team FT & TIRESIAS (BDT)",
    "Retention Team (VND)",
    "Retention Team (NPR)",
    "LIVE Streaming",
    "FB Ads (BDT)",
  ],
};

function sheetEditUrl() {
  return `https://docs.google.com/spreadsheets/d/${PROMO_CODE_SHEET.sheetId}/edit`;
}

export async function onRequestGet({ request, env }) {
  const codes = (new URL(request.url).searchParams.get("codes") || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  // No search yet (e.g. the page's initial load, just to fetch sheetUrl
  // for the "Open Sheet" button) — nothing to look up.
  if (!codes.length) {
    return json({ ok: true, groups: [], sheetUrl: sheetEditUrl() });
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return json({ ok: false, error: "Server is missing Google service account credentials." }, 500);
  }

  const needles = new Set(codes.map((c) => c.toUpperCase()));

  let valueRanges;
  try {
    const ranges = PROMO_CODE_SHEET.tabs.map((t) => `'${t.replace(/'/g, "''")}'!${PROMO_CODE_SHEET.range}`);
    valueRanges = await batchGetValues(env, PROMO_CODE_SHEET.sheetId, ranges);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 502);
  }

  const groups = [];
  PROMO_CODE_SHEET.tabs.forEach((tabName, i) => {
    const rows = (valueRanges[i] && valueRanges[i].values) || [];
    const matches = [];
    for (const row of rows) {
      const promoCode = (row[2] || "").trim();
      if (!promoCode || !needles.has(promoCode.toUpperCase())) continue;
      matches.push({
        brand: row[0] || "",
        bonusCode: row[1] || "",
        promoCode,
        depositRange: row[3] || "",
        maxBonus: row[6] || "",
        wager: row[7] || "",
        maxWithdraw: row[8] || "",
        expiredDay: row[9] || "",
        products: row[10] || "",
        excluded: row[11] || "",
        groupVip: row[12] || "",
        startOn: "", // no source column yet — see file header
        expiredOn: row[13] || "",
      });
    }
    if (matches.length) groups.push({ tab: tabName, count: matches.length, matches });
  });

  return json({ ok: true, groups, sheetUrl: sheetEditUrl() });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
