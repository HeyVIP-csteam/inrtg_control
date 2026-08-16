/**
 * /api/admin/web-links  ("Web Link" admin page)
 *
 * Manages the URL each home-page brand pill (public/index.html's marquee
 * row) opens when clicked. Used to be editable inline by any logged-in
 * agent via a ✏️ button on the pill itself — moved here 2026-08-15 so only
 * the Owner (or an account the Owner has explicitly granted the "webLinks"
 * Account Management Access section to) can change it. Same public-read/
 * gated-write shape as Betting Resources Links: any logged-in agent can
 * still see and click the pills — GET /api/brand-config stays fully
 * unauthenticated — only SAVING a new link is gated here.
 *
 * Storage stays exactly as it was: the small JSON blob in R2
 * (env.SCREENSHOTS_BUCKET, key "brand-config.json") that
 * functions/api/brand-config.js already reads/writes — there's no KV
 * override/reset model here like Deposit Sheet Link or TG Group/Channel,
 * a brand's link is just "whatever's currently saved" (default "").
 *
 *   GET
 *     -> { ok: true, brands: [{id,name}], links: { [brandId]: { link } } }
 *        Requires Can-See access to the "webLinks" admin section.
 *
 *   POST { action:"save", brandId, link } -> saves through the exact same
 *     R2 write path as /api/brand-config's own POST (see saveLink() in
 *     that file) — both endpoints stay backed by one write path so they
 *     can never drift out of sync. Takes effect immediately, no redeploy
 *     needed. Requires Can-Edit access to the "webLinks" admin section.
 *
 *   POST { action:"reset", brandId } -> clears the link back to "" (the
 *     pill simply won't open anything until a new link is saved). There's
 *     no separate "override vs default" state to revert to here, unlike
 *     Deposit Sheet Link/TG Group-Channel — "reset" just means "clear it".
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import { readConfig, saveLink } from "../brand-config.js";
import { logActivity } from "../../_shared/activityLog.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "webLinks")) {
    return json({ ok: false, error: "You don't have access to Web Link." }, 403);
  }

  const brandIds = Object.keys(BRANDS);
  const config = await readConfig(env);

  const brands = brandIds.map((id) => ({ id, name: BRANDS[id].name }));
  const links = {};
  for (const brandId of brandIds) {
    links[brandId] = { link: (config[brandId] && config[brandId].link) || "" };
  }

  return json({ ok: true, brands, links });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "webLinks")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Web Link." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const brandId = body.brandId;
  if (!BRANDS[brandId]) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
  const log = (entry) => {
    const p = logActivity(env, { category: "Config", agent: auth.account ? auth.account.username : "bootstrap", ip: requestIP(request) || "unknown", ...entry });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  };

  if (body.action === "save") {
    try {
      await saveLink(env, brandId, body.link || "");
      log({ action: "Web Link Changed", detail: `${brandId}: link set to ${body.link || "(empty)"}` });
      return json({ ok: true, brandId, link: body.link || "" });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await saveLink(env, brandId, "");
    log({ action: "Web Link Reset", detail: `${brandId}: link cleared` });
    return json({ ok: true, brandId, link: "" });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
