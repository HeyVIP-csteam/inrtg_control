/**
 * GET  /api/brand-config  -> { ok, config } — public, used to render the hub's brand pills
 * POST /api/brand-config  -> JSON { brand, link } — requires a logged-in account
 *                             (see _shared/accounts.js). Being logged in as any
 *                             agent IS the authorization now — no separate shared
 *                             edit password anymore.
 *
 * Config is a small JSON blob stored in the R2 bucket (env.SCREENSHOTS_BUCKET)
 * at key "brand-config.json": { [brandId]: { logoUrl, link } }.
 *
 * Logo image editing was removed this session — the file-upload path never
 * actually worked in production, so it's been taken out rather than left as
 * a broken control. `logoUrl` stays in the data shape (untouched, just
 * nothing currently writes it) so brand pills that have no logo simply show
 * colored initials until logo handling is redesigned.
 */
import { verifyRequest } from "../_shared/accounts.js";

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
  if (!bucket) return {};
  try {
    const obj = await bucket.get("brand-config.json");
    if (!obj) return {};
    return JSON.parse(await obj.text());
  } catch {
    return {};
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
