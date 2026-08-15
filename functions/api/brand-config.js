/**
 * GET  /api/brand-config  -> { ok, config } — public, used to render the hub's brand pills
 * POST /api/brand-config  -> JSON { brand, link } — this is the "Web Link" panel under
 *                             Integration Portal (public/index.html's Account Management
 *                             modal, mode "weblink") as well as the inline pencil-icon
 *                             edit on each brand pill on the Home marquee row itself —
 *                             both call this same endpoint. Requires
 *                             canEditAdminSection(account, "webLink") (see
 *                             _shared/accounts.js) — 2026-08: previously ANY logged-in
 *                             account could POST here regardless of rank/section access
 *                             (there was no separate shared edit password, but also no
 *                             per-section gate at all); now gated the same way as every
 *                             other Integration Portal item (tgRoutes/depositSheets/
 *                             bettingLinks).
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
import { verifyRequest, canEditAdminSection } from "../_shared/accounts.js";

// PKR market: 3 of the 9 brands (Crickex/Betjili/Mostplay) are the same
// actual brand/logo as the INR build this was forked from — confirmed by
// the business owner — so their existing PNGs were kept and re-mapped
// here. The other 6 (jeetwin/sbj66/heybaji/superbaji/kv8/darazplay) have
// no logo file yet; the old betvisa.png/jeetway.png files were deleted
// entirely since those brands don't exist in this deployment. readConfig()
// below already handles a brand with no logoUrl gracefully (falls back to
// initials + a color), so the missing 6 aren't blocking anything. To add a
// real logo for one of them: drop the image at
// public/assets/img/brands/<brandId>.png and add a line here, e.g.
// jeetwin: "/assets/img/brands/jeetwin.png".
// PKR market: 3 of the 9 brands (Crickex/Betjili/Mostplay) are the same
// actual brand/logo as the INR build this was forked from — confirmed by
// the business owner — so their existing PNGs were kept and re-mapped
// here. The other 6 (Jeetwin/Sbj66/Heybaji/Superbaji/KV8/Darazplay) now
// have their own real logo files too, provided directly by the business
// owner. readConfig() below already handles a brand with no logoUrl
// gracefully (falls back to initials + a color), so this was never a
// hard blocker — but all 9 brands now have real logos either way.
const DEFAULT_LOGOS = {
  crickex: "/assets/img/brands/crickex.png",
  betjili: "/assets/img/brands/betjili.png",
  mostplay: "/assets/img/brands/mostplay.png",
  jeetwin: "/assets/img/brands/jeetwin.png",
  sbj66: "/assets/img/brands/sbj66.png",
  heybaji: "/assets/img/brands/heybaji.png",
  superbaji: "/assets/img/brands/superbaji.png",
  kv8: "/assets/img/brands/kv8.png",
  darazplay: "/assets/img/brands/darazplay.png",
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

  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);
  if (!canEditAdminSection(account, "webLink")) {
    return json({ ok: false, error: "You don't have permission to edit Web Link." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { brand, link } = body || {};
  if (!brand) return json({ ok: false, error: "Missing brand." }, 400);

  const config = await readConfig(env);
  const entry = config[brand] || {};
  if (link !== undefined) entry.link = link || "";

  config[brand] = entry;
  await bucket.put("brand-config.json", JSON.stringify(config), { httpMetadata: { contentType: "application/json" } });

  return json({ ok: true, config });
}

async function readConfig(env) {
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
