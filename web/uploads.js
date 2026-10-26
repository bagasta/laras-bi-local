import { domains, catalogMapping } from "./document-fields.js";
const formats = new Set(["csv", "xlsx", "pdf", "docx", "pptx", "txt", "md"]);
const labels = {
  pending: "Menunggu",
  creating: "Membuat proyek Supabase",
  starting: "Menunggu database siap",
  migrating: "Menyiapkan tabel",
  ready: "Database siap",
  uncertain: "Memeriksa permintaan sebelumnya",
  failed: "Penyiapan tertunda",
};

export function createUploadManager(options) {
  const {
    api,
    state,
    openModal,
    closeModal,
    icon,
    escape,
    toast,
    syncCloud,
    initializeBackend,
    document: doc,
    crypto,
    readBytes,
  } = options;
  let batch = null;
  function invalidate() {
    if (batch) {
      batch.preview = null;
      batch.previewKey = crypto.randomUUID();
    }
  }
  function newBatch() {
    return {
      items: [],
      open: true,
      busy: false,
      phase: "select",
      message: "",
      preview: null,
      previewKey: crypto.randomUUID(),
      approved: false,
    };
  }
  function selected() {
    return batch.items.filter((item) => item.include);
  }
  function display() {
    if (!batch?.open) return;
    const items = batch.items;
    const ready =
      selected().length && selected().every((i) => i.result && !i.error);
    openModal(`<div class="modal-header"><div><h2 id="modal-title">Unggah dokumen</h2><p>CSV, Excel, PDF, Word, PowerPoint, TXT, MD · 20 berkas · Total 10 MB</p></div><button class="icon-button" data-action="batch-close" aria-label="Tutup">${icon("close", 18)}</button></div><div class="modal-body multi-body">
   ${batch.message ? `<div class="batch-notice" role="status">${escape(batch.message)}</div>` : ""}
   ${!state.backend?.cloud?.configured && !state.cloud ? `<div class="cloud-connect-prompt"><span>Hubungkan Supabase untuk menyimpan dokumen.</span><button class="btn btn-small" data-action="cloud-connect">Hubungkan</button></div>` : ""}
   <div class="multi-dropzone" id="multi-dropzone"><button class="btn" data-action="batch-pick" ${batch.busy ? "disabled" : ""}>${icon("plus", 14)}Pilih berkas</button><span>atau seret beberapa berkas ke sini</span><input class="hidden" id="multi-file-input" type="file" multiple accept=".csv,.xlsx,.pdf,.docx,.pptx,.txt,.md" ${batch.busy ? "disabled" : ""}><button class="panel-action" data-action="batch-sample" ${batch.busy ? "disabled" : ""}>Contoh CSV</button></div>
   <div class="upload-queue">${items
     .map(
       (
         item,
       ) => `<article class="upload-queue-item ${item.error ? "has-error" : ""}"><div class="upload-item-top"><label><input type="checkbox" data-batch-include="${item.key}" ${item.include ? "checked" : ""} ${batch.busy ? "disabled" : ""}><strong>${escape(item.file.name)}</strong></label><span class="muted">${Math.max(1, Math.ceil(item.file.size / 1024))} KB</span><span class="upload-state">${escape(item.error ? "Perlu diperbaiki" : item.result ? (item.result.review ? "Teks siap ditinjau" : "Siap ditinjau") : item.running ? "Mengunggah…" : "Menunggu")}</span><button class="icon-button" data-action="batch-remove" data-item="${item.key}" aria-label="Hapus ${escape(item.file.name)}" ${batch.busy ? "disabled" : ""}>${icon("close", 14)}</button></div>
    ${item.error ? `<p class="upload-error">${escape(item.error)}</p><button class="panel-action" data-action="batch-retry" data-item="${item.key}">Coba kembali</button>` : ""}
    ${
      item.result
        ? `<details class="upload-document-detail"><summary>${item.result.review ? `${item.result.pages.length} ${item.result.type === "PPTX" ? "slide" : item.result.type === "PDF" ? "halaman" : "bagian"} · Tinjau teks` : `${item.result.tables.length} tabel · Periksa kolom`}</summary>${
            item.result.review
              ? `<p class="muted">Teks dokumen disimpan untuk ditinjau.</p>${item.result.pages
                  .slice(0, 3)
                  .map(
                    (p) =>
                      `<div class="document-page"><small>${escape(p.label || `Halaman ${p.page}`)}</small><p>${escape(p.text.slice(0, 1200) || "Tidak ada teks yang dapat diekstrak. Gambar memerlukan OCR.")}</p></div>`,
                  )
                  .join("")}`
              : item.result.tables
                  .map(
                    (table) =>
                      `<section class="sheet-mapping"><label class="sheet-title"><input type="checkbox" data-sheet-include="${item.key}:${table.id}" ${table.include !== false ? "checked" : ""} ${batch.busy ? "disabled" : ""}>${escape(table.sheet || "Data penjualan")} <small>${table.rowCount} baris</small></label><label class="document-domain">Jenis data<select class="input" data-table-domain="${item.key}:${table.id}" ${batch.busy ? "disabled" : ""}>${Object.entries(
                        domains,
                      )
                        .map(
                          ([key, value]) =>
                            `<option value="${key}" ${(table.domain || "sales") === key ? "selected" : ""}>${value.label}</option>`,
                        )
                        .join(
                          "",
                        )}</select></label><div class="mapping-grid">${Object.entries(
                        domains[table.domain || "sales"].fields,
                      )
                        .map(
                          ([field, label]) =>
                            `<div class="field-group"><label>${label}<select class="input" data-batch-map="${item.key}:${table.id}:${field}" ${batch.busy ? "disabled" : ""}><option value="">${field === "discount" ? "Tidak ada (0)" : field === "minimum" ? "Tidak diatur (0)" : field === "total" ? "Hitung otomatis" : "Tidak dipetakan"}</option>${table.headers.map((h, i) => `<option value="${i}" ${String(table.mapping[field]) === String(i) ? "selected" : ""}>${escape(h)}</option>`).join("")}</select></label></div>`,
                        )
                        .join(
                          "",
                        )}</div><div class="table-scroll"><table class="products-table"><thead><tr>${table.headers
                        .slice(0, 6)
                        .map((h) => `<th>${escape(h)}</th>`)
                        .join("")}</tr></thead><tbody>${table.sample
                        .slice(0, 3)
                        .map(
                          (r) =>
                            `<tr>${r.values
                              .slice(0, 6)
                              .map((v) => `<td>${escape(v)}</td>`)
                              .join("")}</tr>`,
                        )
                        .join("")}</tbody></table></div></section>`,
                  )
                  .join("")
          }</details>`
        : ""
    }
   </article>`,
     )
     .join("")}</div>
   ${batch.preview ? `<div class="batch-summary"><h3>Ringkasan impor</h3><div class="summary-grid"><div class="summary-card"><strong>${batch.preview.added}</strong><span>Baris baru</span></div><div class="summary-card"><strong>${batch.preview.updated}</strong><span>Diperbarui</span></div><div class="summary-card"><strong>${batch.preview.unchanged}</strong><span>Identik, dilewati</span></div></div><label class="confirm-label"><input type="checkbox" id="approve-batch" ${batch.approved ? "checked" : ""} ${batch.busy ? "disabled" : ""}>Saya telah meninjau dan menyetujui impor ${batch.preview.documents.length} dokumen unik.</label></div>` : ""}
  </div><div class="modal-footer"><span>${items.filter((i) => i.result).length} / ${items.length} diperiksa</span><div class="footer-actions">${!ready ? `<button class="btn btn-primary" data-action="batch-process" ${!selected().length || batch.busy ? "disabled" : ""}>${batch.busy ? "Memproses…" : "Proses dokumen"}</button>` : batch.preview ? `<button class="btn btn-primary" data-action="batch-commit" ${!batch.approved || batch.busy ? "disabled" : ""}>${batch.busy ? "Menyimpan…" : "Setujui dan impor"}</button>` : `<button class="btn btn-primary" data-action="batch-review" ${batch.busy ? "disabled" : ""}>Tinjau ringkasan</button>`}</div></div>`);
    doc
      .querySelector("#multi-file-input")
      ?.addEventListener("change", (e) => addFiles([...e.target.files]));
    const drop = doc.querySelector("#multi-dropzone");
    drop?.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("dragover");
    });
    drop?.addEventListener("dragleave", () =>
      drop.classList.remove("dragover"),
    );
    drop?.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!batch.busy) addFiles([...e.dataTransfer.files]);
    });
  }
  function addFiles(files) {
    if (!batch || batch.busy) return;
    if (batch.items.length + files.length > 20) {
      batch.message =
        "Maksimal 20 berkas. Hapus sebagian berkas untuk melanjutkan.";
      display();
      return;
    }
    if (
      batch.items.reduce((n, i) => n + i.file.size, 0) +
        files.reduce((n, f) => n + f.size, 0) >
      10_000_000
    ) {
      batch.message = "Total berkas maksimal 10 MB.";
      display();
      return;
    }
    for (const file of files) {
      const extension = file.name.split(".").at(-1).toLowerCase();
      batch.items.push({
        file,
        key: crypto.randomUUID(),
        include: true,
        result: null,
        error: !formats.has(extension)
          ? "Gunakan CSV, XLSX, PDF, DOCX, PPTX, TXT, atau MD."
          : file.size > 2_000_000
            ? "Ukuran berkas maksimal 2 MB."
            : null,
      });
    }
    batch.message = "";
    invalidate();
    display();
  }
  async function setup() {
    if (
      state.cloud &&
      (!state.backend?.cloud || state.backend.cloud.phase === "ready")
    )
      return;
    if (!state.backend?.cloud?.configured) {
      batch.busy = false;
      batch.message = "Hubungkan akun Supabase terlebih dahulu.";
      display();
      return false;
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      if (!batch.open) return false;
      const result = await api("/cloud/provision", {
        method: "POST",
        body: {},
      });
      batch.message = labels[result.phase] || "Menyiapkan database…";
      display();
      if (result.phase === "ready") {
        await initializeBackend();
        if (!state.cloud)
          throw new Error(
            state.backendError || "Database belum dapat dihubungi.",
          );
        return true;
      }
      await (
        options.sleep ||
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )((result.retryAfter || 5) * 1000);
    }
    throw new Error(
      "Database masih disiapkan. Pilih Proses dokumen untuk melanjutkan proyek yang sama.",
    );
  }
  function bytesToBase64(bytes) {
    let value = "";
    for (let index = 0; index < bytes.length; index += 16384)
      value += String.fromCharCode(...bytes.subarray(index, index + 16384));
    return btoa(value);
  }
  async function process() {
    if (batch.busy || !selected().length) return;
    batch.busy = true;
    batch.message = "Memeriksa koneksi…";
    display();
    try {
      if (
        (!state.cloud ||
          (state.backend?.cloud && state.backend.cloud.phase !== "ready")) &&
        (await setup()) === false
      )
        return;
      for (const item of selected()) {
        if (!batch.open) break;
        if (item.result || item.error) continue;
        item.running = true;
        batch.message = "Mengunggah dan memeriksa dokumen…";
        display();
        try {
          const bytes = await readBytes(item.file);
          item.result = await api("/documents/extract", {
            method: "POST",
            key: item.key,
            body: { name: item.file.name, base64: bytesToBase64(bytes) },
          });
          item.error = null;
        } catch (error) {
          item.error = error.message;
        } finally {
          item.running = false;
          display();
        }
      }
      batch.message = selected().some((i) => i.error)
        ? "Perbaiki atau keluarkan berkas yang gagal sebelum melanjutkan."
        : "Dokumen siap ditinjau.";
    } catch (error) {
      batch.message = error.message;
    } finally {
      batch.busy = false;
      display();
    }
  }
  async function review() {
    if (batch.busy) return;
    batch.busy = true;
    batch.message = "Memeriksa seluruh dokumen…";
    display();
    try {
      batch.preview = await api("/uploads/preview", {
        method: "POST",
        key: batch.previewKey,
        body: {
          documents: selected().map((i) => ({
            id: i.result.id,
            tables: i.result.tables.map((t) => ({
              id: t.id,
              mapping: t.mapping,
              domain: t.domain || "sales",
              include: t.include !== false,
            })),
          })),
        },
      });
      batch.message = "Semua perubahan akan disimpan bersama.";
      batch.approved = false;
    } catch (error) {
      batch.message = error.message;
    } finally {
      batch.busy = false;
      display();
    }
  }
  async function commit() {
    if (batch.busy || !batch.preview || !batch.approved) return;
    batch.busy = true;
    batch.message = "Menyimpan dokumen…";
    display();
    try {
      const result = await api(`/uploads/${batch.preview.id}/commit`, {
        method: "POST",
        body: { approved: true },
      });
      batch.open = false;
      closeModal();
      await syncCloud();
      options.go("sources");
      toast(
        `Impor selesai: ${result.added} baru, ${result.updated} diperbarui.`,
      );
      batch = null;
    } catch (error) {
      batch.message = error.message;
      if (error.code === "REVISION_CONFLICT") {
        invalidate();
        batch.approved = false;
      }
    } finally {
      if (batch) {
        batch.busy = false;
        display();
      }
    }
  }
  function connect() {
    if (batch) batch.open = false;
    openModal(
      `<div class="modal-header"><div><h2 id="modal-title">Hubungkan Supabase</h2><p>Periksa token, lalu pilih organisasi Anda.</p></div><button class="icon-button" data-action="close-modal" aria-label="Tutup">${icon("close", 18)}</button></div><div class="modal-body"><form id="cloud-connection-form"><div class="field-group"><label for="cloud-token">Personal access token</label><input type="password" class="input" id="cloud-token" required autocomplete="off" maxlength="1000"><div class="connection-token-actions"><a class="panel-action" href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noopener noreferrer">Buat token di Supabase ${icon("external", 12)}</a><button type="button" class="btn btn-small" id="cloud-check-token">Periksa token</button></div><small class="muted" id="cloud-token-status" role="status"></small></div><div class="field-group"><label for="cloud-organization">Organisasi</label><select class="input" id="cloud-organization" required disabled><option value="">Periksa token terlebih dahulu</option></select></div><div class="field-group"><label for="cloud-project-name">Nama proyek</label><input class="input" id="cloud-project-name" required maxlength="80" value="${escape(state.backend?.cloud?.projectName || "Laras Bisnis")}"></div><p class="muted connection-privacy">Token disimpan terenkripsi. Proyek disiapkan saat dokumen diproses, hanya pada organisasi Free.</p><div id="cloud-form-error" role="alert"></div><button class="btn btn-primary" id="cloud-connect-submit" disabled>Simpan koneksi</button></form></div>`,
    );
    const form = doc.querySelector("#cloud-connection-form");
    const tokenInput = form.querySelector("#cloud-token");
    const organization = form.querySelector("#cloud-organization");
    const projectInput = form.querySelector("#cloud-project-name");
    const checkButton = form.querySelector("#cloud-check-token");
    const button = form.querySelector("#cloud-connect-submit");
    const errorMessage = form.querySelector("#cloud-form-error");
    const status = form.querySelector("#cloud-token-status");
    let verifiedToken = "",
      lookupVersion = 0,
      saving = false;
    function resetOrganizations() {
      verifiedToken = "";
      lookupVersion++;
      organization.innerHTML =
        '<option value="">Periksa token terlebih dahulu</option>';
      organization.disabled = true;
      button.disabled = true;
      checkButton.disabled = false;
      checkButton.textContent = "Periksa token";
      status.textContent = "";
    }
    tokenInput.addEventListener("input", resetOrganizations);
    organization.addEventListener("change", () => {
      button.disabled = !verifiedToken || !organization.value || saving;
    });
    checkButton.addEventListener("click", async () => {
      resetOrganizations();
      const token = tokenInput.value.trim();
      if (!token) {
        errorMessage.textContent = "Masukkan personal access token Supabase.";
        tokenInput.focus();
        return;
      }
      const version = lookupVersion;
      checkButton.disabled = true;
      checkButton.textContent = "Memeriksa…";
      errorMessage.textContent = "";
      try {
        const result = await api("/cloud/organizations", {
          method: "POST",
          body: { token },
        });
        if (!form.isConnected || version !== lookupVersion) return;
        if (!result.organizations.length) {
          errorMessage.textContent =
            "Tidak ada organisasi yang dapat diakses oleh token ini. Periksa akun dan izin token di Supabase.";
          return;
        }
        verifiedToken = token;
        organization.innerHTML =
          '<option value="">Pilih organisasi</option>' +
          result.organizations
            .map(
              (org) =>
                `<option value="${escape(org.slug)}">${escape(org.name)}</option>`,
            )
            .join("");
        organization.disabled = false;
        const previous = state.backend?.cloud?.organization;
        if (result.organizations.some((org) => org.slug === previous))
          organization.value = previous;
        else if (result.organizations.length === 1)
          organization.value = result.organizations[0].slug;
        button.disabled = !organization.value;
        status.textContent = `${result.organizations.length} organisasi tersedia`;
      } catch (error) {
        if (!form.isConnected || version !== lookupVersion) return;
        errorMessage.textContent = error.message;
        if (error.code === "SUPABASE_TOKEN_INVALID") tokenInput.value = "";
      } finally {
        if (form.isConnected && version === lookupVersion) {
          checkButton.disabled = false;
          checkButton.textContent = "Periksa token";
        }
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (saving) return;
      if (
        !verifiedToken ||
        verifiedToken !== tokenInput.value.trim() ||
        !organization.value
      ) {
        errorMessage.textContent =
          "Periksa token lalu pilih organisasi yang tersedia.";
        return;
      }
      saving = true;
      button.disabled =
        checkButton.disabled =
        tokenInput.disabled =
        organization.disabled =
        projectInput.disabled =
          true;
      errorMessage.textContent = "";
      try {
        await api("/cloud/connection", {
          method: "POST",
          body: {
            token: verifiedToken,
            organization: organization.value,
            projectName: projectInput.value,
          },
        });
        tokenInput.value = verifiedToken = "";
        closeModal();
        await initializeBackend();
        if (batch?.items.length) {
          batch.open = true;
          display();
          await process();
        } else
          toast(
            "Koneksi tersimpan. Database dibuat otomatis saat dokumen diproses.",
          );
      } catch (error) {
        if (!form.isConnected) return;
        errorMessage.textContent = error.message;
        if (error.code === "SUPABASE_TOKEN_INVALID") {
          tokenInput.value = "";
          resetOrganizations();
        }
      } finally {
        saving = false;
        tokenInput.disabled =
          projectInput.disabled =
          checkButton.disabled =
            false;
        organization.disabled = !verifiedToken;
        button.disabled = !verifiedToken || !organization.value;
      }
    });
  }
  function connectAI() {
    const current = state.backend?.aiConnection || {};
    openModal(
      `<div class="modal-header"><div><h2 id="modal-title">Hubungkan OpenRouter</h2><p>Gunakan API key Anda untuk Chat with Data.</p></div><button class="icon-button" data-action="close-modal" aria-label="Tutup">${icon("close", 18)}</button></div><div class="modal-body"><form id="ai-connection-form"><div class="field-group"><label for="ai-key">API key OpenRouter</label><input type="password" class="input" id="ai-key" required autocomplete="off" maxlength="1000"><a class="panel-action" href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer">Buat API key ${icon("external", 12)}</a></div><div class="field-group"><label for="ai-model">Model</label><input class="input" id="ai-model" required maxlength="150" value="${escape(current.model || "openrouter/free")}"><small class="muted">openrouter/free memilih model gratis yang tersedia. Kuota dan biaya mengikuti model OpenRouter.</small></div><p class="muted connection-privacy">Key disimpan terenkripsi di server. Saat bertanya, cuplikan data dan teks dokumen dikirim ke OpenRouter.</p><div id="ai-form-error" role="alert"></div><div class="connection-actions"><button class="btn btn-primary" id="ai-connect-submit">Periksa dan simpan</button>${current.source === "owner" ? '<button type="button" class="btn" id="ai-disconnect">Putuskan koneksi</button>' : ""}</div></form></div>`,
    );
    const form = doc.querySelector("#ai-connection-form"),
      key = form.querySelector("#ai-key"),
      model = form.querySelector("#ai-model"),
      button = form.querySelector("#ai-connect-submit"),
      remove = form.querySelector("#ai-disconnect"),
      errorBox = form.querySelector("#ai-form-error");
    let busy = false;
    async function save(disconnect = false) {
      if (busy) return;
      busy = true;
      button.disabled = key.disabled = model.disabled = true;
      if (remove) remove.disabled = true;
      errorBox.textContent = "";
      try {
        await api("/ai/connection", {
          method: disconnect ? "DELETE" : "POST",
          body: disconnect ? {} : { key: key.value, model: model.value },
        });
        key.value = "";
        if (form.isConnected) closeModal();
        await initializeBackend();
        toast(
          disconnect
            ? "Koneksi OpenRouter diputuskan."
            : "OpenRouter tersimpan. Buka Chat with Data untuk bertanya.",
        );
      } catch (error) {
        if (form.isConnected) errorBox.textContent = error.message;
        if (error.code === "OPENROUTER_KEY_INVALID") key.value = "";
      } finally {
        busy = false;
        button.disabled = key.disabled = model.disabled = false;
        if (remove) remove.disabled = false;
      }
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      save();
    });
    remove?.addEventListener("click", () => save(true));
  }
  async function connectChatGPT() {
    const value = state.backend?.chatgpt;
    if (!value?.available) {
      toast("OAuth ChatGPT tersedia pada runtime lokal Laras.", true);
      return;
    }
    const account = value.account;
    openModal(
      `<div class="modal-header"><div><h2 id="modal-title">ChatGPT</h2><p>${account?.connected ? escape(account.email) : "Gunakan paket ChatGPT Anda untuk Chat with Data."}</p></div><button class="icon-button" data-action="close-modal" aria-label="Tutup">${icon("close", 18)}</button></div><div class="modal-body"><p id="chatgpt-notice" class="muted">${escape(value.notice || (account?.verifiedAt ? "Permintaan AI terakhir berhasil diselesaikan." : account?.sharing ? "Login terhubung. Akses model terkonfirmasi setelah jawaban pertama selesai." : "Login dan berikan izin penggunaan paket ChatGPT."))}</p>${value.accounts?.length > 1 ? `<div class="field-group"><label for="chatgpt-account">Akun tersimpan</label><select class="input" id="chatgpt-account">${value.accounts.map((p, i) => `<option value="${escape(p.id)}" ${p.id === account?.id ? "selected" : ""}>${escape(p.email)} · ${i + 1}</option>`).join("")}</select></div>` : ""}${account?.connected && account?.sharing ? '<div class="field-group"><label for="chatgpt-model">Model ChatGPT</label><select class="input" id="chatgpt-model" disabled><option value="">Memuat model…</option></select></div><button class="btn btn-primary" id="chatgpt-save-model" disabled>Simpan model</button>' : ""}<div class="connection-actions" style="margin-top:16px"><button class="btn" id="chatgpt-sign-in">Continue with ChatGPT</button><button class="btn" id="chatgpt-add-account">Gunakan akun lain</button>${account?.connected ? '<button class="btn" id="chatgpt-disconnect">Putuskan koneksi</button>' : ""}</div><p class="muted connection-privacy">Token disimpan terenkripsi di komputer ini. Cuplikan data dikirim ke OpenAI saat Anda bertanya.</p><a class="panel-action" href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noopener noreferrer">Manage usage ${icon("external", 12)}</a><div id="chatgpt-error" role="alert"></div></div>`,
    );
    const form = doc.querySelector("#chatgpt-error").parentElement;
    const errorBox = form.querySelector("#chatgpt-error");
    let busy = false;
    const perform = async (task) => {
      if (busy) return;
      busy = true;
      form.querySelectorAll("button").forEach((b) => (b.disabled = true));
      errorBox.textContent = "";
      try {
        await task();
      } catch (error) {
        if (form.isConnected) errorBox.textContent = error.message;
      } finally {
        busy = false;
        if (form.isConnected)
          form.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
    const signIn = (newAccount) =>
      perform(async () => {
        const result = await api("/chatgpt/connect", {
          method: "POST",
          body: { newAccount },
        });
        const url = new URL(result.authorizationURL);
        if (url.origin !== "https://auth.openai.com")
          throw new Error("Alamat login ChatGPT tidak valid.");
        options.navigate
          ? options.navigate(url.href)
          : doc.defaultView.location.assign(url.href);
      });
    form
      .querySelector("#chatgpt-sign-in")
      .addEventListener("click", () => signIn(false));
    form
      .querySelector("#chatgpt-add-account")
      .addEventListener("click", () => signIn(true));
    form.querySelector("#chatgpt-disconnect")?.addEventListener("click", () =>
      perform(async () => {
        const result = await api("/chatgpt/disconnect", {
          method: "POST",
          body: {},
        });
        if (form.isConnected) closeModal();
        await initializeBackend();
        toast(
          result.revoked
            ? "Koneksi ChatGPT diputuskan."
            : "Koneksi lokal diputuskan. Periksa akses aplikasi di ChatGPT Settings.",
          !result.revoked,
        );
      }),
    );
    form
      .querySelector("#chatgpt-account")
      ?.addEventListener("change", (event) =>
        perform(async () => {
          await api("/chatgpt/select", {
            method: "POST",
            body: { id: event.target.value },
          });
          await initializeBackend();
          connectChatGPT();
        }),
      );
    if (account?.connected && account?.sharing) {
      const select = form.querySelector("#chatgpt-model"),
        save = form.querySelector("#chatgpt-save-model");
      try {
        const { models } = await api("/chatgpt/models");
        if (!form.isConnected) return;
        select.innerHTML =
          '<option value="">Pilih model</option>' +
          models
            .map(
              (m) =>
                `<option value="${escape(m.slug)}" ${m.slug === account.model ? "selected" : ""}>${escape(m.name)}</option>`,
            )
            .join("");
        select.disabled = false;
        save.disabled = !select.value;
        select.addEventListener(
          "change",
          () => (save.disabled = !select.value),
        );
        save.addEventListener("click", () =>
          perform(async () => {
            if (!select.value) throw new Error("Pilih model ChatGPT.");
            await api("/chatgpt/model", {
              method: "POST",
              body: { model: select.value },
            });
            if (form.isConnected) closeModal();
            await initializeBackend();
            toast("Model ChatGPT dipilih. Buka Chat with Data untuk bertanya.");
          }),
        );
        if (!models.length)
          errorBox.textContent =
            "Belum ada model yang tersedia untuk akun ini.";
      } catch (error) {
        if (form.isConnected) {
          select.innerHTML = '<option value="">Model belum tersedia</option>';
          errorBox.textContent = error.message;
        }
      }
    }
  }
  async function showDocument(id) {
    try {
      const result = await api("/documents/" + id);
      openModal(
        `<div class="modal-header"><h2 id="modal-title">${escape(result.name)}</h2><button class="icon-button" data-action="close-modal" aria-label="Tutup">${icon("close", 18)}</button></div><div class="modal-body"><a class="btn" href="/api/documents/${result.id}/download" download>Unduh berkas asli ${icon("download", 13)}</a>${result.review ? result.pages.map((p) => `<section class="document-page"><h3>${escape(p.label || `Halaman ${p.page}`)}</h3><p>${escape(p.text || "Tidak ada teks. Dokumen hasil pindai memerlukan OCR.")}</p></section>`).join("") : `<p class="muted">${result.tables.length} tabel · ${result.tables.reduce((n, t) => n + t.rowCount, 0)} baris</p>`}</div>`,
      );
    } catch (error) {
      toast(error.message, true);
    }
  }
  doc.addEventListener("change", (e) => {
    const el = e.target;
    if (!batch || batch.busy) return;
    if (el.dataset.batchInclude) {
      const item = batch.items.find((i) => i.key === el.dataset.batchInclude);
      item.include = el.checked;
      invalidate();
      display();
    }
    if (el.dataset.sheetInclude) {
      const [key, id] = el.dataset.sheetInclude.split(":");
      const table = batch.items
        .find((i) => i.key === key)
        .result.tables.find((t) => t.id === id);
      table.include = el.checked;
      invalidate();
      display();
    }
    if (el.dataset.tableDomain) {
      const [key, id] = el.dataset.tableDomain.split(":");
      const table = batch.items
        .find((i) => i.key === key)
        .result.tables.find((t) => t.id === id);
      table.domain = el.value;
      table.mapping =
        table.domain === "sales"
          ? options.salesMapping(table.headers)
          : catalogMapping(table.headers, table.domain);
      invalidate();
      display();
    }
    if (el.dataset.batchMap) {
      const [key, id, field] = el.dataset.batchMap.split(":");
      batch.items
        .find((i) => i.key === key)
        .result.tables.find((t) => t.id === id).mapping[field] = el.value;
      invalidate();
      display();
      doc.querySelector(`[data-batch-map="${el.dataset.batchMap}"]`)?.focus();
    }
    if (el.id === "approve-batch") {
      batch.approved = el.checked;
      const button = doc.querySelector('[data-action="batch-commit"]');
      if (button) button.disabled = !el.checked;
    }
  });
  function handleClick(el) {
    const action = el.dataset.action;
    if (action === "upload" && options.enabled()) {
      if (!batch) batch = newBatch();
      batch.open = true;
      display();
      return true;
    }
    if (action === "chatgpt-connect") {
      connectChatGPT();
      return true;
    }
    if (action === "ai-connect") {
      connectAI();
      return true;
    }
    if (action === "cloud-connect") {
      connect();
      return true;
    }
    if (action === "file-detail" && state.cloud) {
      const file = state.files.find((f) => f.id === el.dataset.file);
      if (file?.documentId) {
        showDocument(file.documentId);
        return true;
      }
    }
    if (!action?.startsWith("batch-")) return false;
    if (action === "batch-close") {
      batch.open = false;
      closeModal();
    }
    if (action === "batch-pick") doc.querySelector("#multi-file-input").click();
    if (action === "batch-sample") {
      const value =
        "tanggal,proyek,klien,nilai_kontrak,jam_kerja,status,tenggat\n2026-10-26,Desain layanan,Klien A,200000,4,Berjalan,2026-11-02";
      const bytes = new TextEncoder().encode(value);
      addFiles([
        {
          name: "contoh_proyek.csv",
          size: bytes.length,
          arrayBuffer: async () => bytes.buffer,
        },
      ]);
    }
    if (action === "batch-remove") {
      if (batch.busy) return true;
      const item = batch.items.find((i) => i.key === el.dataset.item);
      batch.busy = true;
      display();
      (async () => {
        try {
          if (
            item?.result &&
            !item.result.duplicate &&
            !batch.items.some(
              (other) =>
                other.key !== item.key && other.result?.id === item.result.id,
            )
          )
            await api("/documents/" + item.result.id, { method: "DELETE" });
          batch.items = batch.items.filter((i) => i.key !== el.dataset.item);
          invalidate();
        } catch (error) {
          if (error.code === "DOCUMENT_COMMITTED") {
            batch.items = batch.items.filter((i) => i.key !== el.dataset.item);
            invalidate();
          } else batch.message = error.message;
        } finally {
          batch.busy = false;
          display();
        }
      })();
    }
    if (action === "batch-retry") {
      const item = batch.items.find((i) => i.key === el.dataset.item);
      if (item) {
        item.error = null;
        process();
      }
    }
    if (action === "batch-process") process();
    if (action === "batch-review") review();
    if (action === "batch-commit") commit();
    return true;
  }
  return {
    handleClick,
    addFiles,
    open: () => {
      if (!batch) batch = newBatch();
      batch.open = true;
      display();
    },
    close: () => {
      if (batch) batch.open = false;
    },
    showDocument,
  };
}
