/**
 * POST /api/admin/mention-backfill
 *
 * One-time (safe to re-run) tool that backfills the "@ Tag Username"
 * mention-candidate registry (see _shared/threads.js) for tickets that
 * predate that feature — without it, only people who reply AFTER the
 * feature shipped ever get suggested. Gated behind the same "settings"
 * Account Management Access section as the rest of the Settings tab.
 *
 * Body: { cursor: string|null }  (omit/null to start from the beginning)
 * -> { ok: true, scanned, done, cursor }
 *   scanned  - how many threads THIS page processed
 *   done     - true once there are no more pages
 *   cursor   - pass this back in as `cursor` for the next call; null once done
 *
 * public/index.html's Settings tab drives the pagination itself, calling
 * this repeatedly and accumulating `scanned` into a running total shown
 * as "Scanning… N threads so far." — kept as small per-call pages (100
 * threads, see backfillMentionCandidatesPage) so a single request never
 * risks hitting Cloudflare Pages Functions' execution time limit even on
 * a large ticket history.
 */
import { authenticateStaff, ROLE_RANK, canEditAdminSection } from "../../_shared/accounts.js";
import { backfillMentionCandidatesPage } from "../../_shared/threads.js";

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // Empty/missing body is fine — it just means "start from the beginning".
  }

  const { scanned, nextCursor } = await backfillMentionCandidatesPage(env, body.cursor || undefined);
  return json({ ok: true, scanned, done: !nextCursor, cursor: nextCursor || null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
