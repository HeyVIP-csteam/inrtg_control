/**
 * Client-side "gray out + badge + block click" for any card/link whose
 * feature is currently Maintenance/Coming soon. Pair with
 * feature-status.css. This is UX only — the real enforcement happens
 * server-side in submit.js/threads.js/promo-search.js/deposit-issue/
 * deposit-backup (see functions/_shared/featureStatus.js) — anyone can
 * skip this and hit the API directly, so it changes nothing security-wise.
 *
 * Usage: add data-feature-item="<id>" to any element (see the ids in
 * functions/_shared/featureStatus.js's FEATURE_STATUS_ITEMS), then call:
 *   applyFeatureStatuses();
 * after the elements exist in the DOM. Requires authguard.js loaded
 * first (uses window.AgentAuth.authFetch).
 *
 * applyFeatureStatusItem(itemId, item) updates just the elements for ONE
 * item, from data you already have in hand (e.g. the Settings admin
 * panel's own Save response) instead of fetching /api/feature-status
 * again. This matters because Cloudflare KV is only eventually
 * consistent — a put() the Settings panel just made isn't guaranteed to
 * be visible to a get() from a fresh request a moment later, so
 * re-fetching right after Save can still read the OLD value and look
 * like "nothing happened until I refresh". Using the value the Save
 * call already returned sidesteps that entirely.
 */
function fsBadgeHtml(status) {
  return status === "coming_soon"
    ? '<span class="feature-status-badge fs-coming">🔜 Coming soon</span>'
    : '<span class="feature-status-badge fs-maint">🚧 Maintenance</span>';
}

function applyFeatureStatusItem(itemId, item, opts) {
  opts = opts || {};
  document.querySelectorAll(`[data-feature-item="${itemId}"]`).forEach((el) => {
    el.classList.remove("feature-status-dim");
    el.querySelector(".feature-status-badge")?.remove();
    if (el._featureStatusBlockHandler) {
      el.removeEventListener("click", el._featureStatusBlockHandler);
      el._featureStatusBlockHandler = null;
    }
    if (!item || item.status === "active") return;
    el.classList.add("feature-status-dim");
    el.insertAdjacentHTML("beforeend", fsBadgeHtml(item.status));
    if (item.blocked) {
      el._featureStatusBlockHandler = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const msg = item.status === "coming_soon"
          ? "🔜 Not available yet, please check back later."
          : "⚠️ Under maintenance, please try again later.";
        if (opts.onBlocked) opts.onBlocked(msg);
        else alert(msg);
      };
      el.addEventListener("click", el._featureStatusBlockHandler, { capture: true });
    }
  });
}

async function applyFeatureStatuses(opts) {
  opts = opts || {};
  try {
    const res = await window.AgentAuth.authFetch("/api/feature-status");
    const data = await res.json();
    if (!data.ok) return;
    const seen = new Set();
    document.querySelectorAll("[data-feature-item]").forEach((el) => seen.add(el.dataset.featureItem));
    seen.forEach((itemId) => applyFeatureStatusItem(itemId, data.items[itemId], opts));
  } catch {
    // Non-fatal — elements just show without a status badge; the real
    // block still happens server-side if someone clicks/submits through.
  }
}
