import { parseCSV, detectMapping, normalizeRows } from "../../web/csv.js";
import { AppError, text, sha256 } from "../http.js";

const fields = new Set([
  "id",
  "date",
  "sku",
  "product",
  "quantity",
  "unit_price",
  "discount",
  "total",
  "status",
  "channel",
]);

export async function prepareImport(body) {
  const name = text(body.name, "Nama berkas", 160);
  if (!/\.csv$/i.test(name) || /[\/\\]/.test(name))
    throw new AppError(422, "CSV_REQUIRED", "Pilih berkas penjualan CSV.");
  if (
    typeof body.csv !== "string" ||
    new TextEncoder().encode(body.csv).byteLength > 2_000_000
  )
    throw new AppError(413, "FILE_TOO_LARGE", "Ukuran berkas maksimal 2 MB.");
  let parsed;
  try {
    parsed = parseCSV(body.csv);
  } catch (error) {
    throw new AppError(422, "CSV_INVALID", error.message);
  }
  if (parsed.rows.length > 5000)
    throw new AppError(422, "ROW_LIMIT", "Maksimal 5.000 baris per impor.");
  if (parsed.headers.length > 100)
    throw new AppError(422, "COLUMN_LIMIT", "Maksimal 100 kolom per berkas.");
  const mapping = body.mapping ?? detectMapping(parsed.headers);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
    throw new AppError(422, "MAPPING_INVALID", "Pemetaan kolom tidak valid.");
  for (const [field, index] of Object.entries(mapping)) {
    if (
      !fields.has(field) ||
      (index !== "" &&
        (!/^\d+$/.test(String(index)) ||
          Number(index) >= parsed.headers.length))
    )
      throw new AppError(422, "MAPPING_INVALID", "Pemetaan kolom tidak valid.");
  }
  const rows = normalizeRows(parsed, mapping, name);
  const keys = new Set();
  const errors = [];
  for (const row of rows) {
    const key = row.id + "\u0000" + row.sku;
    if (row.date.startsWith("0000-")) row.errors.push("Tahun tidak valid");
    if (keys.has(key))
      row.errors.push("Kombinasi ID pesanan dan SKU berulang dalam berkas");
    keys.add(key);
    for (const field of ["id", "sku", "product", "status", "channel"])
      if (
        String(row[field]).length > 200 ||
        /[\u0000-\u001f]/.test(String(row[field]))
      )
        row.errors.push(`Nilai ${field} tidak valid`);
    for (const field of ["unit_price", "total", "discount"])
      if (
        !Number.isFinite(row[field]) ||
        row[field] < 0 ||
        row[field] > 1e12 ||
        Math.abs(row[field] * 100 - Math.round(row[field] * 100)) > 0.001
      )
        row.errors.push(`Nilai ${field} tidak valid`);
    if (row.quantity > 1_000_000) row.errors.push("Jumlah melebihi batas");
    if (row.errors.length) errors.push({ row: row.row, errors: row.errors });
  }
  const hash = await sha256(JSON.stringify({ name, csv: body.csv, mapping }));
  return {
    name,
    hash,
    mapping,
    headers: parsed.headers,
    rows,
    errors,
    size: new TextEncoder().encode(body.csv).byteLength,
  };
}
