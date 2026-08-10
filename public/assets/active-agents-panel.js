/**
 * Active Agents dashboard — renders into #aaModalBody when the
 * "Active Agents" tool card is opened (see index.html's
 * openActiveAgentsModal()). Talks to /api/presence/list +
 * /api/presence/record. Layout/interaction pattern is deliberately the
 * same shape as ip-access-panel.js (stat cards, click-to-filter, a
 * separate "Record" popup opened from a static header button) — reusing
 * a pattern already fought through once in this codebase rather than
 * inventing a new one.
 *
 * TWO-PHASE RENDER — READ THIS BEFORE TOUCHING render():
 * This panel POLLS every 10s while open (agents' status changes live).
 * If a poll refresh ever did bodyEl.innerHTML = wholeShellIncludingInput
 * the way ip-access-panel.js's render() safely can (that panel doesn't
 * poll), the search box would get destroyed and recreated on every
 * single poll tick — killing focus and cursor position mid-keystroke.
 * (This exact bug — "innerHTML full re-render nukes a live <input>" —
 * already bit this codebase once; see the Record search box lesson.)
 * So rendering here is split in two:
 *   ensureShell(bodyEl)   — runs ONCE per modal open. Builds the search
 *                           input + the two empty containers it never
 *                           touches again (#aaStatsWrap, #aaRosterWrap).
 *   renderDynamic(bodyEl) — runs on every data refresh (poll tick,
 *                           filter-card click, search input event).
 *                           Only ever touches the two containers'
 *                           innerHTML, NEVER the shell/search input.
 */
(function () {
  const POLL_INTERVAL_MS = 10 * 1000;
  const AVATAR_COLORS = ["#60A5FA", "#FBBF24", "#F87171", "#F472B6", "#34D399", "#A78BFA", "#38bdf8", "#fb923c"];

  let ctx = null; // { authFetch, escapeHtml }
  let data = null; // last GET /api/presence/list response
  let activeView = null; // null | "total" | "online" | "inactive" | "offline"
  let searchTerm = "";
  let pollTimer = null;
  let headerWired = false;
  let recordAgents = []; // cached agent list for the Record dropdown

  function colorFor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  function fmtDuration(ms) {
    if (!ms || ms < 60000) return "< 1m";
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function statusMeta(status) {
    if (status === "online") return { label: "Online", dot: "🟢", cls: "aa-status-online" };
    if (status === "inactive") return { label: "Inactive", dot: "🟡", cls: "aa-status-inactive" };
    return { label: "Offline", dot: "⚫", cls: "aa-status-offline" };
  }

  async function fetchList() {
    const res = await ctx.authFetch("/api/presence/list");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Failed to load Active Agents data.");
    return json;
  }

  window.renderActiveAgentsPanel = async function renderActiveAgentsPanel(bodyEl, options) {
    ctx = options;
    activeView = null;
    searchTerm = "";
    ensureShell(bodyEl);
    await refresh(bodyEl, { showLoading: true });
    wireHeaderButtonsOnce();
    startPolling(bodyEl);
  };

  window.stopActiveAgentsPanel = function stopActiveAgentsPanel() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  function startPolling(bodyEl) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => refresh(bodyEl, { showLoading: false }), POLL_INTERVAL_MS);
  }

  async function refresh(bodyEl, { showLoading }) {
    if (showLoading) {
      const rosterWrap = bodyEl.querySelector("#aaRosterWrap");
      if (rosterWrap) rosterWrap.innerHTML = `<div class="spa-loading" style="padding:30px; text-align:center; color:var(--ink-soft);">Loading…</div>`;
    }
    try {
      data = await fetchList();
      recordAgents = data.agents;
    } catch (e) {
      const rosterWrap = bodyEl.querySelector("#aaRosterWrap");
      if (rosterWrap) rosterWrap.innerHTML = `<p class="edit-modal-note err">${ctx.escapeHtml(e.message)}</p>`;
      return; // a failed poll shouldn't blow away stat cards from the last good fetch
    }
    renderDynamic(bodyEl);
  }

  // ---- Phase 1: build the static shell ONCE (see file header) ----
  function ensureShell(bodyEl) {
    if (bodyEl.querySelector(".aa-shell")) return; // already built for this modal-open session
    bodyEl.innerHTML = `
      <div class="aa-shell">
        <div class="ipa-stat-cards" id="aaStatsWrap"></div>
        <div class="aa-search-row">
          <input type="text" id="aaSearchInput" class="acct-profile-search" placeholder="🔍 Search username or name…" autocomplete="off" style="width:260px;" />
          <span class="edit-modal-note" id="aaSearchHint" style="margin:0;">Click a card above to filter, or search by name.</span>
        </div>
        <div id="aaRosterWrap"></div>
      </div>`;
    bodyEl.querySelector("#aaSearchInput").addEventListener("input", (e) => {
      searchTerm = e.target.value.trim().toLowerCase();
      renderDynamic(bodyEl);
    });
  }

  // ---- Phase 2: everything that changes on refresh/filter/search ----
  function renderDynamic(bodyEl) {
    if (!data) return;
    const statsWrap = bodyEl.querySelector("#aaStatsWrap");
    const rosterWrap = bodyEl.querySelector("#aaRosterWrap");
    if (!statsWrap || !rosterWrap) return; // modal was closed mid-flight

    const { stats } = data;
    statsWrap.innerHTML = `
      <div class="ipa-stat-card${activeView === "total" ? " ipa-stat-card-active" : ""}" data-aa-view="total"><div class="ipa-stat-label">Total Agents</div><div class="ipa-stat-value">${stats.total}</div></div>
      <div class="ipa-stat-card${activeView === "online" ? " ipa-stat-card-active" : ""}" data-aa-view="online"><div class="ipa-stat-label">Online</div><div class="ipa-stat-value ipa-stat-approved">${stats.online}</div></div>
      <div class="ipa-stat-card${activeView === "inactive" ? " ipa-stat-card-active" : ""}" data-aa-view="inactive"><div class="ipa-stat-label">Inactive</div><div class="ipa-stat-value ipa-stat-pending">${stats.inactive}</div></div>
      <div class="ipa-stat-card${activeView === "offline" ? " ipa-stat-card-active" : ""}" data-aa-view="offline"><div class="ipa-stat-label">Offline</div><div class="ipa-stat-value ipa-stat-blocked">${stats.offline}</div></div>`;
    statsWrap.querySelectorAll("[data-aa-view]").forEach((card) => card.addEventListener("click", () => {
      activeView = activeView === card.dataset.aaView ? null : card.dataset.aaView;
      renderDynamic(bodyEl);
    }));

    const hint = bodyEl.querySelector("#aaSearchHint");
    if (hint) hint.textContent = activeView === null && !searchTerm ? "Click a card above to filter, or search by name." : "";

    rosterWrap.innerHTML = renderRoster();
  }

  function renderRoster() {
    let agents = data.agents;
    if (activeView && activeView !== "total") agents = agents.filter((a) => a.status === activeView);
    if (searchTerm) {
      agents = agents.filter((a) =>
        a.username.toLowerCase().includes(searchTerm) || (a.fullName || "").toLowerCase().includes(searchTerm));
    }
    // Default (nothing clicked, nothing searched) view: everyone, online
    // first — the board's whole point is "who's around right now", so
    // that's the useful default rather than an empty state.
    if (activeView === null && !searchTerm) {
      agents = [...agents].sort((a, b) => rank(a.status) - rank(b.status));
    }

    if (!agents.length) return `<div class="ipa-empty-row">No agents match.</div>`;

    return `<div class="aa-roster-grid">${agents.map((a) => {
      const meta = statusMeta(a.status);
      const initials = (a.fullName || a.username || "?").trim().slice(0, 2).toUpperCase();
      const color = colorFor(a.username);
      return `
        <div class="aa-roster-card">
          <div class="aa-avatar" style="background:${color};">${initials}</div>
          <div class="aa-roster-info">
            <div class="aa-roster-name">${ctx.escapeHtml(a.fullName || a.username)}</div>
            <div class="aa-roster-sub">@${ctx.escapeHtml(a.username)} · ${ctx.escapeHtml(a.role)}</div>
            <div class="aa-roster-sub">Today: ${fmtDuration(a.todayOnlineMs)}${a.lastHeartbeat ? ` · last seen ${fmtTime(a.lastHeartbeat)}` : ""}</div>
          </div>
          <span class="aa-status-pill ${meta.cls}">${meta.dot} ${meta.label}</span>
        </div>`;
    }).join("")}</div>`;
  }
  function rank(status) { return status === "online" ? 0 : status === "inactive" ? 1 : 2; }

  // "🕘 Record" lives as a static node in index.html's modal header row
  // (next to ✕), not inside bodyEl's innerHTML — same reason as
  // ip-access-panel.js's wireHeaderButtonsOnce: it must only ever be
  // bound once per page load, or every ensureShell() call (once per
  // modal open) would risk stacking listeners if this ran more than
  // once — it's page-lifetime static, so a plain one-time guard here
  // is enough.
  function wireHeaderButtonsOnce() {
    if (headerWired) return;
    headerWired = true;
    document.getElementById("aaRecordBtn")?.addEventListener("click", () => {
      openRecordPopup();
    });
    document.getElementById("aaRecordAgentSelect")?.addEventListener("change", (e) => {
      loadRecordFor(e.target.value);
    });
  }

  function openRecordPopup() {
    const select = document.getElementById("aaRecordAgentSelect");
    const current = select.value;
    select.innerHTML = recordAgents.map((a) =>
      `<option value="${ctx.escapeHtml(a.username)}">${ctx.escapeHtml(a.fullName || a.username)} (@${ctx.escapeHtml(a.username)})</option>`).join("");
    if (current && recordAgents.some((a) => a.username === current)) select.value = current;
    document.getElementById("aaRecordBackdrop").classList.add("is-open");
    if (select.value) loadRecordFor(select.value);
  }

  async function loadRecordFor(username) {
    const body = document.getElementById("aaRecordBody");
    body.innerHTML = `<div class="spa-loading" style="padding:20px; text-align:center; color:var(--ink-soft);">Loading…</div>`;
    try {
      const res = await ctx.authFetch(`/api/presence/record?username=${encodeURIComponent(username)}&days=30`);
      const json = await res.json();
      if (!json.ok) { body.innerHTML = `<p class="edit-modal-note err">${ctx.escapeHtml(json.error || "Failed to load record.")}</p>`; return; }
      if (!json.days.length) { body.innerHTML = `<p class="edit-modal-note">No recorded activity in the last 30 days.</p>`; return; }
      const rows = json.days.map((d) => `
        <div class="ipa-row" style="grid-template-columns:1fr 1fr;">
          <div>${ctx.escapeHtml(d.dayKey)}</div>
          <div>${fmtDuration(d.totalOnlineMs)}</div>
        </div>`).join("");
      body.innerHTML = `
        <div class="ipa-table">
          <div class="ipa-row ipa-row-head" style="grid-template-columns:1fr 1fr;"><div>Date</div><div>Online Time</div></div>
          ${rows}
        </div>`;
    } catch {
      body.innerHTML = `<p class="edit-modal-note err">Network error — try again.</p>`;
    }
  }
})();
