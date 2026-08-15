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
 *     rules: { name: string, url: string, icon?: string },        // single link, left panel
 *     results: [{ name: string, url: string, icon?: string }, …],  // link list, right panel
 *     updatedAt: ISO string,
 *     updatedBy: username
 *   }
 * `icon` is a single emoji, editable per-link from the admin panel
 * (e.g. 🌐 for a football site, 🏏 for cricket, 📺 for a live tracker) —
 * optional, falls back to a generic 🔗/📄 default when not set.
 */

const KV_KEY = "betting-resources:config";
const DEFAULT_RULES_ICON = "📄";
const DEFAULT_RESULT_ICON = "🔗";

const DEFAULT_CONFIG = {
  rules: { name: "HeyVIP Betting Rules", url: "", icon: DEFAULT_RULES_ICON },
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
    const rules = parsed.rules && typeof parsed.rules === "object" ? parsed.rules : DEFAULT_CONFIG.rules;
    return {
      rules: { ...rules, icon: rules.icon || DEFAULT_RULES_ICON },
      results: (Array.isArray(parsed.results) ? parsed.results : []).map((l) => ({ ...l, icon: l.icon || DEFAULT_RESULT_ICON })),
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
    icon: String((rules && rules.icon) || "").trim() || DEFAULT_RULES_ICON,
  };
  const cleanResults = (Array.isArray(results) ? results : [])
    .map((l) => ({
      name: String((l && l.name) || "").trim(),
      url: String((l && l.url) || "").trim(),
      icon: String((l && l.icon) || "").trim() || DEFAULT_RESULT_ICON,
    }))
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
