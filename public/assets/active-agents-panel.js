/**
 * Active Agents dashboard — renders into #aaModalBody when the
 * "Active Agents" tool card is opened (see index.html's
 * openActiveAgentsModal()). Talks to /api/presence/list +
 * /api/presence/record. Row/badge/online-pill visual language follows
 * the reference "Online Users" mock the business owner supplied —
 * circular avatar with a status dot cut into its corner, two small info
 * pills under the name, right-aligned status + relative time, thin
 * footer bar. Interaction pattern (stat-card filter, a separate
 * "Record" popup opened from a static header button) stays the same
 * shape as ip-access-panel.js — reusing a pattern already fought
 * through once in this codebase rather than inventing a new one.
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
 *                           touches again (#aaStatsWrap, #aaRosterWrap),
 *                           plus the static footer bar.
 *   renderDynamic(bodyEl) — runs on every data refresh (poll tick,
 *                           filter-card click, search input event,
 *                           manual refresh-button click). Only ever
 *                           touches the two containers' innerHTML plus
 *                           the header's online-count pill, NEVER the
 *                           shell/search input.
 *
 * A THIRD, LIGHTER refresh runs every 2s on top of the above: it only
 * rewrites the textContent of each row's "X sec ago" label (tagged with
 * data-aa-heartbeat) so the relative time actually counts up live, the
 * way the reference mock shows it — without touching any other DOM, so
 * it's free to run far more often than the real data poll.
 *
 * RECORD POPUP'S SEARCH BOX gets the exact same static-input/
 * dynamic-results split as the main roster search above — see
 * openRecordPopup()/renderRecordAgentList() below and the big comment
 * on #aaRecordBackdrop in index.html.
 */
(function () {
  const POLL_INTERVAL_MS = 10 * 1000;
  const TIME_TICK_INTERVAL_MS = 2 * 1000;
  const AVATAR_COLORS = ["#60A5FA", "#FBBF24", "#F87171", "#F472B6", "#34D399", "#A78BFA", "#38bdf8", "#fb923c"];

  let ctx = null; // { authFetch, escapeHtml }
  let data = null; // last GET /api/presence/list response
  let activeView = null; // null | "total" | "online" | "offline"
  let searchTerm = "";
  let pollTimer = null;
  let tickTimer = null;
  let headerWired = false;
  let recordAgents = []; // cached agent list for the Record picker
  let recordSearchTerm = "";
  let selectedRecordUsername = null;

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

  // "13 sec ago" / "5 min ago" / "2 hr ago" — matches the reference
  // mock's wording exactly. Falls back to a plain date once it's been
  // long enough that "ago" phrasing stops being useful (matches how
  // fmtTime() reads for anything not recent).
  function timeAgo(iso) {
    if (!iso) return "—";
    const diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return "just now";
    const sec = Math.floor(diffMs / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec} sec ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    return fmtTime(iso);
  }

  function statusMeta(status) {
    if (status === "online") return { label: "Online", cls: "aa-status-online", dotCls: "aa-dot-online" };
    return { label: "Offline", cls: "aa-status-offline", dotCls: "aa-dot-offline" };
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
    startTimeTicking(bodyEl);
  };

  window.stopActiveAgentsPanel = function stopActiveAgentsPanel() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  };

  function startPolling(bodyEl) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => refresh(bodyEl, { showLoading: false }), POLL_INTERVAL_MS);
  }

  // Lightweight — only rewrites textContent on already-rendered nodes,
  // never innerHTML, never anywhere near the search input. Safe to run
  // independently of and much more often than the real data poll.
  function startTimeTicking(bodyEl) {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      bodyEl.querySelectorAll("[data-aa-heartbeat]").forEach((el) => {
        el.textContent = timeAgo(el.dataset.aaHeartbeat || null);
      });
    }, TIME_TICK_INTERVAL_MS);
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
        <div id="aaRosterWrap" class="aa-roster-scroll"></div>
        <div class="aa-footer-bar">
          <span class="aa-footer-left"><span class="aa-dot aa-dot-online aa-footer-livedot"></span> Live presence</span>
          <span class="aa-footer-right">Admin view only</span>
        </div>
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

    const onlinePill = document.getElementById("aaOnlineCountPill");
    if (onlinePill) onlinePill.textContent = `${stats.online} online`;
    const subtitle = document.getElementById("aaHeaderSubtitle");
    if (subtitle) subtitle.textContent = `${stats.total} agent${stats.total === 1 ? "" : "s"} tracked · updates live`;

    statsWrap.classList.add("aa-stat-cards-3");
    statsWrap.innerHTML = `
      <div class="ipa-stat-card${activeView === "total" ? " ipa-stat-card-active" : ""}" data-aa-view="total"><div class="ipa-stat-label">Total Agents</div><div class="ipa-stat-value">${stats.total}</div></div>
      <div class="ipa-stat-card${activeView === "online" ? " ipa-stat-card-active" : ""}" data-aa-view="online"><div class="ipa-stat-label">Online</div><div class="ipa-stat-value ipa-stat-approved">${stats.online}</div></div>
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

    return agents.map((a) => {
      const meta = statusMeta(a.status);
      const initials = (a.username || "?").trim().slice(0, 2).toUpperCase();
      const color = colorFor(a.username);
      const pills = [];
      pills.push(`<span class="aa-pill">🪪 ${ctx.escapeHtml(a.role.charAt(0).toUpperCase() + a.role.slice(1))}</span>`);
      const deviceIcon = a.deviceType === "mobile" ? "📱" : "🖥️";
      const deviceLabel = a.deviceType === "mobile" ? "Mobile" : "Desktop";
      pills.push(`<span class="aa-pill">${deviceIcon} ${deviceLabel}</span>`);
      if (a.officeName) pills.push(`<span class="aa-pill">🏢 ${ctx.escapeHtml(a.officeName)}</span>`);
      return `
        <div class="aa-list-row">
          <div class="aa-avatar-wrap">
            <div class="aa-avatar" style="background:${color};">${ctx.escapeHtml(initials)}</div>
            <span class="aa-dot ${meta.dotCls} aa-avatar-dot"></span>
          </div>
          <div class="aa-roster-info">
            <div class="aa-roster-name">@${ctx.escapeHtml(a.username)}</div>
            ${a.fullName ? `<div class="aa-roster-fullname">${ctx.escapeHtml(a.fullName)}</div>` : ""}
            <div class="aa-pill-row">${pills.join("")}</div>
          </div>
          <div class="aa-roster-right">
            <span class="aa-status-pill ${meta.cls}"><span class="aa-dot ${meta.dotCls}"></span> ${meta.label}</span>
            <span class="aa-roster-time" data-aa-heartbeat="${a.lastHeartbeat ? ctx.escapeHtml(a.lastHeartbeat) : ""}">${timeAgo(a.lastHeartbeat)}</span>
          </div>
        </div>`;
    }).join("");
  }
  function rank(status) { return status === "online" ? 0 : 1; }

  // "🕘 Record" and "↻ Refresh" live as static nodes in index.html's
  // modal header row (next to ✕), not inside bodyEl's innerHTML — same
  // reason as ip-access-panel.js's wireHeaderButtonsOnce: they must only
  // ever be bound once per page load, or every ensureShell() call (once
  // per modal open) would risk stacking listeners if this ran more than
  // once — they're page-lifetime static, so a plain one-time guard here
  // is enough.
  function wireHeaderButtonsOnce() {
    if (headerWired) return;
    headerWired = true;
    document.getElementById("aaRecordBtn")?.addEventListener("click", () => {
      openRecordPopup();
    });
    // Static, page-lifetime node (see the big comment on this popup in
    // index.html) — bound exactly once, same reasoning as everything
    // else in this function. Only #aaRecordAgentList gets rewritten per
    // keystroke, never this input itself.
    document.getElementById("aaRecordSearchInput")?.addEventListener("input", (e) => {
      recordSearchTerm = e.target.value.trim().toLowerCase();
      renderRecordAgentList();
    });
    document.getElementById("aaRefreshBtn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const bodyEl = document.getElementById("aaModalBody");
      btn.classList.add("aa-spinning");
      btn.disabled = true;
      await refresh(bodyEl, { showLoading: false });
      btn.disabled = false;
      // Let the spin finish a full turn rather than snapping to a stop
      // the instant the (usually near-instant) fetch resolves.
      setTimeout(() => btn.classList.remove("aa-spinning"), 400);
    });
  }

  function openRecordPopup() {
    recordSearchTerm = "";
    selectedRecordUsername = null;
    const searchInput = document.getElementById("aaRecordSearchInput");
    if (searchInput) searchInput.value = "";
    renderRecordAgentList();
    document.getElementById("aaRecordBody").innerHTML =
      `<p class="edit-modal-note">Pick an agent above to see their daily record.</p>`;
    document.getElementById("aaRecordBackdrop").classList.add("is-open");
  }

  function recordStatusMeta(status) {
    if (status === "online") return "aa-dot-online";
    return "aa-dot-offline";
  }

  function renderRecordAgentList() {
    const listEl = document.getElementById("aaRecordAgentList");
    if (!listEl) return;
    let agents = recordAgents;
    if (recordSearchTerm) {
      agents = agents.filter((a) =>
        a.username.toLowerCase().includes(recordSearchTerm) || (a.fullName || "").toLowerCase().includes(recordSearchTerm));
    }
    if (!agents.length) {
      listEl.innerHTML = `<div class="ipa-empty-row">No agents match.</div>`;
      return;
    }
    listEl.innerHTML = agents.map((a) => {
      const letter = (a.username || "?").trim().slice(0, 1).toUpperCase();
      const selected = a.username === selectedRecordUsername ? " aa-record-agent-row-active" : "";
      return `
        <div class="aa-record-agent-row${selected}" data-aa-record-username="${ctx.escapeHtml(a.username)}">
          <span class="aa-record-avatar">${ctx.escapeHtml(letter)}</span>
          <span class="aa-record-agent-name">@${ctx.escapeHtml(a.username)}</span>
          <span class="aa-dot ${recordStatusMeta(a.status)}"></span>
        </div>`;
    }).join("");
    listEl.querySelectorAll("[data-aa-record-username]").forEach((row) => row.addEventListener("click", () => {
      selectedRecordUsername = row.dataset.aaRecordUsername;
      renderRecordAgentList();
      loadRecordFor(selectedRecordUsername);
    }));
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
