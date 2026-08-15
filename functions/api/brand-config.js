/**
 * GET  /api/brand-config  -> { ok, config } — public, used to render the hub's brand pills
 * POST /api/brand-config  -> JSON { brand, link } — requires Can-Edit access to
 *                             the "webLinks" Account Management Access section
 *                             (see _shared/accounts.js). Editing here moved
 *                             behind that gate 2026-08-15 — previously any
 *                             logged-in agent could save through this endpoint
 *                             (via the home page pill's own ✏️ button, now
 *                             removed); the real editing surface is now the
 *                             "Web Link" admin page (functions/api/admin/
 *                             web-links.js), which posts to this same endpoint.
 *                             GET stays fully public/unauthenticated on
 *                             purpose — any agent still needs to read the
 *                             links to render + click the pills, only saving
 *                             a new link is gated.
 *
 * Config is a small JSON blob stored in the R2 bucket (env.SCREENSHOTS_BUCKET)
 * at key "brand-config.json": { [brandId]: { logoUrl, link } }.
 *
 * Logo image UPLOADING was removed in an earlier session — the file-upload
 * path never actually worked in production, so it was taken out rather than
 * left as a broken control. Real logos came back a different way this
 * session: static files checked into the repo
 * (public/assets/img/brands/<brandId>.png) with DEFAULT_LOGOS below mapping
 * each brand to its file. readConfig() fills in a brand's `logoUrl` from
 * this map whenever R2 doesn't already have one set for it — so nothing
 * needs to be "uploaded" through the app, and if `link`-only edits happen
 * through the POST endpoint, an existing default logo is left alone (not
 * overwritten with nothing).
 *
 * Jeetway's logo is its live-chat bubble icon (confirmed by the business
 * owner) — small source image (60×60), upscaled to match the others;
 * looks fine at the 24px pill size this actually renders at.
 */
import { authenticateStaff, ROLE_RANK, canEditAdminSection } from "../_shared/accounts.js";

const DEFAULT_LOGOS = {
  crickex: "/assets/img/brands/crickex.png",
  betjili: "/assets/img/brands/betjili.png",
  mostplay: "/assets/img/brands/mostplay.png",
  betvisa: "/assets/img/brands/betvisa.png",
  jeetway: "/assets/img/brands/jeetway.png",
};

export async function onRequestGet(context) {
  try {
    const { env } = context;
    const config = await readConfig(env);
    return json({ ok: true, config });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  const bucket = env.SCREENSHOTS_BUCKET;
  if (!bucket) return json({ ok: false, error: "Server is missing the SCREENSHOTS_BUCKET R2 binding." }, 500);

  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Login required." }, 401);
  if (!canEditAdminSection(auth.account, "webLinks")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Web Link." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { brand, link } = body || {};
  if (!brand) return json({ ok: false, error: "Missing brand." }, 400);

  const config = await saveLink(env, brand, link);
  return json({ ok: true, config });
}

// Shared with functions/api/admin/web-links.js — the "Web Link" admin page
// posts through THIS same /api/brand-config endpoint (see the file header),
// so both stay backed by the exact one write path instead of two copies of
// the R2 read-modify-write that could drift out of sync.
export async function saveLink(env, brand, link) {
  const bucket = env.SCREENSHOTS_BUCKET;
  if (!bucket) throw new Error("Server is missing the SCREENSHOTS_BUCKET R2 binding.");
  const config = await readConfig(env);
  const entry = config[brand] || {};
  if (link !== undefined) entry.link = link || "";
  config[brand] = entry;
  await bucket.put("brand-config.json", JSON.stringify(config), { httpMetadata: { contentType: "application/json" } });
  return config;
}

export async function readConfig(env) {
  const bucket = env.SCREENSHOTS_BUCKET;
  let config = {};
  if (bucket) {
    try {
      const obj = await bucket.get("brand-config.json");
      if (obj) config = JSON.parse(await obj.text());
    } catch {
      config = {};
    }
  }
  // Fill in each brand's default logo (from the static files checked into
  // the repo) whenever R2 doesn't already have a logoUrl set for it — see
  // the file header for why this replaced the old upload-based approach.
  for (const [brandId, logoUrl] of Object.entries(DEFAULT_LOGOS)) {
    const entry = config[brandId] || {};
    if (!entry.logoUrl) entry.logoUrl = logoUrl;
    config[brandId] = entry;
  }
  return config;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
