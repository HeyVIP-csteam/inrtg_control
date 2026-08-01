/**
 * POST /api/deposit-issue/update
 *
 * Writes back exactly ONE column — CS Remarks — the only CS-editable
 * field on the real INR sheet. The column letter comes from
 * ISSUE_COLUMNS (functions/_shared/depositColumns.js), same for every
 * brand's Deposit Issue sheet — Deposit Backup uses a different layout
 * entirely, but that module has no update endpoint (read-only), so it's
 * irrelevant here.
 *
 * Takes { sheetId, tabName, rowIndex, csRemarks }. `sheetId` is resolved
 * back to a brand (via the live "Deposit Sheet Link" overrides, not
 * trusted blindly) so canSeeBrand() can be enforced — an agent scoped to
 * one brand can't write to another brand's sheet just because they
 * know/guess its sheetId.
 */
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import { getAllDepositSheetOverrides } from "../../_shared/depositSheets.js";
import { updateRowByColumns } from "../../_shared/googleSheets.js";
import { getAccessToken } from "../../_shared/googleOAuth.js";
import { ISSUE_COLUMNS } from "../../_shared/depositColumns.js";

const MODULE_SLOT = "depositIssue"; // must match search.js / sheet-links.js
const CS_REMARKS_COL = ISSUE_COLUMNS.csRemarks;

async function findBrandForSheetId(env, sheetId) {
  const overrides = await getAllDepositSheetOverrides(env, MODULE_SLOT, Object.keys(BRANDS));
  const entry = Object.entries(overrides).find(([, o]) => o.sheetId === sheetId);
  return entry ? entry[0] : null;
}

export async function onRequestPost(context) {
  try {
    return await handleUpdate(context);
  } catch (e) {
    return json({ ok: false, error: `Update failed: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleUpdate({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { sheetId, tabName, rowIndex, csRemarks } = body || {};
  if (!sheetId || !tabName || !rowIndex) {
    return json({ ok: false, error: "Missing sheetId, tabName, or rowIndex." }, 400);
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    return json({ ok: false, error: "Invalid rowIndex." }, 400);
  }

  const brandId = await findBrandForSheetId(env, sheetId);
  if (!brandId) {
    return json({ ok: false, error: "That Sheet isn't one of the currently configured Deposit Issue sheets — try searching again." }, 400);
  }
  if (!canSeeBrand(account, BRANDS[brandId].name)) {
    return json({ ok: false, error: "You don't have access to this brand." }, 403);
  }

  try {
    const token = await getAccessToken(env);
    await updateRowByColumns(env, sheetId, tabName, CS_REMARKS_COL, rowIndex, [csRemarks || ""], token);
  } catch (e) {
    return json({ ok: false, error: `Sheets API error: ${String((e && e.message) || e)}` }, 502);
  }

  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
