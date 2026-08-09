import { getAccessToken } from "../../_shared/googleOAuth.js";
import { verifyRequest, canSeeBrand } from "../../_shared/accounts.js";
import { PKR_BRANDS, getAllDepositSheetOverrides } from "../../_shared/depositSheets.js";
import { getFeatureStatus, accountCanBypass } from "../../_shared/featureStatus.js";

// Must match search.js's MODULE_SLOT and hardcoded Crickex default — see
// that file for the full explanation of the KV-override-over-code-default
// layering.
const MODULE_SLOT = "depositIssue";
const DEFAULT_CRICKEX_SHEET_ID = "1HByPuZMuuYZL9S5fPPGjb8RAmCwNVgKXvuLgVBbVM-E";
const EDITABLE_RANGE_COLS = "P:S"; // CS PIC, Player Contact No, Status CS, Correct UID

// Now that each brand can point at a different Sheet, the frontend has
// to tell us WHICH sheetId a given row came from (search.js already
// includes it on every result — see curDep.sheetId in deposit-issue.html).
// Rather than trusting that value blindly, resolve it back to a brand
// two ways: (1) confirms it's actually one of the currently-configured
// Deposit Issue sheets, not an arbitrary Sheet ID the OAuth account
// happens to have edit access to, and (2) tells us which brand it is,
// so canSeeBrand() can be enforced below (an agent scoped to Crickex
// only shouldn't be able to write to Betjili's sheet just because they
// know/guess its sheetId).
async function findBrandForSheetId(env, sheetId) {
  if (sheetId === DEFAULT_CRICKEX_SHEET_ID) return "crickex";
  const overrides = await getAllDepositSheetOverrides(env, MODULE_SLOT, PKR_BRANDS.map((b) => b.id));
  const entry = Object.entries(overrides).find(([, o]) => o.sheetId === sheetId);
  return entry ? entry[0] : null;
}

export async function onRequestPost(context) {
  try {
    return await handleUpdate(context);
  } catch (e) {
    return json({ ok: false, error: `Update failed: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleUpdate({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const featureStatus = await getFeatureStatus(env, "deposit_issue");
  if (featureStatus.status !== "active" && !accountCanBypass(account, featureStatus.bypassRoles)) {
    return json({ ok: false, error: featureStatus.status === "coming_soon" ? "Deposit Issue isn't available yet." : "Deposit Issue is currently under maintenance." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { sheetId, tabName, rowIndex, csPIC, playerContactNo, statusCS, correctUid } = body || {};
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
  const brandMeta = PKR_BRANDS.find((b) => b.id === brandId);
  if (!canSeeBrand(account, brandMeta.name)) {
    return json({ ok: false, error: "You don't have access to this brand." }, 403);
  }

  const accessToken = await getAccessToken(env);
  const range = `'${tabName}'!${EDITABLE_RANGE_COLS.split(":")[0]}${rowIndex}:${EDITABLE_RANGE_COLS.split(":")[1]}${rowIndex}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      range,
      majorDimension: "ROWS",
      values: [[csPIC || "", playerContactNo || "", statusCS || "", correctUid || ""]],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    return json({ ok: false, error: `Sheets API error: ${data.error?.message || res.status}` }, 502);
  }

  return json({ ok: true, updatedRange: data.updatedRange || range });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

