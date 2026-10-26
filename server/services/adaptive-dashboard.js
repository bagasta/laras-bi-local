import {
  buildAdaptiveModel,
  inferColumns,
  contextFor,
} from "../../web/adaptive.js";
import { AppError, uuid, sha256, integer } from "../http.js";
export function adaptiveSelection(input = {}) {
  const result = {
    days: input.adaptiveDays || "all",
    offset: integer(input.offset, 0, 0, 100000),
  };
  if (result.days !== "all") result.days = integer(result.days, 30, 1, 366);
  if (input.datasetId) {
    if (
      ![
        "legacy-sales",
        "document-files",
        "legacy-inventory",
        "legacy-production",
      ].includes(input.datasetId)
    )
      uuid(input.datasetId);
    result.datasetId = input.datasetId;
  }
  for (const key of ["metricKey", "dateKey", "groupKey"])
    if (input[key]) {
      if (!/^(c\d{1,3}|none|count)$/.test(input[key]))
        throw new AppError(
          422,
          "INVALID_COLUMN",
          "Kolom analisis tidak valid.",
        );
      result[key] = input[key];
    }
  return result;
}
function virtualSales(snapshot) {
  const headers = [
    "ID pesanan",
    "Tanggal",
    "SKU",
    "Produk",
    "Jumlah",
    "Total",
    "Kanal",
  ];
  const rows = snapshot.orders.map((o, index) => ({
    line: o.row || index + 2,
    values: [o.id, o.date, o.sku, o.product, o.quantity, o.total, o.channel],
  }));
  return {
    id: "legacy-sales",
    name: "Transaksi terverifikasi",
    label: "Transaksi terverifikasi",
    domain: "sales",
    headers,
    rows,
    columns: inferColumns(headers, rows),
    row_count: rows.length,
    part_name: "",
  };
}
export async function adaptiveFor(owner, repository, snapshot, input = {}) {
  const selection = adaptiveSelection(input);
  const datasets = [...(snapshot.datasets || [])];
  let virtual;
  if (!datasets.length && snapshot.orders.length) {
    virtual = virtualSales(snapshot);
    datasets.push({ ...virtual, rows: undefined });
  }

  const score = (dataset) =>
    (dataset.columns?.some((c) => c.role === "money") ? 20 : 0) +
    (dataset.columns?.some((c) => c.role === "entity") ? 5 : 0) +
    (dataset.columns?.some((c) => c.role === "date") ? 3 : 0) +
    Math.log2((dataset.row_count || 0) + 1);
  if (!datasets.length && snapshot.files.length) {
    const headers = ["Dokumen", "Format", "Halaman", "Status"];
    const rows = snapshot.files.map((f, index) => ({
      line: index + 1,
      values: [f.name, f.type, f.pages || 0, f.status],
    }));
    virtual = {
      id: "document-files",
      name: "Dokumen bisnis",
      label: "Dokumen bisnis",
      domain: "documents",
      headers,
      rows,
      columns: inferColumns(headers, rows),
      row_count: rows.length,
      part_name: "",
    };
    datasets.push({ ...virtual, rows: undefined });
  }
  if (!datasets.length) {
    if (selection.datasetId)
      throw new AppError(
        404,
        "DATASET_NOT_FOUND",
        "Sumber analisis tidak ditemukan.",
      );
    return { datasets: [], model: null };
  }
  const chosen = selection.datasetId
    ? datasets.find((d) => d.id === selection.datasetId)
    : [...datasets].sort((a, b) => score(b) - score(a))[0];
  if (!chosen)
    throw new AppError(
      404,
      "DATASET_NOT_FOUND",
      "Sumber analisis tidak ditemukan.",
    );
  const data =
    virtual && chosen.id === virtual.id
      ? virtual
      : await repository.call(owner, "dataset_get", { id: chosen.id });
  for (const key of ["metricKey", "dateKey", "groupKey"])
    if (
      selection[key] &&
      !["none", "count"].includes(selection[key]) &&
      !data.columns.some((c) => c.key === selection[key])
    )
      throw new AppError(
        422,
        "INVALID_COLUMN",
        "Kolom tidak tersedia pada sumber ini.",
      );
  const model = buildAdaptiveModel(data, selection);
  for (const key of ["metricKey", "dateKey", "groupKey"]) {
    if (selection[key] && model.selection[key] !== selection[key])
      throw new AppError(
        422,
        "INVALID_COLUMN",
        "Kolom tidak sesuai untuk jenis analisis ini.",
      );
  }
  if (data.domain === "documents") {
    model.context = "Dokumen bisnis";
    for (const kpi of model.kpis)
      if (kpi.label === "Baris data") kpi.label = "Dokumen";
  }
  for (const finding of model.findings)
    finding.fingerprint = await sha256(
      JSON.stringify([data.id, finding.id, finding.evidence]),
    );
  return { datasets: datasets.map(({ rows, ...d }) => d), model };
}
