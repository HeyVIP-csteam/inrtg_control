/**
 * GET /api/mention-candidates?brandId=...&module=...
 *   -> { ok, items: [{ handle, from, lastSeen }] }
 *
 * Backs the @-mention autocomplete in threads.html's reply box. Scoped to
 * one brand+module pair — the same granularity as a routing.js
 * chatId/topicId (a brand's Risk Issue Telegram topic has a different
 * pool of people than that same brand's Withdraw Issue topic), so the
 * suggestions only ever include people plausibly reachable in the
 * specific group you're replying into. See
 * _shared/threads.js's rememberMentionCandidate()/getMentionCandidates().
 */
import { verifyRequest } from "../_shared/accounts.js";
import { getMentionCandidates } from "../_shared/threads.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const url = new URL(request.url);
  const brandId = url.searchParams.get("brandId") || "";
  const moduleId = url.searchParams.get("module") || "";
  if (!moduleId) return json({ ok: false, error: "Missing module." }, 400);

  const items = await getMentionCandidates(env, brandId, moduleId);
  return json({ ok: true, items });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
