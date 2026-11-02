import {
  buildAdaptiveModel,
  demoDatasets,
  formatAdaptive,
  adaptiveReply,
} from "./adaptive.js";
export function createAdaptiveDashboard(options) {
  const {
    state,
    api,
    document: doc,
    escape,
    icon,
    openModal,
    render,
    go,
  } = options;
  let examples = [];
  let sequence = 0;
  const active = () => !!state.backend?.backend || state.adaptive !== undefined;
  const value = (n, format = "number", currency = "IDR") =>
    formatAdaptive(n, format, currency);
  const period = (model) =>
    model?.period.from
      ? model.period.from === model.period.to
        ? model.period.from
        : model.period.from + " – " + model.period.to
      : "Seluruh data";
  const datasetOptions = () => state.datasets || [];
  function initDemo() {
    examples = demoDatasets(options.orders());
    state.workspaceName = "Ruang kerja contoh";
    state.datasets = examples.map(({ rows, ...d }) => d);
    state.demoDatasetId = state.demoDatasetId || examples[0].id;
    const chosen =
      examples.find((d) => d.id === state.demoDatasetId) || examples[0];
    state.adaptive = buildAdaptiveModel(chosen, state.adaptiveView || {});
    state.files = examples.map((d) => ({
      id: "seed-" + d.id,
      name: d.name,
      type: "CSV",
      domain: "Data contoh",
      rows: d.row_count,
      date: "Data contoh",
      size: "Contoh",
    }));
    options.setInsights(state.adaptive.findings);
    state.resolved = [];
  }
  function onBootstrap(data) {
    state.datasets = data.datasets || [];
    state.adaptive = data.adaptiveDashboard || null;
    if (state.adaptive)
      state.adaptiveView = {
        ...state.adaptive.selection,
        datasetId: state.adaptive.dataset.id,
      };
    else state.adaptiveView = {};
  }
  function query() {
    const view = state.adaptiveView || {};
    return new URLSearchParams(
      Object.entries({
        datasetId: view.datasetId,
        adaptiveDays: view.days,
        metricKey: view.metricKey,
        dateKey: view.dateKey,
        groupKey: view.groupKey,
        offset: state.adaptiveOffset || 0,
      }).filter(([, v]) => v !== undefined && v !== null),
    ).toString();
  }
  async function load() {
    const id = ++sequence;
    try {
      if (!state.cloud) {
        const chosen =
          examples.find((d) => d.id === state.demoDatasetId) || examples[0];
        state.adaptive = buildAdaptiveModel(chosen, {
          ...state.adaptiveView,
          offset: state.adaptiveOffset || 0,
        });
        state.adaptiveView = {
          ...state.adaptive.selection,
          datasetId: chosen.id,
        };
        options.setInsights(state.adaptive.findings);
      } else {
        const data = await api("/adaptive-dashboard?" + query());
        if (id !== sequence) return;
        state.adaptive = data;
        state.datasets = data.datasets;
        state.adaptiveView = { ...data.selection, datasetId: data.dataset.id };
        options.setInsights(data.findings || []);
      }
      render();
    } catch (error) {
      options.toast(error.message, true);
      render();
    }
  }
  function controls(compact = false) {
    const model = state.adaptive;
    if (!model) return "";
    const suffix = compact ? "-chat" : "";
    return `<div class="adaptive-controls ${compact ? "compact" : ""}"><label>Sumber analisis<select class="input" id="adaptive-source${suffix}">${datasetOptions()
      .map(
        (d) =>
          `<option value="${escape(d.id)}" ${model.dataset.id === d.id ? "selected" : ""}>${escape(d.label || d.name)}</option>`,
      )
      .join(
        "",
      )}</select></label><label>Periode<select class="input" id="adaptive-period${suffix}">${[
      ["all", "Seluruh data"],
      ["7", "7 hari"],
      ["30", "30 hari"],
      ["90", "90 hari"],
      ["366", "1 tahun"],
    ]
      .map(
        ([key, label]) =>
          `<option value="${key}" ${String(model.selection.days) === key ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select></label>${!compact ? `<details class="adaptive-adjust"><summary>Atur tampilan ${icon("down", 12)}</summary><div><label>Metrik<select class="input" id="adaptive-metric"><option value="count" ${model.selection.metricKey === "count" ? "selected" : ""}>Jumlah baris</option>${model.options.metrics.map((c) => `<option value="${c.key}" ${model.selection.metricKey === c.key ? "selected" : ""}>${escape(c.label)}</option>`).join("")}</select></label><label>Tanggal<select class="input" id="adaptive-date"><option value="none" ${model.selection.dateKey === "none" ? "selected" : ""}>Tanpa tanggal</option>${model.options.dates.map((c) => `<option value="${c.key}" ${model.selection.dateKey === c.key ? "selected" : ""}>${escape(c.label)}</option>`).join("")}</select></label><label>Kelompok<select class="input" id="adaptive-group"><option value="none" ${model.selection.groupKey === "none" ? "selected" : ""}>Tanpa kelompok</option>${model.options.groups.map((c) => `<option value="${c.key}" ${model.selection.groupKey === c.key ? "selected" : ""}>${escape(c.label)}</option>`).join("")}</select></label></div></details>` : ""}</div>`;
  }
  function trend() {
    const chart = state.adaptive.trend;
    if (!chart.points.length) return "";
    const width = 680,
      height = 225,
      left = 60,
      right = 15,
      top = 18,
      bottom = 35;
    const numbers = chart.points.map((p) => p.value);
    const low = Math.min(0, ...numbers),
      high = Math.max(0, ...numbers),
      span = high - low || 1;
    const x = (index) =>
      left +
      (chart.points.length === 1 ? 0.5 : index / (chart.points.length - 1)) *
        (width - left - right);
    const y = (n) =>
      height - bottom - ((n - low) / span) * (height - top - bottom);
    const path = chart.points
      .map((p, i) => (i ? "L" : "M") + x(i) + "," + y(p.value))
      .join(" ");
    const tick = (n) =>
      Math.abs(n) >= 1e6
        ? (n / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 }) +
          " jt"
        : Math.abs(n) >= 1e3
          ? (n / 1e3).toLocaleString("id-ID", { maximumFractionDigits: 1 }) +
            " rb"
          : n.toLocaleString("id-ID", { maximumFractionDigits: 1 });
    return `<section class="panel adaptive-trend"><div class="panel-head"><h2>${escape(chart.title)}</h2><span class="muted">${escape(period(state.adaptive))}</span></div><svg class="sales-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(chart.title)}">${[
      0, 1, 2, 3,
    ]
      .map((i) => {
        const n = low + (span * i) / 3;
        return `<line class="grid" x1="${left}" x2="${width - right}" y1="${y(n)}" y2="${y(n)}"/><text x="${left - 9}" y="${y(n) + 4}" text-anchor="end">${tick(n)}</text>`;
      })
      .join(
        "",
      )}<path class="current" d="${path}"/>${chart.points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.value)}" r="3" tabindex="0" class="adaptive-point"><title>${p.date}: ${value(p.value, chart.format, chart.currency)}</title></circle>${i === 0 || i === chart.points.length - 1 || i % Math.max(1, Math.floor(chart.points.length / 5)) === 0 ? `<text x="${x(i)}" y="${height - 9}" text-anchor="middle">${escape(p.date.length === 7 ? p.date : p.date.slice(5))}</text>` : ""}`).join("")}</svg></section>`;
  }
  function breakdown() {
    const chart = state.adaptive.breakdown;
    if (!chart.items.length) return "";
    const max = Math.max(...chart.items.map((i) => Math.abs(i.value)), 1);
    return `<section class="panel adaptive-breakdown"><div class="panel-head"><h2>${escape(chart.title)}</h2></div><div class="channel-list">${chart.items.map((item) => `<div class="channel-item"><div class="channel-row"><span>${escape(item.name)}</span><strong>${value(item.value, chart.format, chart.currency)}</strong></div><div class="channel-bar"><span style="width:${(Math.abs(item.value) / max) * 100}%;${item.value < 0 ? "background:var(--red)" : ""}"></span></div></div>`).join("")}${chart.totalGroups > 7 ? `<p class="muted">7 dari ${chart.totalGroups} kelompok</p>` : ""}</div></section>`;
  }
  function table(full = false) {
    const model = state.adaptive;
    const data = model.table;
    const columns = data.columns.slice(0, full ? 100 : 6);
    const rows = full ? data.rows : data.rows.slice(0, 8);
    return `<section class="section-gap"><div class="section-title"><h2>Data sumber <small>${data.total} baris</small></h2>${!full ? `<a class="panel-action" href="#records">Lihat data ${icon("arrow", 12)}</a>` : model.dataset.documentId ? `<a class="panel-action" href="/api/documents/${model.dataset.documentId}/download">Unduh asli ${icon("download", 12)}</a>` : ""}</div><div class="panel table-scroll"><table class="products-table adaptive-data-table"><thead><tr><th>BARIS</th>${columns.map((c) => `<th>${escape(c.label)}</th>`).join("")}</tr></thead><tbody>${
      rows
        .map(
          (row) =>
            `<tr><td>${row.row}</td>${columns
              .map((c, index) => {
                const cell = row.values[index];
                return `<td>${escape(cell === null || cell === undefined ? "—" : String(cell))}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("") ||
      `<tr><td colspan="${columns.length + 1}"><div class="empty-state">Tidak ada data pada periode ini.</div></td></tr>`
    }</tbody></table></div>${full ? `<div class="table-footer"><span>${data.total ? data.offset + 1 : 0}–${data.offset + rows.length} dari ${data.total}</span><div><button class="btn btn-small" data-action="adaptive-previous" ${!data.offset ? "disabled" : ""}>Sebelumnya</button><button class="btn btn-small" data-action="adaptive-next" ${data.offset + 50 >= data.total ? "disabled" : ""}>Berikutnya</button></div></div>` : ""}</section>`;
  }
  function empty() {
    return `<div class="page-heading"><h1>Ringkasan data</h1><button class="btn btn-primary" data-action="upload">${icon("plus", 14)}Unggah data</button></div>${options.setup?.() || ""}<section class="panel adaptive-empty">${icon("data", 32)}<h2>Dashboard mengikuti data Anda</h2><p>Unggah dokumen untuk membentuk metrik dan grafik.</p><button class="btn" data-action="upload">Pilih dokumen</button></section>`;
  }
  function overview() {
    const model = state.adaptive;
    if (!model) return empty();
    return `<div class="page-heading"><div><h1>${escape(model.context)}</h1></div><button class="btn btn-primary" data-action="upload">${icon("plus", 15)}Unggah data</button></div>${options.tabs()}${controls()}<div class="demo-strip"><span><i class="live-dot"></i>${state.cloud ? "Data bisnis" : "Data contoh"}</span><span class="separator"></span><span>${model.table.total} baris</span><span class="separator"></span><span>${escape(model.dataset.name)}</span></div>${options.setup?.() || ""}${options.priorities()}<div class="kpi-grid adaptive-kpi-grid">${model.kpis.map((k, index) => `<article class="kpi"><div class="kpi-label">${escape(k.label)}<button class="icon-button" data-adaptive-kpi="${index}" aria-label="Sumber ${escape(k.label)}">${icon("info", 14)}</button></div><div class="kpi-value" title="${escape(value(k.value, k.format, k.currency))}">${escape(k.format === "currency" && k.currency === "IDR" && Math.abs(k.value) >= 1e6 ? "Rp " + (k.value / 1e6).toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " jt" : value(k.value, k.format, k.currency))}</div><div class="kpi-bottom"><span>${k.aggregation === "sum" ? "Penjumlahan" : k.aggregation === "avg" ? "Rata-rata" : k.aggregation === "distinct" ? "Nilai unik" : "Jumlah"}</span></div></article>`).join("")}</div><div class="adaptive-chart-grid ${!model.trend.points.length || !model.breakdown.items.length ? "single" : ""}">${trend()}${breakdown()}</div>${table()}`;
  }
  function records() {
    return state.adaptive
      ? `<div class="page-heading"><h1>Data</h1><button class="btn btn-primary" data-action="upload">${icon("plus", 14)}Unggah data</button></div>${options.tabs()}${controls()}${table(true)}`
      : empty();
  }
  function bind() {
    for (const suffix of ["", "-chat"]) {
      doc
        .querySelector("#adaptive-source" + suffix)
        ?.addEventListener("change", (e) => {
          state.adaptiveView = { datasetId: e.target.value, days: "all" };
          state.demoDatasetId = e.target.value;
          state.adaptiveOffset = 0;
          e.target.disabled = true;
          load();
        });
      doc
        .querySelector("#adaptive-period" + suffix)
        ?.addEventListener("change", (e) => {
          state.adaptiveView = { ...state.adaptiveView, days: e.target.value };
          state.adaptiveOffset = 0;
          e.target.disabled = true;
          load();
        });
    }
    for (const [id, key] of [
      ["adaptive-metric", "metricKey"],
      ["adaptive-date", "dateKey"],
      ["adaptive-group", "groupKey"],
    ])
      doc.querySelector("#" + id)?.addEventListener("change", (e) => {
        state.adaptiveView = { ...state.adaptiveView, [key]: e.target.value };
        state.adaptiveOffset = 0;
        e.target.disabled = true;
        load();
      });
  }
  function handleClick(el) {
    if (el.dataset.adaptiveKpi !== undefined) {
      const k = state.adaptive?.kpis[Number(el.dataset.adaptiveKpi)];
      if (!k) return false;
      openModal(
        `<div class="modal-header"><h2 id="modal-title">${escape(k.label)}</h2><button class="icon-button" data-action="close-modal" aria-label="Tutup">${icon("close", 18)}</button></div><div class="modal-body"><div class="source-summary"><div>SUMBER<strong>${escape(k.source.name)}</strong></div><div>KOLOM<strong>${escape(state.adaptive.table.columns.find((c) => c.key === k.field)?.label || "Seluruh baris")}</strong></div><div>PERHITUNGAN<strong>${escape({ sum: "Penjumlahan nilai", avg: "Rata-rata nilai", distinct: "Jumlah nilai unik", count: "Jumlah baris", "count matching": "Jumlah sesuai status" }[k.aggregation] || k.aggregation)}</strong></div><div>PERIODE<strong>${escape(period(state.adaptive))}</strong></div></div><a class="btn" href="#records" data-action="adaptive-records">Lihat data</a></div>`,
      );
      return true;
    }
    if (
      el.dataset.action === "adaptive-next" ||
      el.dataset.action === "adaptive-previous"
    ) {
      state.adaptiveOffset = Math.max(
        0,
        (state.adaptiveOffset || 0) +
          (el.dataset.action === "adaptive-next" ? 50 : -50),
      );
      load();
      return true;
    }
    if (el.dataset.action === "adaptive-records") {
      options.closeModal();
      go("records");
      return true;
    }
    return false;
  }
  return {
    answerDemo: (question) => adaptiveReply(state.adaptive, question),
    active,
    initDemo,
    onBootstrap,
    query,
    overview,
    records,
    controls,
    bind,
    handleClick,
    load,
  };
}
