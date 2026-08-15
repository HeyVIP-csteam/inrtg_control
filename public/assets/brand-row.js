/**
 * brand-row.js  (SHARED — used by every standalone sub-page: threads.html,
 * form.html, announcements.html, promo.html, deposit-issue.html,
 * deposit-backup.html)
 *
 * Renders the same scrolling brand-logo marquee that lives in index.html's
 * own persistent header (below the topbar, above the announcement banner)
 * — matches the INR build's layout, where this row is visible on every
 * page, not just Home. index.html does NOT use this file: it has its own
 * richer inline version (brand pills are clickable AND editable there —
 * see openEditModal()/editModalBackdrop in index.html). This is
 * deliberately the simpler READ-ONLY version (logo + name, click opens
 * the brand's link, no edit pencil) — bringing the full edit-modal
 * machinery to every sub-page just for this would be a lot of duplicated
 * UI for a feature that's only ever needed from the hub itself.
 *
 * Under the SPA shell (spa-shell.js), this script still gets re-fetched
 * and re-run on every view mount (it's not in spa-shell.js's
 * SHELL_OWNED_SCRIPTS list) — but mount() below no-ops cleanly if its
 * target element isn't found, and on that path it never is: the shell's
 * OWN persistent marquee (index.html's own #brandRow, always visible,
 * never touched by this file) already covers every SPA-mounted view, so
 * there's nothing for this file to do there. This file's markup and
 * mount() call only exist to make each of these pages fully correct when
 * visited on their own (bookmark, new tab, direct link) — see each
 * page's own <nav class="brand-row" id="pageBrandRow"> placeholder,
 * intentionally a DIFFERENT id than index.html's #brandRow so the two
 * can never collide if both ever ended up in the live DOM at once.
 *
 * Requires (must be loaded first): authguard.js (window.AgentAuth),
 * schemas.js (window.BRANDS).
 */
(function () {
  const BRAND_COLORS = ["#4fc3f7", "#f6ad55", "#f4718a", "#8b5cf6", "#34d399"];

  function buildBrandPill(b, i, brandConfig) {
    const entry = brandConfig[b.id] || {};
    const el = document.createElement("div");
    el.className = "brand-pill";
    const initials = b.name.slice(0, 2).toUpperCase();
    const avatar = entry.logoUrl
      ? `<img class="avatar" src="${entry.logoUrl}" alt="${b.name}" />`
      : `<span class="avatar" style="background:${BRAND_COLORS[i % BRAND_COLORS.length]};">${initials}</span>`;
    el.innerHTML = `${avatar}<span class="pill-name">${b.name}</span>`;
    if (entry.link) {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => window.open(entry.link, "_blank", "noopener"));
    }
    return el;
  }

  let resizeWired = false;

  window.BrandRow = {
    /**
     * @param {string} mountId  id of the <nav class="brand-row"> element
     *   whose single <div class="brand-row-track"> child gets filled in
     *   (each page's own #pageBrandRow — NOT index.html's #brandRow).
     */
    async mount(mountId) {
      const rowEl = document.getElementById(mountId);
      if (!rowEl) return;
      const trackEl = rowEl.querySelector(".brand-row-track");
      if (!trackEl) return;

      let brandConfig = {};
      try {
        const res = await fetch("/api/brand-config");
        const data = await res.json();
        if (data.ok) brandConfig = data.config || {};
      } catch {
        // Non-fatal — pills just fall back to colored initials, same as
        // index.html's own version.
      }

      const visibleBrands = window.AgentAuth ? window.AgentAuth.filterAllowedBrands(window.BRANDS) : window.BRANDS;
      if (!visibleBrands || !visibleBrands.length) return;

      // Same measure-then-build approach as index.html's renderBrandRow()
      // — see the comment there for why, and for why the clientWidth-0
      // guard below matters (a page that's mid-navigation or briefly
      // hidden must not measure a 0 width and build a runaway number of
      // copies from it).
      trackEl.innerHTML = "";
      if (rowEl.clientWidth === 0) return;

      visibleBrands.forEach((b, i) => trackEl.appendChild(buildBrandPill(b, i, brandConfig)));
      const oneCopyWidth = trackEl.scrollWidth || 1;
      const containerWidth = rowEl.clientWidth;
      const copiesPerHalf = Math.max(1, Math.ceil(containerWidth / oneCopyWidth) + 1);

      trackEl.innerHTML = "";
      for (let half = 0; half < 2; half++) {
        for (let copy = 0; copy < copiesPerHalf; copy++) {
          visibleBrands.forEach((b, i) => trackEl.appendChild(buildBrandPill(b, i, brandConfig)));
        }
      }

      // Re-measure and rebuild on resize (debounced), same reasoning as
      // index.html's own version — a copy count picked for one window
      // width can fall short after the window gets wider. Wired once
      // regardless of how many times mount() itself is called.
      if (!resizeWired) {
        resizeWired = true;
        let resizeTimer = null;
        window.addEventListener("resize", () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => window.BrandRow.mount(mountId), 200);
        });
      }
    },
  };
})();
