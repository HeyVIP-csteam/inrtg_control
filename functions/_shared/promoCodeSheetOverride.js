/**
 * functions/_shared/promoCodeSheetOverride.js  (SERVER-ONLY)
 *
 * KV-override layer for the Promo Code Search sheet (functions/api/
 * promo-search.js). Same "KV override, code default, delete-not-clear
 * reset" shape as depositSheets.js — see INTEGRATION-PORTAL-PATTERNS.md
 * §1 for the general pattern this is an instance of.
 *
 * Unlike Deposit Sheet Link / TG Group-Channel, there's only ONE slot
 * here (not one per brand) — the Promo Code sheet is a single shared
 * workbook used across all brands/teams, so there's a single KV key,
 * not a per-brandId key.
 *
 * PROMO_CODE_SHEET below is the hardcoded default (moved here from
 * promo-search.js, which now imports it from this file instead of
 * defining it locally — so the admin GET/reset endpoint and the actual
 * search endpoint can never drift out of sync on what "the default" is).
 */

const KV_KEY = "promo-code-sheet:global";

// Hardcoded default — exactly what promo-search.js had inline before.
// KV empty means the search endpoint behaves exactly as it always has.
export const PROMO_CODE_SHEET_DEFAULT = {
  sheetId: "1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98",
  tabNames: [
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

// Accepts either a raw Sheet ID or a full Google Sheets URL and returns
// just the ID — same tolerance the other admin sheet-link pages give
// staff pasting a browser URL.
function extractSheetId(input) {
  const raw = String(input || "").trim();
  const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : raw;
}

function parseEntry(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sheetId || !Array.isArray(parsed.tabNames) || !parsed.tabNames.length) return null;
    return { sheetId: parsed.sheetId, tabNames: parsed.tabNames };
  } catch {
    return null;
  }
}

// Single read — used by promo-search.js on every search request.
export async function getPromoCodeSheetOverride(env) {
  if (!env.THREADS_KV) return null;
  const raw = await env.THREADS_KV.get(KV_KEY);
  return parseEntry(raw);
}

export async function savePromoCodeSheetOverride(env, { sheetUrlOrId, tabNames }) {
  const sheetId = extractSheetId(sheetUrlOrId);
  if (!sheetId) throw new Error("Sheet URL or ID is required.");
  const names = String(tabNames || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!names.length) throw new Error("At least one tab name is required.");
  const value = { sheetId, tabNames: names };
  await env.THREADS_KV.put(KV_KEY, JSON.stringify(value));
  return value;
}

export async function deletePromoCodeSheetOverride(env) {
  await env.THREADS_KV.delete(KV_KEY);
}
