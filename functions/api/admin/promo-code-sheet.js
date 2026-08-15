/**
 * /api/admin/promo-code-sheet  ("Promo Code Gsheet" admin page, Integration
 * Portal dropdown)
 *
 * Live-editable version of the sheetId/tabNames that used to be hardcoded
 * directly in functions/api/promo-search.js. Single global slot — unlike
 * Deposit Sheet Link/TG Group-Channel there's no per-brand dimension here,
 * it's one shared workbook used across every brand/team.
 *
 *   GET
 *     -> { ok: true, sheet: { sheetId, tabNames, isOverride } }
 *        `isOverride: true` means a KV override is live; `false` means
 *        promo-search.js is using PROMO_CODE_SHEET_DEFAULT (see
 *        _shared/promoCodeSheetOverride.js).
 *     Requires canSeeAdminSection(..., "promoCodeSheet").
 *
 *   POST { action:"save", sheetUrlOrId, tabNames } -> store an override in
 *     THREADS_KV. `tabNames` is a comma-separated string. Takes effect on
 *     the very next promo code search — no redeploy needed. Requires
 *     canEditAdminSection(..., "promoCodeSheet").
 *
 *   POST { action:"reset" } -> delete the override, reverting back to
 *     PROMO_CODE_SHEET_DEFAULT.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import {
  PROMO_CODE_SHEET_DEFAULT,
  getPromoCodeSheetOverride,
  savePromoCodeSheetOverride,
  deletePromoCodeSheetOverride,
} from "../../_shared/promoCodeSheetOverride.js";

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
  if (!canSeeAdminSection(auth.account, "promoCodeSheet")) {
    return json({ ok: false, error: "You don't have access to Promo Code Gsheet." }, 403);
  }

  const override = await getPromoCodeSheetOverride(env);
  const sheet = override
    ? { sheetId: override.sheetId, tabNames: override.tabNames, isOverride: true }
    : { sheetId: PROMO_CODE_SHEET_DEFAULT.sheetId, tabNames: PROMO_CODE_SHEET_DEFAULT.tabNames, isOverride: false };

  return json({ ok: true, sheet });
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
  if (!canEditAdminSection(auth.account, "promoCodeSheet")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Promo Code Gsheet." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.action === "save") {
    try {
      const saved = await savePromoCodeSheetOverride(env, { sheetUrlOrId: body.sheetUrlOrId, tabNames: body.tabNames });
      return json({ ok: true, sheet: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await deletePromoCodeSheetOverride(env);
    return json({ ok: true, sheet: { sheetId: PROMO_CODE_SHEET_DEFAULT.sheetId, tabNames: PROMO_CODE_SHEET_DEFAULT.tabNames, isOverride: false } });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
