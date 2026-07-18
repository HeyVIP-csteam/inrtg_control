/**
 * GET /api/deletion-log  -> { ok, entries }
 *
 * Not linked from anywhere in the agent-facing UI, AND now also requires
 * a logged-in account with role "admin" (see _shared/accounts.js) — the
 * URL alone used to be the only thing keeping it private; now a non-admin
 * agent account gets a 401 even if they find the URL.
 */
import { listDeletions } from "../_shared/threads.js";
import { verifyRequest } from "../_shared/accounts.js";

export async function onRequestGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const account = await verifyRequest(request, env);
  if (!account || account.role !== "admin") return json({ ok: false, error: "Admin login required." }, 401);
  const entries = await listDeletions(env);
  return json({ ok: true, entries });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
