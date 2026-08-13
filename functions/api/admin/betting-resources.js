/**
 * POST /api/admin/betting-resources { rules: {name,url}, results: [{name,url},…] }
 * -> saves the whole link list in one shot (this panel has no per-row
 * save — see public/index.html's "Betting Resources Links" modal).
 * Requires Can-Edit access to the "bettingLinks" admin section (see
 * ADMIN_SECTIONS_LIST in _shared/accounts.js — SuperAdmin/Owner by
 * default, same tier as TG Group / Channel).
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { saveBettingResources } from "../../_shared/bettingResources.js";

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
  if (!canSeeAdminSection(auth.account, "bettingLinks")) {
    return json({ ok: false, error: "You don't have access to Betting Resources Links." }, 403);
  }
  if (!canEditAdminSection(auth.account, "bettingLinks")) {
    return json({ ok: false, error: "View only — you can't edit Betting Resources Links." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { rules, results } = body || {};
  const config = await saveBettingResources(env, { rules, results, updatedBy: auth.account.username });
  return json({ ok: true, data: config });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
