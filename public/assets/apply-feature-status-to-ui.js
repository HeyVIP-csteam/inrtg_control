/**
 * Client-side "gray out + badge + block click" for any card/link whose
 * feature is currently Maintenance/Coming soon. Pair with
 * maintenance-breathing-light.css. This is UX only — the real
 * enforcement must ALSO happen server-side (see backend/), since
 * anyone can skip the frontend and hit your API directly.
 *
 * ADAPT THESE THREE THINGS before using:
 *   1. `fetchJson` — replace with however your app makes authenticated
 *      requests (fetch + auth header, your own wrapper, etc).
 *   2. The endpoint URL "/api/feature-status" — point at wherever you
 *      mounted backend/public-feature-status-endpoint.js.
 *   3. `itemIdFor(el)` — however you map a DOM element to its feature-
 *      status item id (a data attribute is simplest, shown below).
 *
 * Usage:
 *   <a class="tool-card" id="threadsCard" data-feature-item="tg_reply_threads">...</a>
 *   <a class="sidebar-item" data-feature-item="qa">...</a>
 *
 *   applyFeatureStatuses({
 *     fetchJson: (url) => myAuthFetch(url).then((r) => r.json()),
 *     onBlocked: (msg) => myToast(msg), // called instead of navigating
 *   });
 *
 * IMPORTANT — call this ONCE on page load. Do NOT call it again right
 * after your own admin panel just saved a status change; see
 * applyFeatureStatusItem() below for why, and use that instead.
 */
async function applyFeatureStatuses({ fetchJson, onBlocked } = {}) {
  try {
    const data = await fetchJson("/api/feature-status");
    if (!data.ok) return;
    // Only touch elements that actually exist on this page — avoids
    // wasted work and matches applyFeatureStatusItem()'s per-item scope.
    const seen = new Set();
    document.querySelectorAll("[data-feature-item]").forEach((el) => seen.add(el.dataset.featureItem));
    seen.forEach((itemId) => applyFeatureStatusItem(itemId, data.items[itemId], { onBlocked }));
  } catch {
    // Non-fatal — elements just show without a status badge; the real
    // block still happens server-side if someone clicks/submits through.
  }
}

/**
 * Updates just the elements for ONE item, from data you already have in
 * hand (typically the response your admin panel's own Save/Reset POST
 * call just returned) instead of re-fetching /api/feature-status.
 *
 * WHY THIS EXISTS — LESSON LEARNED: Cloudflare KV (and most eventually-
 * consistent KV/edge stores) don't guarantee a get() immediately after a
 * put() sees the new value, especially from a different edge location.
 * If your admin panel's Save handler calls applyFeatureStatuses() again
 * right after saving, that re-fetch can still read the OLD value —
 * looking exactly like "the maintenance badge doesn't show up until I
 * refresh the page a few seconds later." Since your Save call's own POST
 * response already carries the value you just wrote, use THAT instead
 * of asking the server again. See settings-admin-panel.js's `onSaved`
 * callback for the intended call site.
 *
 * `item` shape: { status: "active"|"maintenance"|"coming_soon", blocked: boolean }
 * `blocked` should be computed by the caller against the CURRENT
 * viewer's own role — e.g.:
 *   blocked = status !== "active" && !bypassRoles.includes(myRole)
 */
function applyFeatureStatusItem(itemId, item, { onBlocked } = {}) {
  const badgeHtml = (status) => status === "coming_soon"
    ? '<span class="feature-status-badge fs-coming">🔜 Coming soon</span>'
    : '<span class="feature-status-badge fs-maint">🚧 Maintenance</span>';

  document.querySelectorAll(`[data-feature-item="${itemId}"]`).forEach((el) => {
    el.classList.remove("feature-status-dim");
    el.querySelector(".feature-status-badge")?.remove();
    if (el._featureStatusBlockHandler) {
      el.removeEventListener("click", el._featureStatusBlockHandler);
      el._featureStatusBlockHandler = null;
    }
    if (!item || item.status === "active") return;
    el.classList.add("feature-status-dim");
    el.insertAdjacentHTML("beforeend", badgeHtml(item.status));
    if (item.blocked) {
      el._featureStatusBlockHandler = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const msg = item.status === "coming_soon"
          ? "🔜 Not available yet, please check back later."
          : "⚠️ Under maintenance, please try again later.";
        if (onBlocked) onBlocked(msg);
        else alert(msg);
      };
      el.addEventListener("click", el._featureStatusBlockHandler, { capture: true });
    }
  });
}
