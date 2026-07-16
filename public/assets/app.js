(function () {
  const params = new URLSearchParams(location.search);
  const moduleId = params.get("module");
  const module = window.MODULES.find((m) => m.id === moduleId);

  const formCard = document.querySelector(".form-card");
  const titleEl = document.getElementById("formTitle");
  const iconEl = document.getElementById("formIcon");
  const hintEl = document.getElementById("formHint");

  if (!module) {
    titleEl.textContent = "Form not found";
    hintEl.textContent = "That module doesn't exist. Go back and pick one from the list.";
    formCard.querySelector("form").style.display = "none";
    return;
  }

  document.title = `${module.name} — Issue Submission`;
  iconEl.textContent = module.icon;
  titleEl.textContent = `${module.name} Request`;
  hintEl.textContent = module.description;
  document.getElementById("submitLabel").textContent = `Submit ${module.name}`;
  document.getElementById("reporterLabelText").textContent = module.reporterLabel || "Agent Name";

  // ---- Brand dropdown ----
  const brandSelect = document.querySelector('select[name="brand"]');
  brandSelect.innerHTML =
    `<option value="" disabled selected>Select brand</option>` +
    window.BRANDS.map((b) => `<option value="${b.id}">${b.name}</option>`).join("");

  // ---- Dynamic fields (with emphasize box + showIf conditionals) ----
  const container = document.getElementById("dynamicFields");
  const fieldEls = {}; // key -> { wrap, control }

  module.fields.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "field" + (f.emphasize ? " field-emphasize" : "");
    if (f.showIf) wrap.setAttribute("data-conditional", "true");

    const req = f.required ? '<span class="required">*</span>' : "";
    let control = "";

    if (f.type === "textarea") {
      control = `<textarea name="${f.key}" placeholder="${f.placeholder || ""}"></textarea>`;
    } else if (f.type === "select") {
      control = `<select name="${f.key}">
        <option value="" disabled selected>Select ${f.label.toLowerCase()}</option>
        ${f.options.map((o) => `<option value="${o}">${o}</option>`).join("")}
      </select>`;
    } else {
      control = `<input type="${f.type}" name="${f.key}" placeholder="${f.placeholder || ""}" />`;
    }

    wrap.innerHTML = `<label>${f.label} ${req}</label>${control}`;
    container.appendChild(wrap);
    fieldEls[f.key] = { wrap, control: wrap.querySelector("input,select,textarea"), def: f };

    // Base required state (conditional fields only become required once visible+required)
    if (f.required && !f.showIf) fieldEls[f.key].control.required = true;
  });

  // Wire up conditional visibility: whenever a field that something depends
  // on changes, re-check every conditional field.
  function refreshConditionals() {
    module.fields.forEach((f) => {
      if (!f.showIf) return;
      const driver = fieldEls[f.showIf.field];
      const visible = driver && f.showIf.oneOf.includes(driver.control.value);
      const { wrap, control } = fieldEls[f.key];
      wrap.classList.toggle("is-visible", visible);
      control.required = visible && !!f.required;
      if (!visible) control.value = "";
    });
  }
  module.fields.forEach((f) => {
    if (f.type === "select") fieldEls[f.key].control.addEventListener("change", refreshConditionals);
  });
  refreshConditionals();

  // ---- Attachments dropzone (click / drag&drop / paste, max N files) ----
  const maxFiles = (module.attachments && module.attachments.max) || 3;
  document.getElementById("attachLabel").textContent = `Supporting Screenshots (Max ${maxFiles})`;
  document.getElementById("dzSub").textContent = `JPG, PNG, PDF — Max ${maxFiles} files`;

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const fileListEl = document.getElementById("fileList");
  let files = []; // File objects

  function renderFileList() {
    fileListEl.innerHTML = files
      .map(
        (f, i) => `<div class="file-chip"><span class="name">${f.name}</span><button type="button" data-i="${i}">&times;</button></div>`
      )
      .join("");
    fileListEl.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        files.splice(Number(btn.dataset.i), 1);
        renderFileList();
      });
    });
  }

  function addFiles(list) {
    for (const f of list) {
      if (files.length >= maxFiles) break;
      files.push(f);
    }
    renderFileList();
  }

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });
  fileInput.addEventListener("change", () => addFiles(fileInput.files));

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
    })
  );
  dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  window.addEventListener("paste", (e) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.kind === "file");
    if (!items.length) return;
    addFiles(items.map((i) => i.getAsFile()).filter(Boolean));
  });

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---- Submit ----
  const form = document.getElementById("issueForm");
  const btn = document.getElementById("submitBtn");
  const status = document.getElementById("statusMsg");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "";
    status.className = "status-msg";
    btn.disabled = true;
    btn.textContent = "Submitting…";

    try {
      const formData = new FormData(form);
      const fields = module.fields
        .filter((f) => !f.showIf || fieldEls[f.key].wrap.classList.contains("is-visible"))
        .map((f) => ({ key: f.key, label: f.label, value: formData.get(f.key) || "" }));

      const attachments = await Promise.all(
        files.map(async (f) => ({ name: f.name, type: f.type, dataUrl: await fileToDataUrl(f) }))
      );

      const payload = {
        module: module.id,
        brand: formData.get("brand"),
        reporter: formData.get("reporter"),
        fields,
        attachments,
      };

      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Submission failed");

      status.textContent = !data.sheetAttempted
        ? "Submitted — posted to Telegram."
        : data.sheetLogged
        ? "Submitted — posted to Telegram and logged to sheet."
        : `Submitted to Telegram, but sheet logging failed: ${data.sheetError || "unknown error"}`;
      status.className = data.sheetAttempted && !data.sheetLogged ? "status-msg err" : "status-msg ok";
      form.reset();
      brandSelect.selectedIndex = 0;
      files = [];
      renderFileList();
      refreshConditionals();
    } catch (err) {
      status.textContent = err.message || "Something went wrong. Try again.";
      status.className = "status-msg err";
    } finally {
      btn.disabled = false;
      document.getElementById("submitLabel").textContent = `Submit ${module.name}`;
    }
  });
})();
