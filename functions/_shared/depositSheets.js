/**
 * depositSheets.js  (SERVER-ONLY)
 *
 * KV-backed overrides for which Google Sheet a "Deposit *" module reads
 * from — same layering pattern as routes.js (TG Group/Channel): a
 * hardcoded default lives in code, and this lets a SuperAdmin change it
 * live from the browser (the "Deposit Sheet Link" admin page, which now
 * mirrors TG Group/Channel's brand-sidebar layout) instead of needing a
 * code edit + redeploy every time a department swaps in a new Sheet.
 *
 * Stored in the same THREADS_KV namespace as accounts/offices/routes,
 * under its own key prefix:
 *   deposit-sheet:<moduleSlot>:<brandId>  ->  { sheetId, tabNames: string[] }
 *
 * `moduleSlot` is a stable identifier for WHICH module this sheet feeds
 * ("depositIssue" today) so a future "Deposit Backup" module can reuse
 * this same file/pattern under its own slot ("depositBackup") without
 * colliding with Deposit Issue's per-brand entries.
 */

export const PKR_BRANDS = [
  { id: "crickex", name: "Crickex" },
  { id: "betjili", name: "Betjili" },
  { id: "mostplay", name: "Mostplay" },
  { id: "jeetwin", name: "Jeetwin" },
  { id: "sbj66", name: "Sbj66" },
  { id: "heybaji", name: "Heybaji" },
  { id: "superbaji", name: "Superbaji" },
  { id: "kv8", name: "KV8" },
  { id: "darazplay", name: "Darazplay" },
];

function sheetKey(moduleSlot, brandId) {
  return `deposit-sheet:${moduleSlot}:${brandId}`;
}

// Accepts either a raw Sheet ID or a full Google Sheets URL (any of the
// usual forms: .../d/<id>/edit, .../d/<id>/edit#gid=0, .../d/<id>) and
// returns just the ID — so whoever's pasting this in doesn't have to
// manually trim the URL down first.
export function extractSheetId(input) {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Not a URL — assume it's already a bare ID if it looks like one.
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return "";
}

function parseConfig(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sheetId) return null; // guard against malformed/emptied entry
    return {
      sheetId: String(parsed.sheetId),
      tabNames: Array.isArray(parsed.tabNames) && parsed.tabNames.length ? parsed.tabNames.map(String) : [],
    };
  } catch {
    return null;
  }
}

// Single-brand read — used at request time (search.js/update.js) when a
// specific brand is targeted. Returns null if nothing's been configured
// for this brand yet (caller decides what the fallback default is, if
// any — e.g. search.js only has a hardcoded fallback for "crickex").
export async function getDepositSheetOverride(env, moduleSlot, brandId) {
  if (!env.THREADS_KV) return null;
  const raw = await env.THREADS_KV.get(sheetKey(moduleSlot, brandId));
  return parseConfig(raw);
}

// Batch read across all brands — used by the admin GET endpoint and by
// search.js's "All Brands" mode (which needs to know every configured
// sheet up front to fan the search out across all of them).
export async function getAllDepositSheetOverrides(env, moduleSlot, brandIds) {
  if (!env.THREADS_KV) return {};
  const entries = await Promise.all(
    brandIds.map(async (brandId) => [brandId, parseConfig(await env.THREADS_KV.get(sheetKey(moduleSlot, brandId)))])
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== null));
}

export async function saveDepositSheetOverride(env, moduleSlot, brandId, { sheetUrlOrId, tabNames }) {
  const sheetId = extractSheetId(sheetUrlOrId);
  if (!sheetId) throw new Error("Couldn't find a Sheet ID in that link — paste the full Google Sheets URL or just the ID.");
  const cleanTabs = String(tabNames || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!cleanTabs.length) throw new Error("At least one tab name is required.");
  const value = { sheetId, tabNames: cleanTabs };
  await env.THREADS_KV.put(sheetKey(moduleSlot, brandId), JSON.stringify(value));
  return value;
}

export async function deleteDepositSheetOverride(env, moduleSlot, brandId) {
  await env.THREADS_KV.delete(sheetKey(moduleSlot, brandId));
}

/**
 * ── Deposit Backup: "This Month" / "Last Month" rotation ──
 *
 * Deliberately stored as ONE combined KV entry per brand (not two
 * separate keys) so the rollover operation below is a single atomic
 * write — no risk of "This Month cleared but Last Month write failed"
 * leaving things half-updated.
 *
 *   deposit-backup:<brandId> -> { thisMonth: {sheetId,tabNames}|null,
 *                                  lastMonth: {sheetId,tabNames}|null }
 *
 * Only "This Month" is ever directly editable — "Last Month" is
 * read-only in the UI and only ever changes via rollDepositBackup()
 * below, by design (see the admin page for the reasoning): it's always
 * "whatever This Month was, before the most recent rollover."
 */
function backupKey(brandId) {
  return `deposit-backup:${brandId}`;
}

export async function getDepositBackup(env, brandId) {
  if (!env.THREADS_KV) return { thisMonth: null, lastMonth: null };
  const raw = await env.THREADS_KV.get(backupKey(brandId));
  if (!raw) return { thisMonth: null, lastMonth: null };
  try {
    const parsed = JSON.parse(raw);
    return { thisMonth: parsed.thisMonth || null, lastMonth: parsed.lastMonth || null };
  } catch {
    return { thisMonth: null, lastMonth: null };
  }
}

export async function saveDepositBackupThisMonth(env, brandId, { sheetUrlOrId, tabNames }) {
  const sheetId = extractSheetId(sheetUrlOrId);
  if (!sheetId) throw new Error("Couldn't find a Sheet ID in that link — paste the full Google Sheets URL or just the ID.");
  const cleanTabs = String(tabNames || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!cleanTabs.length) throw new Error("At least one tab name is required.");
  const current = await getDepositBackup(env, brandId);
  const updated = { thisMonth: { sheetId, tabNames: cleanTabs }, lastMonth: current.lastMonth };
  await env.THREADS_KV.put(backupKey(brandId), JSON.stringify(updated));
  return updated;
}

// Clears This Month only (no hardcoded default to "reset" back to, for
// backup sheets — unlike Deposit Issue's Crickex default). Last Month is
// left untouched.
export async function clearDepositBackupThisMonth(env, brandId) {
  const current = await getDepositBackup(env, brandId);
  const updated = { thisMonth: null, lastMonth: current.lastMonth };
  await env.THREADS_KV.put(backupKey(brandId), JSON.stringify(updated));
  return updated;
}

// The rollover: whatever's currently in This Month becomes the new Last
// Month (discarding whatever was there before), and This Month is
// cleared out ready for the new link to be pasted in via
// saveDepositBackupThisMonth() as a separate, explicit next step.
export async function rollDepositBackup(env, brandId) {
  const current = await getDepositBackup(env, brandId);
  const updated = { thisMonth: null, lastMonth: current.thisMonth };
  await env.THREADS_KV.put(backupKey(brandId), JSON.stringify(updated));
  return updated;
}
