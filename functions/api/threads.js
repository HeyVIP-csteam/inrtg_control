/**
 * GET /api/threads?q=<search>  -> { ok, active: [...], solved: [...] }
 * Lightweight summaries only (see functions/_shared/threads.js) — the
 * sidebar list. Fetch a single thread's full conversation via
 * GET /api/threads/<id>.
 */
import { listThreads } from "../_shared/threads.js";

export async function onRequestGet({ request, env }) {
  if (!env.THREADS_KV) {
    return json({ ok: true, active: [], solved: [], notConfigured: true });
  }
  const q = new URL(request.url).searchParams.get("q") || "";
  const all = await listThreads(env, { q });
  return json({
    ok: true,
    active: all.filter((t) => !t.solved),
    solved: all.filter((t) => t.solved),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
