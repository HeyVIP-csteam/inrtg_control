/**
 * GET /api/betting-resources -> { ok, data } — any logged-in agent, powers
 * public/betting-resources.html. Editing happens through the SuperAdmin-
 * only /api/admin/betting-resources instead (see ADMIN_SECTIONS_LIST's
 * "bettingLinks" entry in _shared/accounts.js).
 */
import { verifyRequest } from "../_shared/accounts.js";
import { getBettingResources } from "../_shared/bettingResources.js";

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

  const data = await getBettingResources(env);
  return json({ ok: true, data });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
