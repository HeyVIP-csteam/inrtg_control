/**
 * GET /api/deletion-log  -> { ok, entries }
 *
 * Not linked from anywhere in the agent-facing UI — reachable only if you
 * know this exact path. No password gate yet (can be added later); treat
 * the URL itself as the only thing keeping it private for now.
 */
import { listDeletions } from "../_shared/threads.js";

export async function onRequestGet({ env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const entries = await listDeletions(env);
  return json({ ok: true, entries });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
