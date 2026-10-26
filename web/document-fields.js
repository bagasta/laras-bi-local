export const domains = {
  dataset: { label: "Data bisnis (otomatis)", fields: {} },
  sales: {
    label: "Penjualan",
    fields: {
      id: "ID pesanan *",
      date: "Tanggal *",
      sku: "SKU *",
      product: "Produk",
      quantity: "Jumlah *",
      unit_price: "Harga satuan",
      discount: "Diskon",
      total: "Total",
      status: "Status",
      channel: "Kanal",
    },
  },
  inventory: {
    label: "Persediaan",
    fields: {
      sku: "SKU *",
      name: "Nama produk *",
      variant: "Varian",
      stock: "Stok *",
      minimum: "Batas minimum (opsional)",
    },
  },
  production: {
    label: "Produksi",
    fields: {
      id: "ID batch *",
      name: "Nama produk *",
      variant: "Varian",
      qty: "Jumlah *",
      completed: "Selesai",
      stage: "Tahap",
      target: "Target selesai *",
      supplier: "Pemasok *",
    },
  },
};
const aliases = {
  inventory: {
    sku: ["sku", "kode_produk", "kode_barang"],
    name: ["name", "product", "produk", "nama_produk", "nama_barang"],
    variant: ["variant", "varian"],
    stock: ["stock", "stok", "stok_tersedia", "saldo"],
    minimum: [
      "minimum",
      "min",
      "batas_minimum",
      "stok_minimum",
      "stok_min",
      "min_stok",
      "minimum_stok",
      "min_stock",
      "minimum_stock",
      "reorder_point",
      "reorder_level",
    ],
  },
  production: {
    id: ["batch_id", "id_batch", "id_produksi", "batch"],
    name: ["name", "product", "produk", "nama_produk"],
    variant: ["variant", "varian"],
    qty: ["qty", "quantity", "jumlah", "kuantitas"],
    completed: ["completed", "selesai", "jumlah_selesai"],
    stage: ["stage", "tahap", "progres"],
    target: ["target", "target_selesai", "target_date", "tanggal_target"],
    supplier: ["supplier", "pemasok", "vendor"],
  },
};
export function catalogMapping(headers, domain) {
  const result = {};
  for (const [field, names] of Object.entries(aliases[domain] || {})) {
    const index = headers.findIndex((h) =>
      names.includes(String(h).trim().toLowerCase().replaceAll(" ", "_")),
    );
    result[field] = index < 0 ? "" : String(index);
  }
  return result;
}
export function tableDomain(headers) {
  headers = headers.map((h) =>
    String(h).trim().toLowerCase().replaceAll(" ", "_"),
  );
  const inventory = catalogMapping(headers, "inventory"),
    production = catalogMapping(headers, "production");
  return inventory.stock !== "" && inventory.sku !== ""
    ? "inventory"
    : production.target !== "" && production.id !== ""
      ? "production"
      : headers.some((h) => /^(sku|kode_produk|kode_barang)$/i.test(h)) &&
          headers.some((h) => /^(order_id|id_pesanan|nomor_pesanan)$/i.test(h))
        ? "sales"
        : "dataset";
}
