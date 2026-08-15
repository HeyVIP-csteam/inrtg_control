/**
 * IP Access dashboard — renders into the Account Management modal's body
 * when "IP Access" is opened (see index.html's openAcctModal, mode ===
 * "whitelist"). Talks to /api/admin/ip-access. Design decisions here
 * follow php-issue-hub-完整优化记录.md §4 (already fought through once on
 * a reference project — reused as-is rather than re-litigated):
 *   - 4 cards, not 5 — "Manually added" folded into "Approved" (an IP is
 *     an IP once it's in the whitelist; HOW it got there is a column,
 *     not its own category).
 *   - All three tables (Pending/Approved/Blocked) share ONE column-width
 *     ratio, Actions column included — independently-sized columns look
 *     fine per-table but visibly don't line up once stacked together.
 *   - Actions are text buttons in one color, not colored/emoji icons.
 *   - IP addresses render in a fixed green + monospace style.
 *   - Each table paginates independently (10/20/30 per page).
 *   - "Manage offices" and "Record" are separate stacked popups, not
 *     inline accordions. They live as static buttons in the modal's
 *     header row (next to ✕), not inside this file's own innerHTML —
 *     see wireHeaderButtonsOnce below for why that matters.
 *   - The 4 stat cards are click-to-filter, not just numbers: nothing is
 *     shown below them until a card is clicked. Total IPs then shows
 *     Approved+Blocked ("the settled ones"); Approved/Pending/Blocked
 *     each show just that one table. Pending is NEVER part of Total
 *     IPs's view — it only appears once its own card is clicked.
 *   - "Add IP manually" / "Block an IP" are collapsible, auto-collapse
 *     after a successful submit, and accept comma-separated batches
 *     submitted ONE AT A TIME (not Promise.all — concurrent writes to
 *     the same office's allowedIPs array would clobber each other).
 */
(function () {
  const COLS = "1.1fr 1.3fr 1.2fr 1.1fr 1fr"; // shared across all 3 tables
  const pageState = {}; // { [category]: { page, size } }

  // Which table section(s) are currently shown below the stat cards.
  // null (the default, on every fresh open) means "nothing yet" — just
  // the 4 cards + Add/Block collapsibles, no table, until the person
  // clicks a card. "total" (only reachable by clicking Total IPs) is
  // Approved + Blocked together ("the settled ones"); every other value
  // is exactly the one matching table. Pending is NEVER part of "total"
  // — it only ever appears once its own card is clicked.
  let activeView = null; // null | "total" | "pending" | "approved" | "blocked"

  let ctx = null; // { authFetch, canEdit, escapeHtml }
  let data = null; // last GET /api/admin/ip-access response
  let headerWired = false; // see wireHeaderButtonsOnce

  async function fetchDashboard() {
    const res = await ctx.authFetch("/api/admin/ip-access");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Failed to load IP Access data.");
    return json;
  }

  window.renderIpAccessPanel = async function renderIpAccessPanel(bodyEl, options) {
    ctx = options;
    try {
      data = await fetchDashboard();
    } catch (e) {
      bodyEl.innerHTML = `<p class="edit-modal-note err">${ctx.escapeHtml(e.message)}</p>`;
      return;
    }
    ["pending", "approved", "blocked"].forEach((cat) => { if (!pageState[cat]) pageState[cat] = { page: 1, size: 10 }; });
    render(bodyEl);
    wireHeaderButtonsOnce();
  };

  // Called by index.html after an office is saved/deleted in the
  // "Manage offices" popup, and after every row action below, so the
  // stats cards + tables reflect the change without closing the modal.
  window.refreshIpAccessPanel = async function refreshIpAccessPanel() {
    const bodyEl = document.getElementById("acctModalBody");
    if (!bodyEl || !bodyEl.querySelector(".ipa-dashboard")) return; // not currently open on this panel
    try {
      data = await fetchDashboard();
    } catch (e) {
      return; // silent — a failed background refresh shouldn't blow away what's already on screen
    }
    render(bodyEl);
  };

  function render(bodyEl) {
    const { stats } = data;
    // Pending gets a breathing/pulsing card the moment there's at least
    // one request waiting — 0 pending is the calm, ordinary state, 1+ is
    // "someone needs a decision", same visual language as the maintenance
    // "breathing light" badge elsewhere in the app (see
    // maintenance-breathing-light.css's fs-breathe keyframe — ipa-pulse
    // below is its own copy tuned for a whole card instead of a small
    // pill, but deliberately the same 1.8s timing so it doesn't feel like
    // a different, ad-hoc animation next to that one).
    const pendingAlert = stats.pending > 0 ? " ipa-pending-alert" : "";
    bodyEl.innerHTML = `
      <div class="ipa-dashboard">
        <div class="ipa-stat-cards">
          <div class="ipa-stat-card${activeView === "total" ? " ipa-stat-card-active" : ""}" data-ipa-view="total"><div class="ipa-stat-label">Total IPs</div><div class="ipa-stat-value">${stats.totalIPs}</div></div>
          <div class="ipa-stat-card${activeView === "approved" ? " ipa-stat-card-active" : ""}" data-ipa-view="approved"><div class="ipa-stat-label">Approved</div><div class="ipa-stat-value ipa-stat-approved">${stats.approved}</div></div>
          <div class="ipa-stat-card${activeView === "pending" ? " ipa-stat-card-active" : ""}${pendingAlert}" data-ipa-view="pending"><div class="ipa-stat-label">Pending</div><div class="ipa-stat-value ipa-stat-pending">${stats.pending}</div></div>
          <div class="ipa-stat-card${activeView === "blocked" ? " ipa-stat-card-active" : ""}" data-ipa-view="blocked"><div class="ipa-stat-label">Blocked</div><div class="ipa-stat-value ipa-stat-blocked">${stats.blocked}</div></div>
        </div>
        ${ctx.canEdit ? `
        <div class="ipa-collapsible" id="ipaAddWrap">
          <div class="ipa-collapsible-header" id="ipaAddHeader"><span class="ipa-chev">▸</span> Add IP manually</div>
          <div class="ipa-collapsible-body" id="ipaAddBody" style="display:none;">
            <div class="ipa-form-row">
              <div class="field"><label>Office</label><select id="ipaAddOffice">${officeOptions()}</select></div>
              <div class="field"><label>IP address(es)</label>
                <div class="ipa-input-with-btn">
                  <input type="text" id="ipaAddIps" placeholder="203.0.113.10, 203.0.113.11" autocomplete="off" />
                  <button type="button" class="ipa-inline-btn ipa-inline-btn-amber" id="ipaAddSubmit">Add</button>
                </div>
              </div>
            </div>
            <p class="ipa-form-hint">Adding more than one? Separate them with commas — 203.0.113.10, 203.0.113.11</p>
            <p class="edit-modal-note" id="ipaAddNote"></p>
          </div>
        </div>
        <div class="ipa-collapsible" id="ipaBlockWrap">
          <div class="ipa-collapsible-header" id="ipaBlockHeader"><span class="ipa-chev">▸</span> Block an IP</div>
          <div class="ipa-collapsible-body" id="ipaBlockBody" style="display:none;">
            <div class="ipa-form-row">
              <div class="field"><label>IP address(es)</label><input type="text" id="ipaBlockIps" placeholder="203.0.113.10, 203.0.113.11" autocomplete="off" /></div>
              <div class="field"><label>Reason (optional)</label>
                <div class="ipa-input-with-btn">
                  <input type="text" id="ipaBlockReason" placeholder="e.g. repeated brute-force attempts" autocomplete="off" />
                  <button type="button" class="ipa-inline-btn" id="ipaBlockSubmit">Block</button>
                </div>
              </div>
            </div>
            <p class="ipa-form-hint">Separate multiple IPs with commas. Blocking is global — independent of office or account, each one is rejected outright at login, even with a correct password.</p>
            <p class="edit-modal-note" id="ipaBlockNote"></p>
          </div>
        </div>
        ${hintText() ? `<p class="ipa-form-hint ipa-settled-hint">${hintText()}</p>` : ""}` : ""}
        ${sectionsFor(activeView).map((cat) => renderTableSection(cat, catLabel(cat), data[cat])).join("")}
      </div>`;
    wireStaticControls(bodyEl);
  }

  // No card clicked yet → nothing to say beyond "go click one". Total IPs
  // → explain why Pending isn't included. Every single-category view is
  // self-explanatory from its own table title, so no hint needed there.
  function hintText() {
    if (activeView === null) return "Click a card above to view its IPs and record.";
    if (activeView === "total") return "Approved and blocked IPs — the settled ones. Pending has its own card.";
    return "";
  }

  // null (nothing clicked yet) shows no table at all. "total" (only
  // reachable by clicking Total IPs) is deliberately Approved + Blocked,
  // NOT Pending — matches hintText() above and means opening the panel
  // never surprises anyone with a pending queue they didn't ask to see.
  // Every other view is exactly the one matching table.
  function sectionsFor(view) {
    if (view === null) return [];
    if (view === "total") return ["approved", "blocked"];
    return [view];
  }
  function catLabel(cat) {
    return cat === "pending" ? "Pending" : cat === "approved" ? "Approved" : "Blocked";
  }

  function officeOptions() {
    return (data.offices || []).map((o) => `<option value="${ctx.escapeHtml(o.id)}">${ctx.escapeHtml(o.name)}</option>`).join("");
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function ipCell(ip) {
    return `<span class="ipa-ip-text">${ctx.escapeHtml(ip)}</span>`;
  }

  function rowsFor(cat, rows) {
    if (cat === "pending") {
      return rows.map((r) => `
        <div class="ipa-row" style="grid-template-columns:${COLS};">
          <div>${ipCell(r.ip)}</div>
          <div>${ctx.escapeHtml(r.officeName || "—")}</div>
          <div>${r.attempts || 1}× · last ${fmtTime(r.lastAttemptAt)}</div>
          <div>${ctx.escapeHtml(r.username || "—")}</div>
          <div class="ipa-row-actions">
            ${ctx.canEdit ? `<button type="button" class="row-btn" data-ipa-approve="${ctx.escapeHtml(r.officeId)}|${ctx.escapeHtml(r.ip)}">Approve</button>
            <button type="button" class="row-btn" data-ipa-reject="${ctx.escapeHtml(r.officeId)}|${ctx.escapeHtml(r.ip)}">Reject</button>` : ""}
          </div>
        </div>`).join("");
    }
    if (cat === "approved") {
      return rows.map((r) => `
        <div class="ipa-row" style="grid-template-columns:${COLS};">
          <div>${ipCell(r.ip)}</div>
          <div>${ctx.escapeHtml(r.officeName || "—")}</div>
          <div title="${ctx.escapeHtml(r.source || "")}">${ctx.escapeHtml(r.addedBy || "—")}</div>
          <div>${fmtTime(r.addedAt)}</div>
          <div class="ipa-row-actions">
            ${ctx.canEdit ? `<button type="button" class="row-btn" data-ipa-remove="${ctx.escapeHtml(r.officeId)}|${ctx.escapeHtml(r.ip)}">Remove</button>` : ""}
          </div>
        </div>`).join("");
    }
    // blocked
    return rows.map((r) => `
      <div class="ipa-row" style="grid-template-columns:${COLS};">
        <div>${ipCell(r.ip)}</div>
        <div>${ctx.escapeHtml(r.reason || "—")}</div>
        <div>${ctx.escapeHtml(r.blockedBy || "—")}</div>
        <div>${fmtTime(r.blockedAt)}</div>
        <div class="ipa-row-actions">
          ${ctx.canEdit ? `<button type="button" class="row-btn" data-ipa-unblock="${ctx.escapeHtml(r.ip)}">Unblock</button>` : ""}
        </div>
      </div>`).join("");
  }

  function headerFor(cat) {
    if (cat === "pending") return ["IP", "Office", "Attempts", "Requested by", "Actions"];
    if (cat === "approved") return ["IP", "Office", "Added by", "Date", "Actions"];
    return ["IP", "Reason", "Blocked by", "Blocked at", "Actions"];
  }

  function renderTableSection(cat, label, allRows) {
    const state = pageState[cat];
    const totalPages = Math.max(1, Math.ceil(allRows.length / state.size));
    if (state.page > totalPages) state.page = totalPages;
    const pageRows = allRows.slice((state.page - 1) * state.size, state.page * state.size);
    const headers = headerFor(cat);
    return `
      <div class="ipa-table-section">
        <div class="ipa-table-header-row">
          <span class="ipa-table-title">${label} <span class="ipa-table-count">${allRows.length}</span></span>
          <label class="ipa-page-size">
            <select data-ipa-pagesize="${cat}">
              <option value="10" ${state.size === 10 ? "selected" : ""}>10 / page</option>
              <option value="20" ${state.size === 20 ? "selected" : ""}>20 / page</option>
              <option value="30" ${state.size === 30 ? "selected" : ""}>30 / page</option>
            </select>
          </label>
        </div>
        <div class="ipa-table">
          <div class="ipa-row ipa-row-head" style="grid-template-columns:${COLS};">
            ${headers.map((h) => `<div>${h}</div>`).join("")}
          </div>
          ${pageRows.length ? rowsFor(cat, pageRows) : `<div class="ipa-empty-row">Nothing here.</div>`}
        </div>
        ${totalPages > 1 ? `
        <div class="ipa-pagination">
          <button type="button" class="row-btn" data-ipa-prevpage="${cat}" ${state.page <= 1 ? "disabled" : ""}>Previous</button>
          <span class="ipa-page-indicator">Page ${state.page} / ${totalPages}</span>
          <button type="button" class="row-btn" data-ipa-nextpage="${cat}" ${state.page >= totalPages ? "disabled" : ""}>Next</button>
        </div>` : ""}
      </div>`;
  }

  // "+ Manage offices" / "🕘 Record" now live as static nodes in
  // index.html's modal header row (next to the ✕ close button), not
  // inside bodyEl's innerHTML — so unlike everything else wired in
  // wireStaticControls (which runs every render() pass, safe because
  // bodyEl's contents are thrown away and rebuilt each time), these two
  // must only ever be bound ONCE per page load, or every re-render would
  // stack another duplicate listener on the same persistent node and a
  // single click would fire the handler multiple times.
  function wireHeaderButtonsOnce() {
    if (headerWired) return;
    headerWired = true;
    document.getElementById("ipaManageOfficesBtn")?.addEventListener("click", async () => {
      if (window.ipaLoadOfficePicker) await window.ipaLoadOfficePicker();
      document.getElementById("ipaOfficeBackdrop").classList.add("is-open");
    });
    document.getElementById("ipaRecordBtn")?.addEventListener("click", () => {
      renderRecordPopup();
      document.getElementById("ipaRecordBackdrop").classList.add("is-open");
    });
  }

  function wireStaticControls(bodyEl) {
    bodyEl.querySelectorAll("[data-ipa-view]").forEach((card) => card.addEventListener("click", () => {
      activeView = card.dataset.ipaView;
      render(bodyEl);
    }));

    wireCollapsible(bodyEl, "ipaAddHeader", "ipaAddBody");
    wireCollapsible(bodyEl, "ipaBlockHeader", "ipaBlockBody");

    bodyEl.querySelector("#ipaAddSubmit")?.addEventListener("click", submitManualAdd);
    bodyEl.querySelector("#ipaBlockSubmit")?.addEventListener("click", submitBlock);

    bodyEl.querySelectorAll("[data-ipa-approve]").forEach((b) => b.addEventListener("click", () => {
      const [officeId, ip] = b.dataset.ipaApprove.split("|");
      runAction({ action: "approve", officeId, ip });
    }));
    bodyEl.querySelectorAll("[data-ipa-reject]").forEach((b) => b.addEventListener("click", () => {
      const [officeId, ip] = b.dataset.ipaReject.split("|");
      if (confirm(`Reject the pending request for ${ip}?`)) runAction({ action: "reject", officeId, ip });
    }));
    bodyEl.querySelectorAll("[data-ipa-remove]").forEach((b) => b.addEventListener("click", () => {
      const [officeId, ip] = b.dataset.ipaRemove.split("|");
      if (confirm(`Remove ${ip} from the whitelist?`)) runAction({ action: "remove", officeId, ip });
    }));
    bodyEl.querySelectorAll("[data-ipa-unblock]").forEach((b) => b.addEventListener("click", () => {
      runAction({ action: "unblock", ip: b.dataset.ipaUnblock });
    }));

    bodyEl.querySelectorAll("[data-ipa-pagesize]").forEach((sel) => sel.addEventListener("change", (e) => {
      const cat = e.target.dataset.ipaPagesize;
      pageState[cat] = { page: 1, size: Number(e.target.value) };
      render(bodyEl);
    }));
    bodyEl.querySelectorAll("[data-ipa-prevpage]").forEach((b) => b.addEventListener("click", (e) => {
      const cat = e.target.dataset.ipaPrevpage;
      pageState[cat].page = Math.max(1, pageState[cat].page - 1);
      render(bodyEl);
    }));
    bodyEl.querySelectorAll("[data-ipa-nextpage]").forEach((b) => b.addEventListener("click", (e) => {
      const cat = e.target.dataset.ipaNextpage;
      pageState[cat].page += 1;
      render(bodyEl);
    }));
  }

  function wireCollapsible(bodyEl, headerId, bodyId) {
    const header = bodyEl.querySelector(`#${headerId}`);
    const body = bodyEl.querySelector(`#${bodyId}`);
    if (!header || !body) return;
    header.addEventListener("click", () => {
      const opening = body.style.display === "none";
      body.style.display = opening ? "block" : "none";
      header.classList.toggle("open", opening);
      header.querySelector(".ipa-chev").textContent = opening ? "▾" : "▸";
    });
  }

  async function runAction(payload) {
    try {
      const res = await ctx.authFetch("/api/admin/ip-access", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.ok) { if (window.showToast) window.showToast(json.error || "Action failed.", "err"); return; }
      if (window.showToast) window.showToast("Done.", "ok");
      await window.refreshIpAccessPanel();
    } catch {
      if (window.showToast) window.showToast("Network error — try again.", "err");
    }
  }

  // Sequential, not Promise.all — every call reads-modifies-writes the
  // SAME office's allowedIPs array, so concurrent writes would clobber
  // each other and silently drop entries. Failed IPs are left in the
  // input so they're easy to retry without retyping everything.
  async function submitBatch({ ips, note, submitBtn, action, extra, onDone }) {
    const list = ips.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) { note.textContent = "Enter at least one IP address."; note.className = "edit-modal-note err"; return; }
    submitBtn.disabled = true;
    const failed = [];
    for (const ip of list) {
      try {
        const res = await ctx.authFetch("/api/admin/ip-access", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ip, ...extra }),
        });
        const json = await res.json();
        if (!json.ok) failed.push(`${ip} (${json.error || "failed"})`);
      } catch {
        failed.push(`${ip} (network error)`);
      }
    }
    submitBtn.disabled = false;
    if (failed.length) {
      note.textContent = `Some failed: ${failed.join("; ")}`;
      note.className = "edit-modal-note err";
      return failed; // caller leaves these in the input for retry
    }
    note.textContent = "Done.";
    note.className = "edit-modal-note ok";
    await window.refreshIpAccessPanel();
    if (onDone) onDone();
    return [];
  }

  async function submitManualAdd() {
    const bodyEl = document.getElementById("acctModalBody");
    const officeId = bodyEl.querySelector("#ipaAddOffice").value;
    const ipsField = bodyEl.querySelector("#ipaAddIps");
    const note = bodyEl.querySelector("#ipaAddNote");
    const submitBtn = bodyEl.querySelector("#ipaAddSubmit");
    if (!officeId) { note.textContent = "Pick an office first."; note.className = "edit-modal-note err"; return; }
    const failedList = await submitBatch({
      ips: ipsField.value, note, submitBtn, action: "manualAdd", extra: { officeId },
      onDone: () => {
        ipsField.value = "";
        // Auto-collapse on full success, matching the documented UX —
        // waits a beat so the "Done." note is actually readable first.
        setTimeout(() => { document.getElementById("ipaAddHeader")?.click(); }, 600);
      },
    });
    if (failedList && failedList.length) ipsField.value = failedList.map((f) => f.split(" (")[0]).join(", ");
  }

  async function submitBlock() {
    const bodyEl = document.getElementById("acctModalBody");
    const ipsField = bodyEl.querySelector("#ipaBlockIps");
    const reason = bodyEl.querySelector("#ipaBlockReason").value.trim();
    const note = bodyEl.querySelector("#ipaBlockNote");
    const submitBtn = bodyEl.querySelector("#ipaBlockSubmit");
    const failedList = await submitBatch({
      ips: ipsField.value, note, submitBtn, action: "block", extra: { reason },
      onDone: () => {
        ipsField.value = "";
        bodyEl.querySelector("#ipaBlockReason").value = "";
        setTimeout(() => { document.getElementById("ipaBlockHeader")?.click(); }, 600);
      },
    });
    if (failedList && failedList.length) ipsField.value = failedList.map((f) => f.split(" (")[0]).join(", ");
  }

  function renderRecordPopup() {
    const body = document.getElementById("ipaRecordBody");
    const entries = data.record || [];
    if (!entries.length) {
      body.innerHTML = `<p class="edit-modal-note">No activity recorded yet.</p>`;
      return;
    }
    const rows = entries.map((e) => `
      <div class="ipa-row" style="grid-template-columns:1.2fr 0.9fr 1fr 1fr 1.4fr;">
        <div>${fmtTime(e.ts)}</div>
        <div>${ctx.escapeHtml(e.action || "—")}</div>
        <div>${ipCell(e.ip || "—")}</div>
        <div>${ctx.escapeHtml(e.by || "system")}</div>
        <div>${ctx.escapeHtml(e.officeName || e.detail || "—")}</div>
      </div>`).join("");
    body.innerHTML = `
      <div class="ipa-table">
        <div class="ipa-row ipa-row-head" style="grid-template-columns:1.2fr 0.9fr 1fr 1fr 1.4fr;">
          <div>Time</div><div>Action</div><div>IP</div><div>By</div><div>Detail</div>
        </div>
        ${rows}
      </div>`;
  }
})();
