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

  // Includes seconds down to the second, matching the reference mock's
  // "10m 49s" / "0s" — the earlier "< 1m" rounding hid exactly the kind
  // of short-session detail (someone online for 45s) this table exists
  // to show accurately. Hours-scale durations still drop seconds (an
  // agent online for "3h 12m 08s" doesn't need to-the-second precision
  // at that scale) — same "precision matches what's actually useful"
  // judgment call the rest of this feature makes elsewhere.
  function fmtDuration(ms) {
    if (!ms || ms < 0) return "0s";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  // "13 sec ago" / "5 min ago" / "2 hr ago" / "3 days ago" — matches the
  // reference mock's wording exactly, extended with day-level
  // granularity since offline agents can realistically be offline for
  // days, not just hours (falling straight to a full date past 24h
  // read as broken/no-data at a glance). An account that has NEVER sent
  // a single heartbeat (brand new, or just never logged in since this
  // feature shipped) has no timestamp to show at all — "Never online"
  // says that plainly instead of a bare "—", which reads as an error.
  function timeAgo(iso) {
    if (!iso) return "Never online";
    const diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return "just now";
    const sec = Math.floor(diffMs / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec} sec ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    const days = Math.floor(hr / 24);
    if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
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
            <div class="aa-roster-name">${ctx.escapeHtml(a.username)}</div>
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
    document.getElementById("aaRecordBackBtn")?.addEventListener("click", () => {
      showRecordSearchView();
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
    showRecordSearchView();
    renderRecordAgentList();
    document.getElementById("aaRecordBackdrop").classList.add("is-open");
  }

  // ---- Two-view switch — search list vs. one agent's detail. See the
  // big comment on #aaRecordBackdrop in index.html for why this is a
  // view swap rather than stacking the table below the search results.
  function showRecordSearchView() {
    document.getElementById("aaRecordTitle").style.display = "";
    document.getElementById("aaRecordBackBtn").style.display = "none";
    document.getElementById("aaRecordSearchView").style.display = "";
    document.getElementById("aaRecordDetailView").style.display = "none";
  }
  function showRecordDetailView(username) {
    document.getElementById("aaRecordTitle").style.display = "none";
    document.getElementById("aaRecordBackBtn").style.display = "";
    document.getElementById("aaRecordSearchView").style.display = "none";
    const detailView = document.getElementById("aaRecordDetailView");
    detailView.style.display = "";
    detailView.innerHTML = `<div class="spa-loading" style="padding:20px; text-align:center; color:var(--ink-soft);">Loading…</div>`;
    loadRecordDetail(username);
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
          <span class="aa-record-agent-name">${ctx.escapeHtml(a.username)}</span>
          <span class="aa-dot ${recordStatusMeta(a.status)}"></span>
        </div>`;
    }).join("");
    listEl.querySelectorAll("[data-aa-record-username]").forEach((row) => row.addEventListener("click", () => {
      selectedRecordUsername = row.dataset.aaRecordUsername;
      showRecordDetailView(selectedRecordUsername);
    }));
  }

  const RECORD_DAYS = 7; // "LAST 7 DAYS" — matches the reference mock

  // Actual clock time ("6:08:07 PM"), not relative — for "Last active"
  // specifically, per the reference mock. Different from timeAgo(),
  // which is still used for the roster rows and this same detail view's
  // "X min ago" freshness line.
  function clockTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return "—"; }
  }

  async function loadRecordDetail(username) {
    const detailView = document.getElementById("aaRecordDetailView");
    const agentMeta = recordAgents.find((a) => a.username === username);
    try {
      const res = await ctx.authFetch(`/api/presence/record?username=${encodeURIComponent(username)}&days=${RECORD_DAYS}`);
      const json = await res.json();
      if (!json.ok) { detailView.innerHTML = `<p class="edit-modal-note err">${ctx.escapeHtml(json.error || "Failed to load record.")}</p>`; return; }
      renderRecordDetail(detailView, username, agentMeta, json.days || []);
    } catch {
      detailView.innerHTML = `<p class="edit-modal-note err">Network error — try again.</p>`;
    }
  }

  function renderRecordDetail(detailView, username, agentMeta, days) {
    const byDayKey = Object.fromEntries(days.map((d) => [d.dayKey, d]));

    // Build the visible 7-day calendar client-side rather than trusting
    // the server to have a row for every day — most days for most
    // agents genuinely have no data at all (missing = 0s / never, not
    // an error). Day-key format here is a plain browser-local
    // YYYY-MM-DD, which can drift by one calendar day from the server's
    // Asia/Colombo dayKey right around midnight in either timezone —
    // an accepted, documented approximation (display labels only; the
    // underlying totals always come from the server's real dayKey).
    const todayLocalKey = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (let i = 0; i < RECORD_DAYS; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const isToday = key === todayLocalKey;
      const label = isToday ? "Today" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const entry = byDayKey[key];
      let lastActiveAt = entry ? entry.lastActiveAt : null;
      // Fallback for TODAY only: presence:current's own lastHeartbeat
      // (agentMeta.lastHeartbeat, from list.js) is kept fresh on every
      // single real write regardless of anything day-record-specific —
      // it's the same field the roster's "X min ago" already relies on.
      // The per-day lastHeartbeatAt field only exists on daily records
      // that received at least one write AFTER this field was added, so
      // an agent whose today-record predates that (or who just sent
      // their very first-ever heartbeat, which doesn't touch a credit
      // path) could show a real today total but a missing lastActiveAt.
      // Falling back here means the detail view never shows "last
      // active: —" for someone who's plainly online right now. Past
      // days have no "current" state to fall back to, so they're left
      // as a genuine "—" when truly absent.
      if (isToday && !lastActiveAt && agentMeta && agentMeta.lastHeartbeat) {
        lastActiveAt = agentMeta.lastHeartbeat;
      }
      rows.push({ key, label, isToday, totalOnlineMs: entry ? entry.totalOnlineMs : 0, lastActiveAt });
    }

    const meta = agentMeta ? statusMeta(agentMeta.status) : statusMeta("offline");
    const letter = (username || "?").trim().slice(0, 1).toUpperCase();
    const todayRow = rows[0];

    const tableRows = rows.map((r) => `
      <div class="ipa-row${r.isToday ? " aa-record-row-today" : ""}" style="grid-template-columns:1fr 1.2fr 1.2fr;">
        <div>${r.isToday ? "Today" : ctx.escapeHtml(r.label)}</div>
        <div style="text-align:left;">${fmtDuration(r.totalOnlineMs)}</div>
        <div>${clockTime(r.lastActiveAt)}</div>
      </div>`).join("");

    detailView.innerHTML = `
      <div class="aa-record-detail-header">
        <span class="aa-record-avatar aa-record-detail-avatar">${ctx.escapeHtml(letter)}</span>
        <span class="aa-record-detail-name">${ctx.escapeHtml(username)}</span>
        <span class="aa-status-pill ${meta.cls}"><span class="aa-dot ${meta.dotCls}"></span> ${meta.label}</span>
      </div>
      <div class="aa-record-detail-summary">
        ${agentMeta ? timeAgo(agentMeta.lastHeartbeat) : "—"} ·
        Today online: ${fmtDuration(todayRow.totalOnlineMs)} ·
        Last active: ${clockTime(todayRow.lastActiveAt)}
      </div>
      <p class="ipa-table-title" style="margin:16px 0 8px;">LAST ${RECORD_DAYS} DAYS</p>
      <div class="ipa-table">
        <div class="ipa-row ipa-row-head" style="grid-template-columns:1fr 1.2fr 1.2fr;"><div>Date</div><div style="text-align:left;">Total online time</div><div>Last active time</div></div>
        ${tableRows}
      </div>`;
  }
})();
