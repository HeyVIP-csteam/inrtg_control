/**
 * /api/admin/offices
 *   GET                                  -> list offices
 *   POST { action:"save", id?, name, allowedIPs[] }  -> create/update
 *   POST { action:"delete", id }         -> delete
 *
 * Admin-gated — see authenticateAdmin() in _shared/accounts.js for the
 * two ways in (real admin login, or one-time bootstrap password).
 */
import { listOffices, saveOffice, deleteOffice, authenticateAdmin } from "../../_shared/accounts.js";

export async function onRequestGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: "Admin login required." }, 401);
  return json({ ok: true, offices: await listOffices(env) });
}

export async function onRequestPost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: "Admin login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.action === "save") {
    if (!body.name) return json({ ok: false, error: "Office name is required." }, 400);
    const office = await saveOffice(env, { id: body.id, name: body.name, allowedIPs: body.allowedIPs || [] });
    return json({ ok: true, office });
  }

  if (body.action === "delete") {
    if (!body.id) return json({ ok: false, error: "Missing office id." }, 400);
    await deleteOffice(env, body.id);
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
