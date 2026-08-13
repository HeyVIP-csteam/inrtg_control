/**
 * KV-backed storage for the "HeyVIP Betting Rules" home card
 * (public/betting-resources.html) — a live-editable link list, edited
 * from Account Management → Betting Resources Links (SuperAdmin only,
 * see ADMIN_SECTIONS_LIST in _shared/accounts.js), read by anyone
 * logged in via GET /api/betting-resources.
 *
 * Stored as a single JSON blob in THREADS_KV (same namespace every
 * other KV-backed feature in this hub already uses — no new binding
 * needed) under one fixed key. Shape:
 *   {
 *     rules: { name: string, url: string },        // single link, left panel
 *     results: [{ name: string, url: string }, …],  // link list, right panel
 *     updatedAt: ISO string,
 *     updatedBy: username
 *   }
 */

const KV_KEY = "betting-resources:config";

const DEFAULT_CONFIG = {
  rules: { name: "HeyVIP Betting Rules", url: "" },
  results: [],
  updatedAt: null,
  updatedBy: null,
};

export async function getBettingResources(env) {
  const kv = env.THREADS_KV;
  if (!kv) return DEFAULT_CONFIG;
  try {
    const raw = await kv.get(KV_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    return {
      rules: parsed.rules && typeof parsed.rules === "object" ? parsed.rules : DEFAULT_CONFIG.rules,
      results: Array.isArray(parsed.results) ? parsed.results : [],
      updatedAt: parsed.updatedAt || null,
      updatedBy: parsed.updatedBy || null,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveBettingResources(env, { rules, results, updatedBy }) {
  const kv = env.THREADS_KV;
  if (!kv) throw new Error("Server is missing the THREADS_KV binding.");

  const cleanRules = {
    name: String((rules && rules.name) || "").trim(),
    url: String((rules && rules.url) || "").trim(),
  };
  const cleanResults = (Array.isArray(results) ? results : [])
    .map((l) => ({ name: String((l && l.name) || "").trim(), url: String((l && l.url) || "").trim() }))
    .filter((l) => l.name && l.url);

  const config = {
    rules: cleanRules,
    results: cleanResults,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || null,
  };
  await kv.put(KV_KEY, JSON.stringify(config));
  return config;
}
