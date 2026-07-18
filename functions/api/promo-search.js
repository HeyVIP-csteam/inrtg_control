/**
 * GET /api/promo-search?codes=CODE1,CODE2
 *
 * Currently a stub — returns `notConfigured: true` until PROMO_CODE_SHEET
 * is filled in below with the real sheet id / tab / column layout. Once
 * you send that over, this becomes a real lookup using the same
 * googleSheets.js helper the rest of the app already uses.
 */
// import { getSheetValues } from "../_shared/googleSheets.js";

const PROMO_CODE_SHEET = null; // e.g. { sheetId: "...", tab: "Promo Codes", codeColumn: "A", ... }

export async function onRequestGet({ request }) {
  const codes = (new URL(request.url).searchParams.get("codes") || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  if (!PROMO_CODE_SHEET) {
    return json({ ok: true, notConfigured: true, codes, results: [] });
  }

  // TODO once sheet details are provided: read PROMO_CODE_SHEET, filter rows
  // whose code column matches any of `codes`, return the matching rows.
  return json({ ok: true, results: [] });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
