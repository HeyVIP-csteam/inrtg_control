/**
 * hub-nav.js  (SHARED — used by every sub-page: form.html, threads.html,
 * announcements.html, promo.html, deposit-issue.html, deposit-backup.html)
 *
 * Renders the same "ISSUE SUBMISSION" navigation column that lives on
 * index.html (Home + module links + Integration Portal group + Account
 * Management group) into a mount point on any page, so agents don't have to bounce back to the
 * hub just to get somewhere else — matches the persistent-nav pattern
 * used across php-issue-hub (see CHANGES-batch1-modal-cache-layout.md).
 * Replaces the old standalone "← Back to Home" pill, which is removed
 * from every page that adopts this component (Home is just the first
 * item in this list now).
 *
 * index.html keeps its OWN separate sidebar-rendering code (unchanged,
 * not touched by this file) — this component is only for the other
 * pages, so nothing about index.html's already-working Account
 * Management modal logic is at risk here. Account Management sub-items
 * on THIS component instead navigate to `/?admin=<mode>`, which
 * index.html reads on load and auto-opens the matching modal (see the
 * bottom of index.html's own <script> block).
 *
 * Requires (must be loaded first): authguard.js (window.AgentAuth),
 * schemas.js (window.MODULES).
 */
(function () {
  const ROLE_RANK = { agent: 0, senior: 1, admin: 2, superadmin: 3, owner: 4 };

  // Mirrors defaultSectionsForRank() in index.html / _shared/accounts.js —
  // keep in sync if that default tier mapping ever changes.
  function defaultSectionsForRank(rank) {
    if (rank >= ROLE_RANK.superadmin) return "all";
    if (rank >= ROLE_RANK.admin) return ["createAccount", "whitelistIp", "announcements"];
    if (rank >= ROLE_RANK.senior) return ["createAccount"];
    return [];
  }
  function accountCanSeeAdminSection(acc, sectionId) {
    if (!acc) return false;
    if (acc.role === "owner") return true;
    const sections = acc.allowedAdminSections !== undefined ? acc.allowedAdminSections : defaultSectionsForRank(ROLE_RANK[acc.role] ?? 0);
    if (sections === "all") return true;
    return Array.isArray(sections) && sections.includes(sectionId);
  }

  // `mode` values match the argument openAcctModal(mode) expects in
  // index.html exactly — that's the contract this shares with it via
  // the ?admin= query param.
  const ADMIN_SUBITEMS = [
    { sectionId: "createAccount", mode: "create", label: "Create Account", icon: "➕", accent: "#a78bfa33" },
    { sectionId: "whitelistIp", mode: "whitelist", label: "Whitelist IP", icon: "🌐", accent: "#60a5fa33" },
    { sectionId: "settings", mode: "settings", label: "Settings", icon: "⚙️", accent: "#f59e0b33" },
    // Reset Password has no permission gate in index.html either — every
    // logged-in agent can reset their own password.
    { sectionId: null, mode: "reset", label: "Reset Password", icon: "🔑", accent: "#f3c46333" },
    { sectionId: "agentProfile", mode: "profile", label: "Agent Profile", icon: "🪪", accent: "#34d39933" },
  ];

  // Integration Portal (2026-08) — same shape/contract as ADMIN_SUBITEMS
  // above, rendered as its own separate expandable group positioned
  // above Account Management (matches index.html's own sidebar). These
  // 4 used to live inside ADMIN_SUBITEMS (tgRoutes/depositSheets/
  // bettingLinks moved out here) plus the new "Web Link" (webLink).
  const INTEGRATION_PORTAL_SUBITEMS = [
    { sectionId: "tgRoutes", mode: "tgroutes", label: "TG Group / Channel", icon: "📡", accent: "#38bdf833" },
    { sectionId: "depositSheets", mode: "depositsheets", label: "Deposit Sheet Link", icon: "📊", accent: "#4fa6f533" },
    { sectionId: "bettingLinks", mode: "bettinglinks", label: "Betting Resources Links", icon: "🔗", accent: "#c8912f33" },
    { sectionId: "webLink", mode: "weblink", label: "Web Link", icon: "🌐", accent: "#f3c46333" },
  ];

  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  window.HubNav = {
    /**
     * @param {string} mountId  id of an empty element to render into
     *   (typically an <aside class="sidebar">).
     * @param {object} opts
     * @param {string} [opts.activeModule]  id matching a MODULES[] entry
     *   (highlights that module link) — leave unset on pages that aren't
     *   a specific issue-submission module (e.g. threads/announcements).
     */
    mount(mountId, opts) {
      opts = opts || {};
      const mountEl = document.getElementById(mountId);
      if (!mountEl) return;

      const authInfo = window.AgentAuth ? window.AgentAuth.getAuth() : null;
      const visibleModules = window.AgentAuth && window.MODULES ? window.AgentAuth.filterAllowedModules(window.MODULES) : (window.MODULES || []);

      let html = `
        <div class="sidebar-header"><span class="dot"></span> ISSUE SUBMISSION</div>
        <a href="/" class="sidebar-item" style="--item-accent:#7c6cf0;">
          <div class="icon" style="background:#7c6cf033;">🏠</div>
          <div class="text"><div class="name">Home</div><div class="desc">Hub overview</div></div>
          <span class="arrow">&rarr;</span>
        </a>
      `;
      // Active Agents no longer has its own sidebar entry — it now opens
      // as a popup from the Home page's tool-card grid instead (see
      // #activeAgentsCard / window.ActiveAgentsModal in index.html), so
      // there's nothing to render here anymore. Kept as a code comment
      // (not deleted silently) so a future reader knows this was a
      // deliberate removal, not an oversight — see canViewActiveAgents()
      // in functions/_shared/accounts.js for the permission this used to
      // gate; that permission and its API endpoints are unchanged, only
      // this nav link is gone.

      visibleModules.forEach((m) => {
        const isActive = opts.activeModule && opts.activeModule === m.id;
        html += `
          <a href="/form.html?module=${encodeURIComponent(m.id)}" class="sidebar-item${isActive ? " active" : ""}" style="--item-accent:${m.accent};">
            <div class="icon" style="background:${m.accent}33;">${m.icon}</div>
            <div class="text"><div class="name">${m.name}</div><div class="desc">${m.description}</div></div>
            <span class="arrow">&rarr;</span>
          </a>
        `;
      });

      const rank = ROLE_RANK[authInfo?.role] ?? 0;
      const isOwner = authInfo?.role === "owner";

      // Integration Portal group — positioned above Account Management,
      // hidden outright unless this account can see "integrationPortal"
      // at all (mirrors the same gate in index.html's own sidebar), on
      // top of (not instead of) each subitem's own individual section
      // gate below.
      const canSeeIntegrationPortal = isOwner || accountCanSeeAdminSection(authInfo, "integrationPortal");
      const visibleIntegrationPortal = canSeeIntegrationPortal
        ? INTEGRATION_PORTAL_SUBITEMS.filter((it) => isOwner || accountCanSeeAdminSection(authInfo, it.sectionId))
        : [];
      if (visibleIntegrationPortal.length) {
        html += `
          <div class="am-group" id="hubNavIpGroup">
            <div class="sidebar-item am-toggle expandable" id="hubNavIpToggle">
              <div class="icon" style="background:#38bdf833;">🔗</div>
              <div class="text"><div class="name">Integration Portal</div><div class="desc">TG routes, sheets &amp; external links</div></div>
              <span class="arrow">&rarr;</span>
            </div>
            <div class="sidebar-subitems" id="hubNavIpSubitems">
              ${visibleIntegrationPortal
                .map(
                  (it) =>
                    `<div class="sidebar-subitem" data-admin-mode="${escapeAttr(it.mode)}" style="--sub-accent:${it.accent};"><span class="sub-icon">${it.icon}</span> ${it.label}</div>`
                )
                .join("")}
            </div>
          </div>
        `;
      }

      const visibleAdmin = ADMIN_SUBITEMS.filter((it) => it.sectionId === null || isOwner || accountCanSeeAdminSection(authInfo, it.sectionId));
      if (visibleAdmin.length) {
        html += `
          <div class="am-group" id="hubNavAcctGroup">
            <div class="sidebar-item am-toggle expandable" id="hubNavAcctToggle">
              <div class="icon" style="background:#a78bfa33;">🛡️</div>
              <div class="text"><div class="name">Account Management</div><div class="desc">Accounts, offices & passwords</div></div>
              <span class="arrow">&rarr;</span>
            </div>
            <div class="sidebar-subitems" id="hubNavAcctSubitems">
              ${visibleAdmin
                .map(
                  (it) =>
                    `<div class="sidebar-subitem" data-admin-mode="${escapeAttr(it.mode)}" style="--sub-accent:${it.accent};"><span class="sub-icon">${it.icon}</span> ${it.label}</div>`
                )
                .join("")}
            </div>
          </div>
        `;
      }

      mountEl.innerHTML = html;

      const ipToggle = document.getElementById("hubNavIpToggle");
      const ipSubitems = document.getElementById("hubNavIpSubitems");
      if (ipToggle && ipSubitems) {
        ipToggle.addEventListener("click", () => {
          ipToggle.classList.toggle("open");
          ipSubitems.classList.toggle("open");
        });
      }

      const toggle = document.getElementById("hubNavAcctToggle");
      const subitems = document.getElementById("hubNavAcctSubitems");
      if (toggle && subitems) {
        toggle.addEventListener("click", () => {
          toggle.classList.toggle("open");
          subitems.classList.toggle("open");
        });
      }
      mountEl.querySelectorAll("[data-admin-mode]").forEach((el) => {
        el.addEventListener("click", () => {
          // index.html owns the actual Account Management modal — send
          // the agent there and let it auto-open the right tab (see the
          // ?admin= handling at the bottom of index.html's script).
          location.href = "/?admin=" + encodeURIComponent(el.dataset.adminMode);
        });
      });

      this._setupMobileToggle(mountEl);
    },

    // ---- Small-screen drawer (2026-08) ----------------------------------
    // On a narrow viewport (≤820px, see style.css) this same rendered
    // nav becomes a fixed-position, off-canvas drawer instead of a
    // permanent 290px column — a hamburger button (injected into the
    // page's .topbar-left, since every page that mounts HubNav shares
    // that exact markup) toggles it open/closed via a single class on
    // <body>, and a full-screen backdrop closes it on outside-click.
    // Above 820px none of this applies: the toggle button is hidden by
    // CSS and .sidebar renders exactly as it always has, in-flow. Only
    // ever set up once per page load (mount() is only called once per
    // page in practice, but the id check below makes a second call
    // harmless instead of injecting a duplicate button/backdrop).
    _setupMobileToggle(mountEl) {
      if (document.getElementById("hubNavToggleBtn")) return;
      const topbarLeft = document.querySelector(".topbar-left");
      if (!topbarLeft) return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "hubNavToggleBtn";
      btn.className = "hub-nav-toggle";
      btn.setAttribute("aria-label", "Menu");
      btn.textContent = "☰";
      topbarLeft.insertBefore(btn, topbarLeft.firstChild);

      const backdrop = document.createElement("div");
      backdrop.className = "hub-nav-backdrop";
      backdrop.id = "hubNavBackdrop";
      document.body.appendChild(backdrop);

      const close = () => document.body.classList.remove("hubnav-open");
      btn.addEventListener("click", () => document.body.classList.toggle("hubnav-open"));
      backdrop.addEventListener("click", close);
      // Any actual navigation link (or an Account Management sub-item,
      // which navigates via location.href above) should close the
      // drawer behind it — but NOT the "Account Management" toggle
      // itself, which only expands its sub-list in place and would
      // otherwise immediately close right as it opens.
      mountEl.querySelectorAll(".sidebar-item:not(.expandable), .sidebar-subitem").forEach((el) => {
        el.addEventListener("click", close);
      });
    },
  };
})();
