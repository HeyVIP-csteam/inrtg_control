/**
 * /api/admin/deposit-sheets  ("Deposit Sheet Link" admin page)
 *
 * Same brand-sidebar shape as /api/admin/routes (TG Group/Channel) — one
 * row per brand for Deposit Issue, plus a This Month sheet for Deposit
 * Backup, each independently overridable.
 *
 *   GET
 *     -> { ok: true, brands: [{id,name}],
 *          sheets: { [brandId]: { sheetId, tabNames, isOverride } },
 *          backup: { [brandId]: { thisMonth: {sheetId,tabNames}|null } } }
 *        `isOverride: true` means it's a live KV override; `false` means
 *        the brand has no Deposit Issue sheet linked yet (sheetId: "").
 *        No hardcoded default exists for any brand — see depositSheets.js.
 *     Requires canSeeAdminSection(..., "depositSheets").
 *
 *   POST { action:"save", brandId, sheetUrlOrId, tabNames } -> store a
 *     Deposit Issue override in THREADS_KV. `tabNames` is a comma-
 *     separated string. Takes effect on the very next search/update for
 *     that brand — no redeploy needed. Requires
 *     canEditAdminSection(..., "depositSheets").
 *
 *   POST { action:"reset", brandId } -> delete the Deposit Issue
 *     override, reverting that brand back to fully unconfigured.
 *
 *   Deposit Backup — "This Month" sheet. (A "Last Month" rotation used
 *   to sit alongside this — removed 2026-08-15, unused.)
 *   POST { action:"saveBackupThisMonth", brandId, sheetUrlOrId, tabNames }
 *   POST { action:"clearBackupThisMonth", brandId }
 *
 * NOTE: this admin GET/POST intentionally still lists EVERY brand,
 * including ones currently in DEPOSIT_HIDDEN_BRANDS (depositSheets.js)
 * — a SuperAdmin can pre-configure a not-yet-launched brand's sheet
 * here ahead of time. It's only hidden from the agent-facing search
 * pages (deposit-issue.html / deposit-backup.html's brand dropdown and
 * "All Brands" mode) until someone removes it from that list.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import {
  getAllDepositSheetOverrides,
  saveDepositSheetOverride,
  deleteDepositSheetOverride,
  getDepositBackup,
  saveDepositBackupThisMonth,
  clearDepositBackupThisMonth,
} from "../../_shared/depositSheets.js";

const MODULE_SLOT = "depositIssue"; // must match deposit-issue/{search,update,sheet-links}.js

function defaultFor() {
  // No bootstrap default for any brand — every brand starts fully
  // unconfigured until a link is saved here. If a specific brand ever
  // needs a pre-wired fallback sheet, branch on brandId here AND add the
  // matching branch in deposit-issue/search.js's resolveBrandSheet-
  // equivalent — both files need it independently.
  return { sheetId: "", tabNames: [] };
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "depositSheets")) {
    return json({ ok: false, error: "You don't have access to Deposit Sheet Link." }, 403);
  }

  const brandIds = Object.keys(BRANDS);
  const overrides = await getAllDepositSheetOverrides(env, MODULE_SLOT, brandIds);

  const sheets = {};
  for (const brandId of brandIds) {
    const override = overrides[brandId];
    sheets[brandId] = override
      ? { sheetId: override.sheetId, tabNames: override.tabNames, isOverride: true }
      : { ...defaultFor(), isOverride: false };
  }

  // Fetched in parallel, not one brand at a time — same reason
  // getAllDepositSheetOverrides() above does too.
  const backupEntries = await Promise.all(brandIds.map(async (brandId) => [brandId, await getDepositBackup(env, brandId)]));
  const backup = Object.fromEntries(backupEntries);

  const brands = brandIds.map((id) => ({ id, name: BRANDS[id].name }));
  return json({ ok: true, brands, sheets, backup });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
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
  if (!BRANDS[brandId]) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);

  if (body.action === "save") {
    try {
      const saved = await saveDepositSheetOverride(env, MODULE_SLOT, brandId, { sheetUrlOrId: body.sheetUrlOrId, tabNames: body.tabNames });
      return json({ ok: true, brandId, sheet: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await deleteDepositSheetOverride(env, MODULE_SLOT, brandId);
    return json({ ok: true, brandId, sheet: { ...defaultFor(), isOverride: false } });
  }

  if (body.action === "saveBackupThisMonth") {
    try {
      const updated = await saveDepositBackupThisMonth(env, brandId, { sheetUrlOrId: body.sheetUrlOrId, tabNames: body.tabNames });
      return json({ ok: true, brandId, backup: updated });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 400);
    }
  }
  if (body.action === "clearBackupThisMonth") {
    const updated = await clearDepositBackupThisMonth(env, brandId);
    return json({ ok: true, brandId, backup: updated });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
