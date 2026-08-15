/**
 * GET /api/deposit-issue/sheet-links
 *
 * Powers the "All Brands" directory view on the Deposit Issue page: a
 * list of "<Brand> Deposit Gsheet — Open Sheet" cards, one per brand the
 * logged-in agent can see, instead of an actual cross-brand search.
 * Same canSeeBrand() filtering as search.js/update.js.
 */
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import { getDepositSheetOverride, DEPOSIT_HIDDEN_BRANDS } from "../../_shared/depositSheets.js";

const MODULE_SLOT = "depositIssue";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const visibleBrandIds = Object.keys(BRANDS)
    .filter((id) => !DEPOSIT_HIDDEN_BRANDS.includes(id))
    .filter((id) => canSeeBrand(account, BRANDS[id].name));

  const brands = await Promise.all(
    visibleBrandIds.map(async (id) => {
      const override = await getDepositSheetOverride(env, MODULE_SLOT, id);
      return { id, name: BRANDS[id].name, sheetId: override ? override.sheetId : null };
    })
  );

  return json({ ok: true, brands });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=60" } });
}
