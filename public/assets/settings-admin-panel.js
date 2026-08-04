/**
 * Settings admin panel — renders one row per controllable item (status
 * dropdown + "which roles can bypass" multi-select + Save button) and
 * wires saving back to the admin API. Pair with settings-dropdown.css/js
 * and the backend/ endpoints.
 *
 * ADAPT THESE before using — they're specific to the app this was
 * pulled from and won't exist in yours:
 *   - `authFetch(url, opts)`   → your app's authenticated fetch wrapper
 *   - `escapeHtml(str)`        → any HTML-escaping helper (must exist —
 *                                 don't skip this, it's XSS prevention)
 *   - `canEdit`                → your own permission check (boolean)
 *   - `ROLE_OPTIONS`           → your app's actual list of role names
 *   - the container element    → wherever your modal/panel body lives
 *
 * `onSaved(itemId, item)` — called after a successful Save/Reset with
 * the SAME { status, bypassRoles } object the POST response returned.
 * Use it to update your Home page's badges via
 * apply-feature-status-to-ui.js's applyFeatureStatusItem(itemId, {
 *   status: item.status,
 *   blocked: item.status !== "active" && !item.bypassRoles.includes(myOwnRole),
 * }) — do NOT re-call applyFeatureStatuses() (the fetch-everything
 * version) from here; see applyFeatureStatusItem()'s doc comment for
 * why that can read a stale value right after this exact save.
 */

function renderFeatureSettingsPanel(container, items, { authFetch, escapeHtml, canEdit, setNote, onSaved }) {
  const STATUS_OPTIONS = [
    { value: "active", label: "Active" },
    { value: "maintenance", label: "🚧 Maintenance" },
    { value: "coming_soon", label: "🔜 Coming soon" },
  ];
  // Replace with your own role list, in ascending rank order.
  const ROLE_OPTIONS = [
    { value: "agent", label: "Agent" },
    { value: "senior", label: "Senior" },
    { value: "admin", label: "Admin" },
    { value: "superadmin", label: "SuperAdmin" },
    { value: "owner", label: "Owner" },
  ];

  const statusDropdown = (current) => {
    const currentLabel = (STATUS_OPTIONS.find((o) => o.value === current) || STATUS_OPTIONS[0]).label;
    return `
      <div class="fs-dropdown" data-field="status" data-value="${escapeHtml(current)}">
        <button type="button" class="fs-dropdown-trigger" ${canEdit ? "" : "disabled"}>${escapeHtml(currentLabel)}</button>
        <div class="fs-dropdown-menu">
          ${STATUS_OPTIONS.map((o) => `<div class="fs-dropdown-option${o.value === current ? " selected" : ""}" data-value="${o.value}"><span>${escapeHtml(o.label)}</span><span class="fs-check">✓</span></div>`).join("")}
        </div>
      </div>`;
  };
  const roleSummary = (roles) => {
    if (!roles.length) return "Nobody can bypass";
    const labels = roles.map((r) => ROLE_OPTIONS.find((o) => o.value === r)?.label || r);
    return labels.length <= 2 ? labels.join(", ") : `${labels.length} roles can bypass`;
  };
  const rolesDropdown = (roles, isActive) => `
    <div class="fs-dropdown${isActive ? " fs-dropdown-na" : ""}" data-field="roles" data-values="${escapeHtml(roles.join(","))}">
      <button type="button" class="fs-dropdown-trigger" ${canEdit && !isActive ? "" : "disabled"}>${isActive ? "Not applicable while Active" : escapeHtml(roleSummary(roles))}</button>
      <div class="fs-dropdown-menu">
        ${ROLE_OPTIONS.map((o) => `<div class="fs-dropdown-option${roles.includes(o.value) ? " selected" : ""}" data-value="${o.value}"><span>${escapeHtml(o.label)} can still use it</span><span class="fs-check">✓</span></div>`).join("")}
      </div>
    </div>`;

  function render() {
    cleanupOrphanedFsDropdownMenus(); // from settings-dropdown.js — see that file
    const rowsHtml = items.map((item) => `
      <div class="tgroute-row" data-item="${escapeHtml(item.id)}">
        <div class="tgroute-mod-name">${item.emoji || ""} ${escapeHtml(item.name)}
          <span class="route-tag${item.status !== "active" ? " custom" : ""}">${item.status === "active" ? "active" : item.status.replace("_", " ")}</span>
        </div>
        <div class="tgroute-fields">
          ${statusDropdown(item.status)}
          ${rolesDropdown(item.bypassRoles || ["superadmin", "owner"], item.status === "active")}
          <div class="tgroute-row-actions">
            ${canEdit ? '<button type="button" class="tgroute-action-btn fs-save">Save</button>' : ""}
          </div>
        </div>
      </div>`).join("");

    // .fs-scroll caps the row list's height and scrolls INTERNALLY —
    // without this wrapper, a long item list just keeps growing the
    // whole modal taller than the viewport, and your modal's own
    // backdrop ends up scrolling instead, taking the title/close button
    // out of view along with it. Freezing the header is the whole
    // point of this wrapper — don't drop it even if your item list is
    // short today; it costs nothing when there's no overflow yet.
    container.innerHTML = `
      <div class="fs-scroll"><div class="tgroute-modules">${rowsHtml}</div></div>
      <hr class="tgroute-divider" />
      ${canEdit ? "" : '<p class="edit-modal-note">View only.</p>'}
      <p class="edit-modal-note tgroute-footnote">Maintenance/Coming soon blocks everyone whose role isn't checked in the second dropdown. Owner is always allowed through even if unchecked. Changes apply immediately, no redeploy needed.</p>`;

    // initFsDropdowns() binds a click listener to EVERY trigger
    // unconditionally, including ones that start disabled — a disabled
    // <button> simply doesn't fire click events natively, so this needs
    // no extra "is it disabled" check of its own. If you ever hand-roll
    // your own version of this instead of using settings-dropdown.js as-
    // is: do NOT skip binding a listener based on the trigger's disabled
    // state at render time. The roles dropdown starts disabled whenever
    // status is "active" and gets enabled live by onStatusChange below
    // — if the listener was never attached in the first place because
    // it was disabled at bind time, re-enabling it later does nothing
    // and clicking it will silently fail to open. (This exact bug shipped
    // once in a hand-rolled fork of this component — keep the binding
    // unconditional.)
    initFsDropdowns(container, {
      // Live-gray the roles dropdown the instant Active is picked,
      // instead of waiting for Save — it visually communicates "this
      // field doesn't apply right now" immediately.
      onStatusChange: (dd, newValue) => {
        const rolesDd = dd.closest(".tgroute-fields").querySelector('.fs-dropdown[data-field="roles"]');
        if (!rolesDd) return;
        const isActive = newValue === "active";
        rolesDd.classList.toggle("fs-dropdown-na", isActive);
        const trigger = rolesDd.querySelector(".fs-dropdown-trigger");
        if (isActive) {
          trigger.setAttribute("disabled", "disabled");
          trigger.dataset.prevText = trigger.textContent;
          trigger.textContent = "Not applicable while Active";
        } else {
          trigger.removeAttribute("disabled");
          if (trigger.dataset.prevText) trigger.textContent = trigger.dataset.prevText;
        }
      },
      onRoleToggle: (dd, roles) => {
        dd.querySelector(".fs-dropdown-trigger").textContent = roleSummary(roles);
      },
    });

    container.querySelectorAll(".fs-save").forEach((btn) => {
      btn.addEventListener("click", () => save(btn.closest(".tgroute-row")));
    });
  }

  // Plain labels for the toast result text — deliberately not reusing
  // STATUS_OPTIONS' labels above, since those carry emoji for the
  // dropdown UI ("🚧 Maintenance") that would look odd repeated in a
  // one-line toast message.
  const STATUS_TOAST_LABEL = { active: "Active", maintenance: "Maintenance", coming_soon: "Coming soon" };

  async function save(row) {
    const itemId = row.dataset.item;
    const status = row.querySelector('.fs-dropdown[data-field="status"]').dataset.value;
    const bypassRolesRaw = row.querySelector('.fs-dropdown[data-field="roles"]').dataset.values || "";
    const bypassRoles = bypassRolesRaw.split(",").filter(Boolean);
    setNote("Saving…");
    const scroller = container.querySelector(".fs-scroll");
    const scrollTop = scroller ? scroller.scrollTop : 0;
    const action = status === "active" ? "reset" : "save";
    const res = await authFetch("/api/admin/feature-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, itemId, status, bypassRoles }),
    });
    const data = await res.json();
    if (!data.ok) return setNote(data.error || "Save failed.", "err");
    const idx = items.findIndex((i) => i.id === itemId);
    if (idx >= 0) items[idx] = { ...items[idx], ...data.item };
    // Result names the status that was actually just saved (Active /
    // Maintenance / Coming soon), not a generic "Saved." — this is a
    // multi-state control, so a fixed string would be right for one
    // status and silently wrong-sounding for the other two.
    setNote(`Save ${STATUS_TOAST_LABEL[status] || status} success.`, "ok");
    // Pass the value this SAME response just returned — not a re-fetch.
    // See this file's header comment and applyFeatureStatusItem()'s doc
    // comment in apply-feature-status-to-ui.js for why.
    if (onSaved) onSaved(itemId, data.item);
    render();
    const newScroller = container.querySelector(".fs-scroll");
    if (newScroller) newScroller.scrollTop = scrollTop;
  }

  render();
}
