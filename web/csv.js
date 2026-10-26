export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const delimiter =
    (first.match(/;/g) || []).length > (first.match(/,/g) || []).length
      ? ";"
      : ",";
  const records = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell.trim() !== "")
        throw new Error("Format kutip CSV tidak valid.");
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) records.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("Terdapat tanda kutip CSV yang belum ditutup.");
  row.push(cell.trim());
  if (row.some(Boolean)) records.push(row);
  if (records.length < 2)
    throw new Error(
      "Berkas harus memuat nama kolom dan minimal satu baris data.",
    );
  const headers = records.shift();
  if (
    headers.some((h) => !h) ||
    new Set(headers.map((h) => h.toLowerCase())).size !== headers.length
  )
    throw new Error("Nama kolom harus terisi dan tidak boleh sama.");
  return {
    headers,
    rows: records.map((values, i) => ({ values, line: i + 2 })),
    delimiter,
  };
}

const aliases = {
  id: ["order_id", "id_pesanan", "no_pesanan", "nomor_pesanan", "id", "order"],
  date: ["date", "tanggal", "tanggal_pesanan"],
  sku: ["sku", "kode_barang", "kode_produk"],
  product: ["product", "produk", "nama_produk", "nama_barang"],
  quantity: ["quantity", "qty", "jumlah", "kuantitas"],
  unit_price: ["unit_price", "harga", "harga_satuan", "price"],
  discount: ["discount", "diskon"],
  total: [
    "total",
    "subtotal",
    "subtotal_valid",
    "total_penjualan",
    "nominal",
    "omzet",
  ],
  status: ["status"],
  channel: ["channel", "kanal", "platform"],
};
export function detectMapping(headers) {
  const result = {};
  for (const [key, names] of Object.entries(aliases)) {
    const idx = headers.findIndex((h) =>
      names.includes(h.toLowerCase().trim().replaceAll(" ", "_")),
    );
    result[key] = idx < 0 ? "" : String(idx);
  }
  return result;
}
export function parseNumber(value) {
  if (typeof value === "number") return value;
  let s = String(value ?? "").replace(/Rp|IDR|\s/gi, "");
  if (!s) return NaN;
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s))
    s = s.replaceAll(".", "").replace(",", ".");
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replaceAll(",", "");
  else if (s.includes(",")) s = s.replace(",", ".");
  return Number(s);
}
export function normalizeRows(parsed, mapping, fileName, catalog = []) {
  return parsed.rows.map(({ values, line }) => {
    const get = (key) =>
      mapping[key] !== "" && mapping[key] !== undefined
        ? (values[Number(mapping[key])] ?? "")
        : "";
    const quantity = parseNumber(get("quantity"));
    const price = parseNumber(get("unit_price"));
    const discount = get("discount") === "" ? 0 : parseNumber(get("discount"));
    const total =
      get("total") === ""
        ? quantity * price - discount
        : parseNumber(get("total"));
    let date = get("date");
    if (/^\d{2}[/-]\d{2}[/-]\d{4}$/.test(date)) {
      const [d, m, y] = date.split(/[/-]/);
      date = `${y}-${m}-${d}`;
    }
    const parsedDate = new Date(`${date}T00:00:00Z`);
    const errors = [];
    if (!get("id")) errors.push("ID pesanan kosong");
    if (!get("sku")) errors.push("SKU kosong");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(+parsedDate) ||
      parsedDate.toISOString().slice(0, 10) !== date
    )
      errors.push("Tanggal tidak valid");
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isInteger(quantity)
    )
      errors.push("Jumlah harus bilangan bulat positif");
    if (!Number.isFinite(total) || total < 0) errors.push("Total tidak valid");
    if (!Number.isFinite(discount) || discount < 0)
      errors.push("Diskon tidak valid");
    return {
      id: get("id"),
      date,
      sku: get("sku"),
      product:
        get("product") ||
        catalog.find((p) => p.sku === get("sku"))?.name ||
        get("sku"),
      quantity,
      unit_price: Number.isFinite(price)
        ? price
        : quantity
          ? total / quantity
          : 0,
      discount,
      total,
      status: get("status") || "Selesai",
      channel: get("channel") || "Import CSV",
      source: fileName,
      row: line,
      errors,
    };
  });
}
