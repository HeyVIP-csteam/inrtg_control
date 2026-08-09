/**
 * GET /api/deposit-issue/sheet-links
 *
 * Returns, for every brand the logged-in agent has access to, whether a
 * Deposit Issue Sheet is configured and (if so) its ID — used to power
 * the "All Brands" directory view: a list of "<Brand> Deposit Gsheet —
 * Open Sheet" cards instead of an actual cross-brand search (which
 * doesn't scale — see search.js's comments on why "All Brands" search
 * was removed).
 *
 * Same canSeeBrand() filtering as search.js/update.js — an agent scoped
 * to one brand only gets that one brand back, never sees the others'
 * sheetIds even exist.
 */
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { PKR_BRANDS, getDepositSheetOverride } from "../../_shared/depositSheets.js";

const MODULE_SLOT = "depositIssue";
// Must match search.js/update.js's hardcoded Crickex default — see those
// files for the full explanation of the KV-override-over-code-default layering.
const DEFAULT_CRICKEX_SHEET_ID = "1HByPuZMuuYZL9S5fPPGjb8RAmCwNVgKXvuLgVBbVM-E";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const visibleBrands = PKR_BRANDS.filter((b) => canSeeBrand(account, b.name));

  const brands = await Promise.all(
    visibleBrands.map(async (b) => {
      const override = await getDepositSheetOverride(env, MODULE_SLOT, b.id);
      const sheetId = override ? override.sheetId : b.id === "crickex" ? DEFAULT_CRICKEX_SHEET_ID : null;
      return { id: b.id, name: b.name, sheetId };
    })
  );

  return json({ ok: true, brands });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=60" } });
}
