/**
 * /api/admin/deposit-sheets  ("Deposit Sheet Link" admin page)
 *
 * Same brand-sidebar shape as /api/admin/routes (TG Group/Channel) — one
 * row per PKR brand, each independently overridable.
 *
 *   GET
 *     -> { ok: true, brands: [{id,name}],
 *          sheets: { [brandId]: { sheetId, tabNames, isOverride } },
 *          backup: { [brandId]: { thisMonth: {sheetId,tabNames}|null,
 *                                  lastMonth: {sheetId,tabNames}|null } } }
 *        `isOverride: true` means it's a live KV override (edited through
 *        this page); `false` means it's still showing the hardcoded
 *        default (only "crickex" has one baked into search.js right now —
 *        every other brand shows sheetId:"" until someone saves a link).
 *     Requires canSeeAdminSection(..., "depositSheets").
 *
 *   POST { action:"save", brandId, sheetUrlOrId, tabNames } -> store an
 *     override in THREADS_KV. `tabNames` is a comma-separated string.
 *     Takes effect on the very next search/update for that brand — no
 *     redeploy needed. Requires canEditAdminSection(..., "depositSheets").
 *
 *   POST { action:"reset", brandId } -> delete the override, reverting
 *     that brand back to its hardcoded default (empty, for every brand
 *     except crickex). Requires canEditAdminSection(..., "depositSheets").
 *
 *   Deposit Backup — "This Month" / "Last Month" rotation. Only This
 *   Month is ever directly editable; Last Month is read-only in the UI
 *   and only changes via the rollover action. See depositSheets.js for
 *   the full reasoning.
 *   POST { action:"saveBackupThisMonth", brandId, sheetUrlOrId, tabNames }
 *     -> overwrites This Month only, leaves Last Month untouched.
 *   POST { action:"clearBackupThisMonth", brandId }
 *     -> clears This Month only (no hardcoded default to fall back to).
 *   POST { action:"rollBackup", brandId }
 *     -> This Month becomes the new Last Month (discarding whatever was
 *        there), This Month is cleared out ready for the new link.
 *
 * MODULE_SLOT / DEFAULT_CRICKEX below are hand-copied from
 * functions/api/deposit-issue/search.js's own constants — keep in sync
 * if that file's hardcoded default ever changes directly instead of
 * through this admin page.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import {
  PKR_BRANDS,
  getAllDepositSheetOverrides,
  saveDepositSheetOverride,
  deleteDepositSheetOverride,
  getDepositBackup,
  saveDepositBackupThisMonth,
  clearDepositBackupThisMonth,
  rollDepositBackup,
} from "../../_shared/depositSheets.js";

const MODULE_SLOT = "depositIssue";
// Only Crickex has a real hardcoded fallback (this was the one working
// Sheet before this admin page existed). Every other brand starts with
// no default at all — until a link is saved here, that brand's Deposit
// Issue search returns "not configured" rather than silently reading
// the wrong department's data.
const DEFAULT_CRICKEX = { sheetId: "1HByPuZMuuYZL9S5fPPGjb8RAmCwNVgKXvuLgVBbVM-E", tabNames: ["CX PKR"] };

function defaultFor(brandId) {
  return brandId === "crickex" ? DEFAULT_CRICKEX : { sheetId: "", tabNames: [] };
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "depositSheets")) {
    return json({ ok: false, error: "You don't have access to Deposit Sheet Link." }, 403);
  }

  const brandIds = PKR_BRANDS.map((b) => b.id);
  const overrides = await getAllDepositSheetOverrides(env, MODULE_SLOT, brandIds);

  const sheets = {};
  for (const brandId of brandIds) {
    const override = overrides[brandId];
    sheets[brandId] = override
      ? { sheetId: override.sheetId, tabNames: override.tabNames, isOverride: true }
      : { ...defaultFor(brandId), isOverride: false };
  }

  // Deposit Backup: This Month / Last Month, no hardcoded default for
  // any brand (unlike Deposit Issue's Crickex fallback) — every brand
  // starts fully empty until someone saves a link. Fetched in parallel
  // (not one brand at a time) — same reason getAllDepositSheetOverrides()
  // above does too: 9 sequential KV round-trips is what was making this
  // modal noticeably slow to open.
  const backupEntries = await Promise.all(brandIds.map(async (brandId) => [brandId, await getDepositBackup(env, brandId)]));
  const backup = Object.fromEntries(backupEntries);

  return json({ ok: true, brands: PKR_BRANDS, sheets, backup });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "depositSheets")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Deposit Sheet Link." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const brandId = body.brandId;
  if (!PKR_BRANDS.some((b) => b.id === brandId)) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);

  if (body.action === "save") {
    try {
      const saved = await saveDepositSheetOverride(env, MODULE_SLOT, brandId, { sheetUrlOrId: body.sheetUrlOrId, tabNames: body.tabNames });
      return json({ ok: true, brandId, sheet: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await deleteDepositSheetOverride(env, MODULE_SLOT, brandId);
    return json({ ok: true, brandId, sheet: { ...defaultFor(brandId), isOverride: false } });
  }

  // ── Deposit Backup actions ──
  if (body.action === "saveBackupThisMonth") {
    try {
      const updated = await saveDepositBackupThisMonth(env, brandId, { sheetUrlOrId: body.sheetUrlOrId, tabNames: body.tabNames });
      return json({ ok: true, brandId, backup: updated });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }
  if (body.action === "clearBackupThisMonth") {
    const updated = await clearDepositBackupThisMonth(env, brandId);
    return json({ ok: true, brandId, backup: updated });
  }
  if (body.action === "rollBackup") {
    const updated = await rollDepositBackup(env, brandId);
    return json({ ok: true, brandId, backup: updated });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
