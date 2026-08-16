/**
 * POST /api/admin/backfill-mentions  { cursor?: string }
 *   -> { ok, scanned, done, cursor }
 *
 * One-time (well — safe to re-run, it's additive) backfill for the
 * @-mention registry (see _shared/threads.js's backfillMentionRegistryPage
 * and rememberMentionCandidate). Processes 100 threads per call; the
 * caller (Settings admin panel) keeps calling with the returned `cursor`
 * until `done` is true. Gated behind the "settings" Account Management
 * section, same as the maintenance-toggle panel it lives next to.
 */
import { authenticateStaff, ROLE_RANK, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { backfillMentionRegistryPage } from "../../_shared/threads.js";
import { logActivity } from "../../_shared/activityLog.js";

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "settings")) return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);

  let body = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine — starts from the beginning
  }

  const result = await backfillMentionRegistryPage(env, body.cursor || null);
  // Logged once — only on the FINAL page of a (possibly multi-call)
  // backfill run, not once per 100-thread page, so a large backfill
  // doesn't spam the Activity Logs table with dozens of near-identical
  // entries. Skipped on the intermediate pages entirely.
  if (result.done) {
    const p = logActivity(env, { category: "Config", action: "Mention Backfill Run", agent: auth.account ? auth.account.username : "bootstrap", ip: requestIP(request) || "unknown", detail: `Backfill completed — ${result.scanned ?? "?"} thread(s) scanned` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  }
  return json({ ok: true, ...result });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
