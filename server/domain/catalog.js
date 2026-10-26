import { AppError, text, integer } from "../http.js";

function catalogInteger(
  value,
  fallback,
  min,
  max,
  field,
  code = "INVALID_QUANTITY",
) {
  let result;
  try {
    result = integer(value === "" ? undefined : value, fallback, min, max);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    throw new AppError(
      422,
      code,
      `${field} harus berupa bilangan bulat antara ${min.toLocaleString("id-ID")} dan ${max.toLocaleString("id-ID")}.`,
      { field },
    );
  }
  if (result === null)
    throw new AppError(
      422,
      code,
      `${field} wajib diisi dengan bilangan bulat.`,
      { field },
    );
  return result;
}

export function validateCatalog(body, domain) {
  if (
    !Array.isArray(body.rows) ||
    body.rows.length < 1 ||
    body.rows.length > 500
  )
    throw new AppError(422, "ROW_LIMIT", "Sertakan 1–500 baris data.");
  if (body.revision === undefined || body.revision === null)
    throw new AppError(422, "REVISION_REQUIRED", "Versi data diperlukan.");
  const revision = catalogInteger(
    body.revision,
    null,
    0,
    Number.MAX_SAFE_INTEGER,
    "Versi data",
    "INVALID_REVISION",
  );
  const keys = new Set();
  const rows = body.rows.map((row) => {
    if (!row || typeof row !== "object")
      throw new AppError(422, "INVALID_ROW", "Baris data tidak valid.");
    const base = {
      name: text(row.name, "Nama", 200),
      variant: row.variant ? text(row.variant, "Varian", 200) : "",
      source: row.source ? text(row.source, "Sumber", 200) : "API",
    };
    const key = text(domain === "inventory" ? row.sku : row.id, "ID", 100);
    if (keys.has(key))
      throw new AppError(422, "DUPLICATE_KEY", "ID berulang dalam permintaan.");
    keys.add(key);
    if (domain === "inventory")
      return {
        ...base,
        sku: key,
        stock: catalogInteger(row.stock, null, 0, 1_000_000, "Stok"),
        minimum: catalogInteger(
          row.minimum,
          0,
          0,
          1_000_000,
          "Batas minimum stok",
        ),
        source_row: catalogInteger(
          row.source_row,
          0,
          0,
          100000,
          "Nomor baris sumber",
          "INVALID_SOURCE_ROW",
        ),
      };
    const qty = catalogInteger(row.qty, null, 1, 1_000_000, "Jumlah produksi");
    const completed = catalogInteger(
      row.completed,
      0,
      0,
      qty,
      "Jumlah selesai",
    );
    const target = text(row.target, "Tanggal target", 10);
    if (
      target.startsWith("0000-") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(target) ||
      !Number.isFinite(+new Date(target)) ||
      new Date(target).toISOString().slice(0, 10) !== target
    )
      throw new AppError(422, "INVALID_DATE", "Tanggal target tidak valid.");
    return {
      ...base,
      id: key,
      qty,
      completed,
      stage: catalogInteger(
        row.stage,
        0,
        0,
        3,
        "Tahap produksi",
        "INVALID_STAGE",
      ),
      target,
      supplier: text(row.supplier, "Pemasok", 200),
    };
  });
  return { domain, revision, rows };
}
