/**
 * /api/admin/betting-resources — the "🔗 Betting Resources Links" panel's
 * API (Account Management → Betting Resources Links).
 *
 * Gated by the `bettingLinks` Account-Management-Access section (see
 * accounts.js), same per-section view/edit mechanism as TG Group/Channel
 * and Deposit Sheet Link — NOT a flat rank check. Rank-tiered default is
 * SuperAdmin-and-above only (see defaultSectionsForRank/
 * defaultEditForRank in accounts.js — "bettingLinks" isn't in any
 * rank-below-superadmin bucket, so nothing below SuperAdmin sees it
 * unless an Owner explicitly grants it).
 *
 *   GET  -> { ok: true, rules, results, updatedAt, updatedBy }
 *   POST { rules: {name,url,icon}, results: [{name,url,icon}, ...] }
 *        -> { ok: true, rules, results, updatedAt, updatedBy }
 *          (full overwrite of both fields together — see
 *          saveBettingResources() in _shared/bettingResources.js for why
 *          this is deliberately not per-link)
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection } from "../../_shared/accounts.js";
import { getBettingResources, saveBettingResources } from "../../_shared/bettingResources.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "bettingLinks")) {
    return json({ ok: false, error: "You don't have access to Betting Resources Links." }, 403);
  }

  const config = await getBettingResources(env);
  return json({ ok: true, ...config });
}

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
  if (!canEditAdminSection(auth.account, "bettingLinks")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Betting Resources Links." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const config = await saveBettingResources(env, { rules: body.rules, results: body.results }, auth.account?.username || "bootstrap");
  return json({ ok: true, ...config });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
