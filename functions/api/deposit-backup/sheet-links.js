/**
 * GET /api/deposit-backup/sheet-links
 *
 * Same purpose as Deposit Issue's sheet-links.js: powers the "All
 * Brands" directory view (the only thing "All Brands" does here — no
 * cross-brand search, same as Deposit Issue). Returns, for every brand
 * the logged-in agent can see, whichever brands have This Month linked.
 */
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import { getDepositBackup, DEPOSIT_HIDDEN_BRANDS } from "../../_shared/depositSheets.js";

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
      const backup = await getDepositBackup(env, id);
      return {
        id,
        name: BRANDS[id].name,
        thisMonthSheetId: backup.thisMonth ? backup.thisMonth.sheetId : null,
      };
    })
  );

  return json({ ok: true, brands });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=60" } });
}
