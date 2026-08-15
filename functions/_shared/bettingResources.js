/**
 * bettingResources.js  (SERVER-ONLY)
 *
 * Backs the "HeyVIP Betting Rules" hub card — deliberately NOT a form
 * module like QA/Account Issue/etc (no Telegram post, no Sheet row, no
 * attachment). It's just a small, admin-editable link list rendered on
 * its own page (public/betting-resources.html):
 *
 *   - `rules`   -> ONE fixed link ("HeyVIP Betting Resources" panel)
 *   - `results` -> an array of links, any length ("Results Finding
 *                  Websites" panel), each independently addable/removable
 *
 * Storage: ONE THREADS_KV key holds the whole thing as a single JSON
 * object — same "a handful of records, so don't bother with list()+
 * metadata machinery" reasoning as announcements.js's single-array key.
 * Saves are a full overwrite of both `rules` and `results` together (see
 * saveBettingResources() below), not per-link — deliberately simple
 * since link count is small and edits are infrequent.
 *
 *   KV key: "betting-resources:config" -> {
 *     rules:   { name, url, icon },
 *     results: [ { name, url, icon }, ... ],
 *     updatedAt, updatedBy
 *   }
 *
 * ICONS: each link (the single `rules` link AND every `results` link)
 * can carry its own single-emoji `icon` — the reference screenshots
 * showed different icons per link type (football 🌐, cricket 🏏, live
 * scores 📺), not one shared icon for the whole panel. Older saves made
 * before this field existed won't have it in KV; sanitizeLink() below
 * fills in a default rather than erroring, so nothing breaks on read.
 */

const KV_KEY = "betting-resources:config";

const DEFAULT_RULES_ICON = "📄";
const DEFAULT_RESULT_ICON = "🔗";

function emptyConfig() {
  return {
    rules: { name: "HeyVIP Betting Rules", url: "", icon: DEFAULT_RULES_ICON },
    results: [],
    updatedAt: null,
    updatedBy: null,
  };
}

// A "single emoji" field — best-effort trim to something short rather
// than strictly validating grapheme count (emoji are multi-codepoint;
// rejecting valid ones on a technicality isn't worth it here). Falls
// back to the given default for anything empty/not-a-string.
function sanitizeIcon(icon, fallback) {
  const s = typeof icon === "string" ? icon.trim() : "";
  if (!s) return fallback;
  return s.slice(0, 8); // generous ceiling, not a strict grapheme count
}

function sanitizeLink(link, { name: fallbackName = "", fallbackIcon = DEFAULT_RESULT_ICON } = {}) {
  const name = (link && typeof link.name === "string" ? link.name.trim() : "") || fallbackName;
  const url = (link && typeof link.url === "string" ? link.url.trim() : "");
  const icon = sanitizeIcon(link && link.icon, fallbackIcon);
  return { name, url, icon };
}

/** Read the current config, with old/partial/missing KV data safely defaulted. */
export async function getBettingResources(env) {
  if (!env.THREADS_KV) return emptyConfig();
  let raw;
  try {
    raw = await env.THREADS_KV.get(KV_KEY);
  } catch {
    return emptyConfig();
  }
  if (!raw) return emptyConfig();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyConfig();
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  return {
    rules: sanitizeLink(parsed.rules, { name: "HeyVIP Betting Rules", fallbackIcon: DEFAULT_RULES_ICON }),
    results: results.map((r) => sanitizeLink(r, { fallbackIcon: DEFAULT_RESULT_ICON })),
    updatedAt: parsed.updatedAt || null,
    updatedBy: parsed.updatedBy || null,
  };
}

/**
 * Full overwrite — `rules` (single object) + `results` (array), written
 * together in one PUT. Empty `name`/`url` on the `rules` link is allowed
 * (nothing to show yet is a valid state, not an error); `results` rows
 * with a blank url are dropped rather than saved as dead links.
 */
export async function saveBettingResources(env, { rules, results }, actorUsername) {
  if (!env.THREADS_KV) throw new Error("THREADS_KV is not bound yet.");
  const safeRules = sanitizeLink(rules, { name: "HeyVIP Betting Rules", fallbackIcon: DEFAULT_RULES_ICON });
  const safeResults = (Array.isArray(results) ? results : [])
    .map((r) => sanitizeLink(r, { fallbackIcon: DEFAULT_RESULT_ICON }))
    .filter((r) => r.url); // no url = nothing to link to, don't persist it
  const config = {
    rules: safeRules,
    results: safeResults,
    updatedAt: new Date().toISOString(),
    updatedBy: actorUsername || "bootstrap",
  };
  await env.THREADS_KV.put(KV_KEY, JSON.stringify(config));
  return config;
}
