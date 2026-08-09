/**
 * GET /api/mention-candidates?brandId=<id>&module=<id>
 *   -> { ok: true, candidates: [{ handle, from, lastSeen }, ...] }
 *
 * Backs the @ Tag Username autocomplete in the reply box (public/
 * threads.html) — the list of Telegram usernames who've been seen
 * replying in this specific brand+module's TG group/topic before (see
 * _shared/threads.js's rememberMentionCandidate / getMentionCandidates
 * for how the registry is built). Requires a logged-in account, same as
 * every other TG Reply Threads endpoint — no extra brand-scoping beyond
 * that, since a username alone isn't sensitive and the page already
 * only ever asks for the brand+module of a ticket the agent can already
 * see.
 */
import { getMentionCandidates } from "../_shared/threads.js";
import { verifyRequest } from "../_shared/accounts.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: true, candidates: [] });
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const url = new URL(request.url);
  const brandId = url.searchParams.get("brandId") || "";
  const moduleId = url.searchParams.get("module") || "";
  if (!brandId || !moduleId) return json({ ok: true, candidates: [] });

  const candidates = await getMentionCandidates(env, brandId, moduleId);
  return json({ ok: true, candidates });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
