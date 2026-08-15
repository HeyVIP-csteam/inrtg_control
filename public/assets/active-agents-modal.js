/**
 * active-agents-modal.js  (index.html ONLY)
 *
 * Renders the Active Agents feature (list + search + stats + Record
 * drill-down) as a popup instead of a dedicated page — replaces the old
 * click-through to what used to be /active-agents.html. Same backend
 * (/api/presence/list, /api/presence/record, /api/presence/heartbeat),
 * same canViewActiveAgents gate, same underlying data — only the
 * container changed. The old standalone /public/active-agents.html has
 * since been DELETED (it called the pre-throttling record.js response
 * shape and would have thrown on open, so it wasn't worth keeping as
 * dead/broken code once this popup covered everything it did).
 *
 * Requires (must be loaded first): authguard.js (window.AgentAuth), and
 * the #aaModalBackdrop markup block in index.html.
 *
 * Exposes window.ActiveAgentsModal = { open, close }.
 */
(function () {
  const authFetch = () => window.AgentAuth.authFetch;

  // ---- Formatting helpers — copied verbatim from the old
  // active-agents.html (single source of truth was already established
  // there per ACTIVE-AGENTS-SPEC.md §5; kept identical here on purpose). ----
  function fmtDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  function fmtClock(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  }
  function fmtRelative(iso) {
    if (!iso) return "—";
    const then = new Date(iso).getTime();
    if (isNaN(then)) return "—";
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 30) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mins ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`;
    return `${Math.floor(diffSec / 86400)} days ago`;
  }
  function roleLabel(role) {
    if (!role) return "—";
    return role.charAt(0).toUpperCase() + role.slice(1);
  }
  function deviceLabel(device) {
    return device === "mobile" ? "📱 Mobile" : "💻 Desktop";
  }
  function escAttr(s) { return String(s == null ? "" : s).replace(/"/g, "&quot;"); }
  function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  let aaData = null;
  let aaSearchTerm = "";
  let aaStatusFilter = null; // null = show all; "online"|"inactive"|"offline" when a stat card is active
  let aaPollTimer = null;
  let aaRecordSelectedUsername = null;

  function el(id) { return document.getElementById(id); }

  async function aaLoadList() {
    try {
      const res = await authFetch()("/api/presence/list", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) return; // modal only opens once canSeeActiveAgents is already true, so a 403 here is unexpected — leave last-known state up rather than blank the popup
      aaData = data;
      aaRenderBadgeAndStats();
      aaRenderList();
    } catch {
      // best-effort — leave the last-known list showing, try again next tick
    }
  }

  function aaRenderBadgeAndStats() {
    const s = aaData.stats;
    el("aaOnlineBadge").innerHTML = `<span class="aa-dot-online" style="width:7px;height:7px;border-radius:50%;display:inline-block;"></span> ${s.online} online`;
    // Clickable filter cards — same pattern as .ipa-stat-card on the IP
    // Access page (see ipaStatCard()/ipaWire() in index.html): a <button>
    // per stat, "active" class on whichever one is the current filter,
    // clicking the already-active one again clears the filter.
    el("aaStats").innerHTML = `
      <button type="button" class="ipa-stat-card${aaStatusFilter === null ? " active" : ""}" data-stat="all" style="${aaStatusFilter === null ? "border-color:var(--accent-gold);" : ""}">
        <span class="ipa-stat-label">Total</span>
        <span class="ipa-stat-value">${s.total}</span>
      </button>
      <button type="button" class="ipa-stat-card${aaStatusFilter === "online" ? " active" : ""}" data-stat="online">
        <span class="ipa-stat-label">Online</span>
        <span class="ipa-stat-value ipa-green">${s.online}</span>
      </button>
      <button type="button" class="ipa-stat-card${aaStatusFilter === "inactive" ? " active" : ""}" data-stat="inactive">
        <span class="ipa-stat-label">Inactive</span>
        <span class="ipa-stat-value">${s.inactive}</span>
      </button>
      <button type="button" class="ipa-stat-card${aaStatusFilter === "offline" ? " active" : ""}" data-stat="offline">
        <span class="ipa-stat-label">Offline</span>
        <span class="ipa-stat-value">${s.offline}</span>
      </button>
    `;
    el("aaStats").querySelectorAll(".ipa-stat-card").forEach((card) => {
      card.addEventListener("click", () => {
        const key = card.dataset.stat;
        aaStatusFilter = (key === "all" || key === aaStatusFilter) ? null : key;
        aaRenderBadgeAndStats();
        aaRenderList();
      });
    });
  }

  function aaRenderList() {
    const term = aaSearchTerm.trim().toLowerCase();
    const agents = aaData.agents
      .filter((a) => !aaStatusFilter || a.status === aaStatusFilter)
      .filter((a) => !term || a.username.toLowerCase().includes(term) || (a.officeName || "").toLowerCase().includes(term))
      .sort((a, b) => {
        const rank = { online: 0, inactive: 1, offline: 2 };
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return (b.statusSince || "").localeCompare(a.statusSince || "");
      });

    const listEl = el("aaList");
    const emptyEl = el("aaEmpty");
    if (!agents.length) {
      listEl.innerHTML = "";
      emptyEl.textContent = aaStatusFilter ? `No ${aaStatusFilter} agents match.` : "No agents match.";
      emptyEl.style.display = "";
      return;
    }
    emptyEl.style.display = "none";

    listEl.innerHTML = agents.map((a) => {
      const initial = a.username.charAt(0).toUpperCase();
      const isOnline = a.status === "online";
      const isInactive = a.status === "inactive";
      const dotClass = isOnline ? "aa-dot-online" : "aa-dot-gray";
      const statusLabel = isOnline ? "Online" : isInactive ? "Inactive" : "Offline";
      const statusColor = isOnline ? "#34d399" : "var(--ink-soft)";
      const timeText = isOnline || isInactive ? fmtRelative(a.statusSince) : fmtRelative(a.lastActiveAt);
      return `
        <div class="aa-row${isOnline ? "" : " is-offline"}">
          <div class="aa-row-avatar">
            <div class="aa-row-avatar-circle" style="color:${isOnline ? "#34d399" : "var(--ink-soft)"};">${escHtml(initial)}</div>
            <span class="aa-row-badge ${dotClass}"></span>
          </div>
          <div class="aa-row-main">
            <div class="aa-row-name">${escHtml(a.username)}</div>
            <div class="aa-tags">
              <span class="aa-tag">🪪 ${escHtml(roleLabel(a.role))}</span>
              <span class="aa-tag">${deviceLabel(a.device)}</span>
              ${a.officeName ? `<span class="aa-tag">🏢 ${escHtml(a.officeName)}</span>` : ""}
            </div>
          </div>
          <div class="aa-row-status">
            <div class="aa-row-status-line">
              <span class="${dotClass}" style="width:7px; height:7px; border-radius:50%; flex-shrink:0;"></span>
              <span style="color:${statusColor}; font-size:11.5px; font-weight:700;">${statusLabel}</span>
            </div>
            <div class="aa-row-status-time">${escHtml(timeText)}</div>
          </div>
        </div>
      `;
    }).join("");
  }

  // ---- Record popover: search-first, then a detail view (unchanged
  // from the old page's version, just re-scoped to #aaRecordPopover /
  // #aaPopoverScrim so it can't collide with #acctModalBackdrop's own
  // Record popover for IP Access). ----
  function aaOpenRecord() {
    aaRecordSelectedUsername = null;
    el("aaPopoverScrim").style.display = "";
    el("aaRecordPopover").style.display = "";
    aaRenderRecordSearch("");
  }
  function aaCloseRecord() {
    el("aaPopoverScrim").style.display = "none";
    el("aaRecordPopover").style.display = "none";
  }

  function aaRenderRecordSearch(term) {
    const pop = el("aaRecordPopover");
    pop.innerHTML = `
      <div class="ipa-popover-header">
        <p class="ipa-popover-title">🕒 Record</p>
        <span style="color:var(--ink-soft); cursor:pointer;" id="aaRecordClose">✕</span>
      </div>
      <div style="position:relative; margin-bottom:12px;">
        <span style="position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--ink-soft); font-size:12px;">🔍</span>
        <input type="text" id="aaRecordSearchInput" placeholder="Search agent by name..." autocomplete="off" value="${escAttr(term)}"
          style="width:100%; box-sizing:border-box; height:36px; background:var(--field-bg); border:1.5px solid var(--border); border-radius:8px; padding:0 12px 0 32px; color:var(--ink); font-size:12.5px; font-family:inherit;" />
      </div>
      <div id="aaRecordMatches" style="display:flex; flex-direction:column; gap:5px; max-height:280px; overflow-y:auto;"></div>
    `;
    el("aaRecordClose").addEventListener("click", aaCloseRecord);
    // Only the matches list (#aaRecordMatches) re-renders on every
    // keystroke below — the <input> element itself is created ONCE here
    // and never touched again while typing. The previous version rebuilt
    // this whole popover's innerHTML (input included) on every "input"
    // event, which destroys and recreates the <input> DOM node each
    // time — the browser has nothing to keep focused, so it silently
    // drops focus after every single character and the agent has to
    // click back into the box to keep typing. Updating a separate child
    // container instead leaves the input element (and its focus/cursor
    // position) completely untouched.
    el("aaRecordSearchInput").addEventListener("input", (e) => aaRenderRecordMatches(e.target.value));
    aaRenderRecordMatches(term);
  }

  function aaRenderRecordMatches(term) {
    const t = term.trim().toLowerCase();
    const matches = (aaData ? aaData.agents : [])
      .filter((a) => !t || a.username.toLowerCase().includes(t))
      .slice(0, 30);
    const matchesEl = el("aaRecordMatches");
    if (!matchesEl) return; // popover may have been closed/replaced mid-keystroke
    matchesEl.innerHTML = matches.map((a) => {
      const dotColor = a.status === "online" ? "#34d399" : "var(--ink-soft)";
      return `
        <div class="aa-record-pick" data-username="${escAttr(a.username)}" style="display:flex; align-items:center; gap:10px; padding:8px 9px; border-radius:7px; cursor:pointer;">
          <div style="width:26px; height:26px; border-radius:7px; background:var(--field-bg); display:flex; align-items:center; justify-content:center; color:var(--ink-soft); font-weight:700; font-size:11px; flex-shrink:0;">${escHtml(a.username.charAt(0).toUpperCase())}</div>
          <span style="color:var(--ink); font-size:12.5px; flex:1;">${escHtml(a.username)}</span>
          <span style="width:6px; height:6px; border-radius:50%; background:${dotColor};"></span>
        </div>
      `;
    }).join("") || '<p class="ipa-hint" style="text-align:center;">No matches.</p>';
    matchesEl.querySelectorAll(".aa-record-pick").forEach((elx) => {
      elx.addEventListener("click", () => aaOpenRecordDetail(elx.dataset.username));
    });
  }

  async function aaOpenRecordDetail(username) {
    aaRecordSelectedUsername = username;
    const pop = el("aaRecordPopover");
    pop.innerHTML = `<div class="ipa-popover-header"><p class="ipa-popover-title">🕒 Loading…</p></div>`;
    try {
      const url = "/api/presence/record?username=" + encodeURIComponent(username);
      const res = await authFetch()(url);
      const data = await res.json();
      if (!data.ok) {
        pop.innerHTML = `<div class="ipa-popover-header"><p class="ipa-popover-title">🕒 Record</p><span style="color:var(--ink-soft); cursor:pointer;" id="aaRecordClose2">✕</span></div><p class="ipa-hint">${escHtml(data.error || "Couldn't load this agent's record.")}</p>`;
        el("aaRecordClose2").addEventListener("click", aaCloseRecord);
        return;
      }
      aaRenderRecordDetail(data);
    } catch {
      pop.innerHTML = `<p class="ipa-hint">Couldn't load this agent's record. Try again.</p>`;
    }
  }

  function aaRenderRecordDetail(data) {
    const pop = el("aaRecordPopover");
    const t = data.today;
    const isOnline = t.status === "online";
    const isInactive = t.status === "inactive";
    const statusColor = isOnline ? "#34d399" : isInactive ? "var(--ink-soft)" : "#5f5e5a";
    const statusLabel = isOnline ? "Online" : isInactive ? "Inactive" : "Offline";
    const statusTime = isOnline || isInactive ? fmtRelative(t.statusSince) : fmtRelative(t.lastActiveAt);
    // No more per-day timeline table — see the module note at the top of
    // _shared/presence.js for why that was removed (KV write cost). This
    // now shows just the current status + today's total + Last 7 days,
    // which is the only history that's still cheaply available.
    pop.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <span style="color:var(--ink-soft); font-size:12px; cursor:pointer;" id="aaBackToSearch">← Back to search</span>
        <span style="color:var(--ink-soft); cursor:pointer;" id="aaRecordClose3">✕</span>
      </div>
      <div style="display:flex; align-items:center; gap:10px; margin:10px 0 4px;">
        <div style="width:30px; height:30px; border-radius:8px; background:var(--field-bg); display:flex; align-items:center; justify-content:center; color:#34d399; font-weight:700; font-size:12px; flex-shrink:0;">${escHtml(data.username.charAt(0).toUpperCase())}</div>
        <span style="color:var(--ink); font-weight:600; font-size:14.5px; flex:1;">${escHtml(data.username)}</span>
        <span style="display:inline-flex; align-items:center; gap:5px;">
          <span style="width:7px; height:7px; border-radius:50%; background:${statusColor}; flex-shrink:0;"></span>
          <span style="color:${statusColor}; font-size:12px; font-weight:700;">${statusLabel}</span>
        </span>
      </div>
      <div style="color:var(--ink-soft); font-size:11.5px; margin:2px 0 16px;">${escHtml(statusTime)} · Today online: ${escHtml(fmtDuration(t.totalOnlineSecondsToday))} · Last active: ${escHtml(fmtClock(t.lastActiveAt))}</div>

      <div style="color:var(--label-blue); font-size:10px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; margin-bottom:8px;">Last 7 days</div>
      <div style="border:1px solid var(--border); border-radius:10px;">
        <table style="width:100%; border-collapse:collapse; font-size:11.5px;">
          <thead><tr>
            <th style="text-align:left; padding:7px 12px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); border-right:1px solid var(--panel-border);">Date</th>
            <th style="text-align:right; padding:7px 12px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border); border-right:1px solid var(--panel-border);">Total online time</th>
            <th style="text-align:right; padding:7px 12px; color:var(--ink-soft); font-size:9.5px; text-transform:uppercase; background:var(--card-bg); border-bottom:1.5px solid var(--border);">Last active time</th>
          </tr></thead>
          <tbody>
            ${data.last7.map((d, i) => {
              const isLast = i === data.last7.length - 1;
              const bb = isLast ? "" : "border-bottom:1px solid var(--panel-border);";
              return `
                <tr style="${i === 0 ? "background:rgba(200,145,47,0.08);" : ""}">
                  <td style="padding:8px 12px; color:${i === 0 ? "var(--accent-gold)" : "var(--ink)"}; font-weight:${i === 0 ? "700" : "400"}; ${bb} border-right:1px solid var(--panel-border);">${escHtml(d.label)}</td>
                  <td style="padding:8px 12px; color:var(--ink); text-align:right; font-family:var(--font-mono); ${bb} border-right:1px solid var(--panel-border); white-space:nowrap;">${escHtml(fmtDuration(d.totalOnlineSeconds))}</td>
                  <td style="padding:8px 12px; color:var(--ink-soft); text-align:right; font-family:var(--font-mono); ${bb} white-space:nowrap;">${escHtml(fmtClock(d.lastActiveAt))}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
    el("aaRecordClose3").addEventListener("click", aaCloseRecord);
    el("aaBackToSearch").addEventListener("click", () => aaRenderRecordSearch(""));
  }

  // ---- Open/close (mirrors the existing #acctModalBackdrop pattern in
  // index.html — .is-open toggles opacity/pointer-events via CSS). ----
  function open() {
    const backdrop = el("aaModalBackdrop");
    if (!backdrop) return;
    backdrop.classList.add("is-open");
    aaSearchTerm = "";
    aaStatusFilter = null;
    el("aaSearch").value = "";
    aaLoadList();
    if (aaPollTimer) clearInterval(aaPollTimer);
    aaPollTimer = setInterval(aaLoadList, 10000); // only polls while the popup is actually open
  }
  function close() {
    const backdrop = el("aaModalBackdrop");
    if (backdrop) backdrop.classList.remove("is-open");
    if (aaPollTimer) { clearInterval(aaPollTimer); aaPollTimer = null; }
    aaCloseRecord();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const backdrop = el("aaModalBackdrop");
    if (!backdrop) return; // this markup only exists on index.html
    el("aaModalClose").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    el("aaRefreshBtn").addEventListener("click", aaLoadList);
    el("aaRecordBtn").addEventListener("click", aaOpenRecord);
    el("aaPopoverScrim").addEventListener("click", aaCloseRecord);
    el("aaSearch").addEventListener("input", (e) => {
      aaSearchTerm = e.target.value;
      if (aaData) aaRenderList();
    });
  });

  window.ActiveAgentsModal = { open, close };
})();
