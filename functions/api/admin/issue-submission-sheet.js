/**
 * /api/admin/issue-submission-sheet  ("Issue Submission Gsheet" admin
 * page, Integration Portal dropdown)
 *
 * Brand x module grid (same tgroute-* layout as TG Group/Channel and
 * Deposit Sheet Link) — one row per fixed module (every entry in
 * routing.js's SHEET_LAYOUT), plus a separate row per Promotion Request
 * promotion type (PROMOTION_SHEET_CONFIG), since that module's sheet
 * varies by promotion, not just by brand.
 *
 *   GET
 *     -> { ok: true, brands: [{id,name}], modules: [{id,name,emoji}],
 *          sheets: { "<brandId>|<moduleId>": {sheetId,tabNames,isOverride} },
 *          promotions: { [brandId]: [{promotion,sheetId,tabNames,isOverride}] } }
 *        `isOverride:false` rows fall back to the hardcoded routing.js
 *        default (brand.sheetId / SHEET_LAYOUT[moduleId].tab, or
 *        PROMOTION_SHEET_CONFIG's sheetId/tab for promotions).
 *     Requires canSeeAdminSection(..., "issueSubmissionSheet").
 *
 *   POST { action:"save", brandId, moduleId, sheetUrlOrId, tabNames } ->
 *     store an override for a fixed module row. `tabNames` is comma-
 *     separated (supports more than one candidate — see resolveWriteTab()
 *     in _shared/issueSubmissionSheets.js). Takes effect on the very next
 *     form submission — no redeploy needed. Requires
 *     canEditAdminSection(..., "issueSubmissionSheet").
 *
 *   POST { action:"save", brandId, promotion, sheetUrlOrId, tabNames } ->
 *     same, but for a Promotion Request row — `promotion` (not
 *     `moduleId`) selects which one, and must already exist in
 *     PROMOTION_SHEET_CONFIG for that brand.
 *
 *   POST { action:"reset", brandId, moduleId } / { action:"reset",
 *     brandId, promotion } -> delete the override, reverting back to the
 *     hardcoded default. Requires canEditAdminSection(...,
 *     "issueSubmissionSheet").
 *
 * See functions/_shared/issueSubmissionSheets.js for the KV layer, and
 * functions/api/submit.js for where the override is actually consulted
 * at submission time.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { getAllIssueSheetOverrides, saveIssueSheetOverride, deleteIssueSheetOverride, promotionModuleId } from "../../_shared/issueSubmissionSheets.js";
import { BRANDS, MODULE_META, SHEET_LAYOUT, PROMOTION_SHEET_CONFIG } from "../../_shared/routing.js";

// Every "<brandId>|<promotion>" key in PROMOTION_SHEET_CONFIG, grouped by
// brandId — computed once at module load, reused by GET and POST alike.
const PROMOTIONS_BY_BRAND = {};
for (const compositeKey of Object.keys(PROMOTION_SHEET_CONFIG)) {
  const sep = compositeKey.indexOf("|");
  const brandId = compositeKey.slice(0, sep);
  const promotion = compositeKey.slice(sep + 1);
  (PROMOTIONS_BY_BRAND[brandId] ||= []).push(promotion);
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
  if (!canSeeAdminSection(auth.account, "issueSubmissionSheet")) {
    return json({ ok: false, error: "You don't have access to Issue Submission Gsheet." }, 403);
  }

  const brandIds = Object.keys(BRANDS);
  // Every module that actually has a sheet layout — Promotion Request is
  // handled separately below (its sheet varies per promotion, not per
  // brand), so it's deliberately excluded from this list.
  const moduleIds = Object.keys(SHEET_LAYOUT);
  const promoModuleIds = brandIds.flatMap((b) => (PROMOTIONS_BY_BRAND[b] || []).map((p) => promotionModuleId(p)));
  const overrides = await getAllIssueSheetOverrides(env, brandIds, [...moduleIds, ...promoModuleIds]);

  const brands = brandIds.map((id) => ({ id, name: BRANDS[id].name }));
  const modules = moduleIds.map((id) => ({ id, name: MODULE_META[id]?.name || id, emoji: MODULE_META[id]?.emoji || "" }));

  const sheets = {};
  for (const brandId of brandIds) {
    for (const moduleId of moduleIds) {
      const compositeKey = `${brandId}|${moduleId}`;
      const override = overrides[compositeKey];
      const layoutEntry = SHEET_LAYOUT[moduleId];
      sheets[compositeKey] = override
        ? { sheetId: override.sheetId, tabNames: override.tabNames, isOverride: true }
        : { sheetId: BRANDS[brandId].sheetId || "", tabNames: layoutEntry?.tab ? [layoutEntry.tab] : [], isOverride: false };
    }
  }

  const promotions = {};
  for (const brandId of brandIds) {
    const promoList = PROMOTIONS_BY_BRAND[brandId] || [];
    if (!promoList.length) continue;
    promotions[brandId] = promoList.map((promotion) => {
      const compositeKey = `${brandId}|${promotionModuleId(promotion)}`;
      const override = overrides[compositeKey];
      const config = PROMOTION_SHEET_CONFIG[`${brandId}|${promotion}`];
      return override
        ? { promotion, sheetId: override.sheetId, tabNames: override.tabNames, isOverride: true }
        : { promotion, sheetId: config.sheetId, tabNames: [config.tab], isOverride: false };
    });
  }

  return json({ ok: true, brands, modules, sheets, promotions });
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
  if (!canEditAdminSection(auth.account, "issueSubmissionSheet")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Issue Submission Gsheet." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { brandId, promotion } = body || {};
  if (!BRANDS[brandId]) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);

  // Two shapes share this endpoint: a fixed-module row (`moduleId`) or a
  // Promotion Request row (`promotion`) — resolve which one this request
  // is, and the hardcoded-default sheet/tab to fall back to on reset.
  let moduleId, defaultSheetId, defaultTabNames;
  if (promotion !== undefined) {
    if (!PROMOTIONS_BY_BRAND[brandId]?.includes(promotion)) {
      return json({ ok: false, error: `Unknown promotion "${promotion}" for brand "${brandId}".` }, 400);
    }
    const config = PROMOTION_SHEET_CONFIG[`${brandId}|${promotion}`];
    moduleId = promotionModuleId(promotion);
    defaultSheetId = config.sheetId;
    defaultTabNames = [config.tab];
  } else {
    moduleId = body.moduleId;
    if (!SHEET_LAYOUT[moduleId]) return json({ ok: false, error: `Unknown or unsupported module "${moduleId}".` }, 400);
    defaultSheetId = BRANDS[brandId].sheetId || "";
    defaultTabNames = SHEET_LAYOUT[moduleId].tab ? [SHEET_LAYOUT[moduleId].tab] : [];
  }

  if (body.action === "save") {
    try {
      const saved = await saveIssueSheetOverride(env, brandId, moduleId, { sheetUrlOrId: body.sheetUrlOrId, tabNames: body.tabNames });
      return json({ ok: true, sheet: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await deleteIssueSheetOverride(env, brandId, moduleId);
    return json({ ok: true, sheet: { sheetId: defaultSheetId, tabNames: defaultTabNames, isOverride: false } });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
