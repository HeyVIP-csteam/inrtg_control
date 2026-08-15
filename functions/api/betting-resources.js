/**
 * GET /api/betting-resources -> { ok: true, rules, results, updatedAt }
 *
 * The betting-resources.html page's own data source. Any logged-in
 * agent can read this — same "content is published to everyone, only
 * EDITING it is gated" split as /api/announcements.js: viewing the page
 * itself isn't behind the `bettingLinks` admin-section permission,
 * saving changes to it is (see /api/admin/betting-resources.js).
 */
import { getBettingResources } from "../_shared/bettingResources.js";
import { verifyRequest } from "../_shared/accounts.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.THREADS_KV) return json({ ok: true, rules: null, results: [], updatedAt: null });
    const account = await verifyRequest(request, env);
    if (!account) return json({ ok: false, error: "Login required." }, 401);

    const config = await getBettingResources(env);
    return json({ ok: true, rules: config.rules, results: config.results, updatedAt: config.updatedAt });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
