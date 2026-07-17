/**
 * GET  /api/brand-config           -> { ok, config } — public, used to render the hub's brand pills
 * POST /api/brand-config           -> multipart form: password, brand, link, logo (file, optional)
 *                                      Requires `password` to match env.BRAND_EDIT_PASSWORD (a Cloudflare
 *                                      secret you set — whoever knows it can edit; nobody else can).
 *
 * Config is a small JSON blob stored in the R2 bucket (env.SCREENSHOTS_BUCKET) at
 * key "brand-config.json": { [brandId]: { logoUrl, link } }. Logo files themselves
 * are stored under "brand-logos/" and served back out through /api/screenshot/<key>.
 */
export async function onRequestGet({ env }) {
  const config = await readConfig(env);
  return json({ ok: true, config });
}

export async function onRequestPost({ request, env }) {
  const bucket = env.SCREENSHOTS_BUCKET;
  if (!bucket) return json({ ok: false, error: "Server is missing the SCREENSHOTS_BUCKET R2 binding." }, 500);
  if (!env.BRAND_EDIT_PASSWORD) return json({ ok: false, error: "Server is missing BRAND_EDIT_PASSWORD." }, 500);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Invalid form data." }, 400);
  }

  const password = form.get("password");
  if (password !== env.BRAND_EDIT_PASSWORD) {
    return json({ ok: false, error: "Wrong password." }, 403);
  }

  const brand = form.get("brand");
  if (!brand) return json({ ok: false, error: "Missing brand." }, 400);

  const config = await readConfig(env);
  const entry = config[brand] || {};

  const link = form.get("link");
  if (link !== null) entry.link = link || "";

  const logo = form.get("logo");
  if (logo && typeof logo === "object" && logo.size > 0) {
    const bytes = new Uint8Array(await logo.arrayBuffer());
    const ext = (logo.name && logo.name.includes(".") ? logo.name.split(".").pop() : "png").toLowerCase();
    const key = `brand-logos/${brand}-${Date.now()}.${ext}`;
    await bucket.put(key, bytes, { httpMetadata: { contentType: logo.type || "image/png" } });
    entry.logoUrl = `${new URL(request.url).origin}/api/screenshot/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

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
