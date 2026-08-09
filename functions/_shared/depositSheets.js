/**
 * depositSheets.js  (SERVER-ONLY)
 *
 * KV-backed overrides for which Google Sheet the "Deposit Issue" and
 * "Deposit Backup" modules read from — same layering pattern as routes.js
 * (TG Group/Channel): nothing is hardcoded in code, and this lets a
 * SuperAdmin set/change the link live from the browser (the "Deposit
 * Sheet Link" admin page) instead of needing a code edit + redeploy.
 *
 * Stored in the same THREADS_KV namespace as accounts/offices/routes,
 * under its own key prefixes:
 *   deposit-sheet:<moduleSlot>:<brandId>  ->  { sheetId, tabNames: string[] }
 *   deposit-backup:<brandId>              ->  { thisMonth: {sheetId,tabNames}|null,
 *                                                lastMonth: {sheetId,tabNames}|null }
 *
 * `moduleSlot` is a stable identifier for WHICH module a Deposit Issue-
 * shaped sheet link feeds ("depositIssue" today) — kept as a string
 * constant (not hardcoded inline) specifically so a future module could
 * reuse this same key family under its own slot without colliding.
 * Deposit Backup does NOT use this shape at all — it needs a This
 * Month/Last Month rotation pair per brand instead of one flat slot, so
 * it gets its own key prefix and its own functions below.
 *
 * No brand list lives in this file — every function here takes brandId
 * as a plain string and callers resolve it against BRANDS in routing.js,
 * same as routes.js does.
 *
 * No hardcoded default sheet exists anywhere in this module, for either
 * Deposit Issue or Deposit Backup — every brand starts fully
 * unconfigured; searching an unconfigured brand returns "not configured"
 * rather than guessing or reading the wrong sheet. (If this ever needs a
 * bootstrap default for one specific brand, that decision belongs in the
 * calling API files — functions/api/deposit-issue/search.js et al. — not
 * here; see the comments there.)
 */

// Brands temporarily hidden from Deposit Issue / Deposit Backup's
// agent-facing pages (brand dropdown, "All Brands" directory/fan-out) —
// NOT from the admin "Deposit Sheet Link" page, so a SuperAdmin can
// still pre-configure a hidden brand's sheet ahead of time. Reversible:
// remove the id here (and from the matching `BRANDS` array in
// public/deposit-issue.html / public/deposit-backup.html) once that
// brand's Deposit Support sheet actually exists.
export const DEPOSIT_HIDDEN_BRANDS = ["jeetway"]; // Jeetway has no Deposit Support sheet yet

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
// for this brand yet.
export async function getDepositSheetOverride(env, moduleSlot, brandId) {
  if (!env.THREADS_KV) return null;
  const raw = await env.THREADS_KV.get(sheetKey(moduleSlot, brandId));
  return parseConfig(raw);
}

// Batch read across all brands — used by the admin GET endpoint and by
// search.js's "All Brands" mode (which needs to know every configured
// sheet up front to fan the search out across all of them). Always
// Promise.all, never a sequential loop — matters more once this scales
// past a handful of brands.
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
 * Only "This Month" is ever directly editable — "Last Month" is
 * read-only in the UI and only ever changes via rollDepositBackup()
 * below: it's always "whatever This Month was, before the most recent
 * rollover."
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

// Clears This Month only — no hardcoded default to "reset" back to, for
// backup sheets. Last Month is left untouched.
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
