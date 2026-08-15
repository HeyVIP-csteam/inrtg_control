/**
 * GET /api/deposit-backup/sheet-links
 *
 * Same purpose as Deposit Issue's sheet-links.js: powers the "All
 * Backup Sheets" directory view (default landing state, and the only
 * thing "All Brands" does here — no cross-brand search, same scaling
 * reasoning as Deposit Issue). Returns, for every brand the logged-in
 * agent can see, whichever of This Month / Last Month are currently
 * linked.
 *
 * Same canSeeBrand() filtering as search.js — an agent scoped to one
 * brand only ever gets that brand back.
 */
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { PKR_BRANDS, getDepositBackup } from "../../_shared/depositSheets.js";

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

  const visibleBrands = PKR_BRANDS.filter((b) => canSeeBrand(account, b.name));

  const brands = await Promise.all(
    visibleBrands.map(async (b) => {
      const backup = await getDepositBackup(env, b.id);
      return {
        id: b.id,
        name: b.name,
        thisMonthSheetId: backup.thisMonth ? backup.thisMonth.sheetId : null,
        lastMonthSheetId: backup.lastMonth ? backup.lastMonth.sheetId : null,
      };
    })
  );

  return json({ ok: true, brands });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=60" } });
}
