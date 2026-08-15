/**
 * functions/_shared/issueSubmissionSheets.js  (SERVER-ONLY)
 *
 * KV-override layer for "which Google Sheet + tab does this brand's
 * module write its rows to". Same shape as depositSheets.js — see
 * INTEGRATION-PORTAL-PATTERNS.md §1/§7 for the general pattern.
 *
 * Key space: one entry per (brandId, moduleId) pair. A fixed module
 * (anything with a SHEET_LAYOUT[moduleId] entry in routing.js) uses its
 * real moduleId. Promotion Request doesn't have one sheet per brand — it
 * has one per (brand, promotion type), via PROMOTION_SHEET_CONFIG — so
 * promotionModuleId() below synthesizes a moduleId-shaped key
 * ("promotion__<promotion>") that reuses this exact same storage layer
 * instead of standing up a second one.
 *
 * Only sheetId + tab are ever overridable — startColumn/columns (the
 * actual column layout of the sheet) always come from the hardcoded
 * routing.js config, because an overridden sheet is still assumed to
 * have the same column structure as the original.
 */
import { getSheetTabTitles } from "./googleSheets.js";

function key(brandId, moduleId) {
  return `issue-sheet:${brandId}|${moduleId}`;
}

export function promotionModuleId(promotion) {
  return `promotion__${promotion}`;
}

// Accepts either a raw Sheet ID or a full Google Sheets URL.
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

// Single read — used at submission time (functions/api/submit.js).
export async function getIssueSheetOverride(env, brandId, moduleId) {
  if (!env.THREADS_KV) return null;
  const raw = await env.THREADS_KV.get(key(brandId, moduleId));
  return parseEntry(raw);
}

// Batch read — used by the admin GET to fill the whole brand × module
// grid in one shot instead of one KV read per cell.
export async function getAllIssueSheetOverrides(env, brandIds, moduleIds) {
  if (!env.THREADS_KV) return {};
  const pairs = [];
  for (const brandId of brandIds) for (const moduleId of moduleIds) pairs.push([brandId, moduleId]);
  const raws = await Promise.all(pairs.map(([brandId, moduleId]) => env.THREADS_KV.get(key(brandId, moduleId))));
  const result = {};
  pairs.forEach(([brandId, moduleId], i) => {
    const parsed = parseEntry(raws[i]);
    if (parsed) result[`${brandId}|${moduleId}`] = parsed;
  });
  return result;
}

export async function saveIssueSheetOverride(env, brandId, moduleId, { sheetUrlOrId, tabNames }) {
  const sheetId = extractSheetId(sheetUrlOrId);
  if (!sheetId) throw new Error("Sheet URL or ID is required.");
  const names = String(tabNames || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!names.length) throw new Error("At least one tab name is required.");
  const value = { sheetId, tabNames: names };
  await env.THREADS_KV.put(key(brandId, moduleId), JSON.stringify(value));
  return value;
}

export async function deleteIssueSheetOverride(env, brandId, moduleId) {
  await env.THREADS_KV.delete(key(brandId, moduleId));
}

// Resolves a list of candidate tab names (the override's tabNames, most
// specific first) down to one real tab name that actually exists on the
// target sheet. Needed because an override's tab name is free-text typed
// into an admin form — nothing stops it from drifting from the sheet's
// real tab names over time. Falls back to the first candidate (instead of
// throwing) so a write still goes SOMEWHERE and surfaces as a Sheets API
// error rather than a silent no-op — same "fail loud, not quiet" choice
// submit.js already makes for every other sheet-write error.
export async function resolveWriteTab(env, sheetId, candidateTabNames) {
  const candidates = (candidateTabNames || []).filter(Boolean);
  if (!candidates.length) return null;
  try {
    const realTitles = await getSheetTabTitles(env, sheetId);
    const realSet = new Set(realTitles.map((t) => String(t).trim().toLowerCase()));
    for (const candidate of candidates) {
      if (realSet.has(String(candidate).trim().toLowerCase())) return candidate;
    }
  } catch {
    // Best-effort — if tab-title lookup itself fails, fall through and
    // just try the first candidate; the actual write call will surface
    // a real Sheets API error if it's genuinely wrong.
  }
  return candidates[0];
}
