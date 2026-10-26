import test from "node:test";
import assert from "node:assert/strict";
import { validateCatalog } from "../server/domain/catalog.js";
import {
  extractDocument,
  prepareDocumentBatch,
  documentSummary,
} from "../server/domain/documents.js";
import { catalogMapping } from "../web/document-fields.js";

async function staged(csv, name = "08_produk.csv") {
  return {
    ...(await extractDocument({
      name,
      base64: Buffer.from(csv).toString("base64"),
    })),
    id: crypto.randomUUID(),
    status: "staged",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}

test("previously staged products refresh their automatic threshold mapping while explicit mappings are respected", async () => {
  const document = await staged(
    "sku,nama_produk,stok,stok_min\nA-1,Kopi,120,25",
  );
  const table = document.content.tables[0];
  table.mapping.minimum = ""; // Older staged metadata did not recognize this alias.
  assert.equal(documentSummary(document).tables[0].mapping.minimum, "3");
  const fresh = await prepareDocumentBatch([{ id: document.id }], [document]);
  assert.equal(fresh.catalog.inventory[0].minimum, 25);
  const unmapped = await prepareDocumentBatch(
    [
      {
        id: document.id,
        tables: [{ id: table.id, mapping: { ...table.mapping, minimum: "" } }],
      },
    ],
    [document],
  );
  assert.equal(unmapped.catalog.inventory[0].minimum, 0);
});

test("product catalogs without reorder thresholds can be reviewed without an analysis-period error", async () => {
  for (const csv of [
    "sku,nama_produk,stok,harga_jual\nA-1,Kopi,120,25000",
    "sku,nama_produk,stok,stok_minimum\nA-1,Kopi,120,",
    "sku,nama_produk,stok,stok_minimum\nA-1,Kopi,120,0",
  ]) {
    const document = await staged(csv);
    assert.equal(document.content.tables[0].domain, "inventory");
    const result = await prepareDocumentBatch(
      [{ id: document.id }],
      [document],
    );
    assert.equal(result.catalog.inventory[0].stock, 120);
    assert.equal(result.catalog.inventory[0].minimum, 0);
    assert.equal(result.catalog.inventory[0].source_row, 2);
    assert.equal(
      result.datasets[0].columns.length,
      document.content.tables[0].headers.length,
    );
  }
});

test("common reorder threshold headers preserve the supplied values and locale numbers remain exact", async () => {
  for (const header of [
    "stok_min",
    "min_stock",
    "minimum_stock",
    "reorder_point",
    "reorder_level",
  ]) {
    assert.equal(
      catalogMapping(["sku", "stok", header], "inventory").minimum,
      "2",
    );
    const document = await staged(
      `sku;nama_produk;stok;${header}\nA-1;Kopi;1.200;125`,
    );
    const result = await prepareDocumentBatch(
      [{ id: document.id }],
      [document],
    );
    assert.equal(result.catalog.inventory[0].stock, 1200);
    assert.equal(result.catalog.inventory[0].minimum, 125);
  }
});

test("invalid product values identify the file, actual source row, and stock or threshold field", async () => {
  for (const [stock, minimum, field] of [
    ["abc", "5", "Stok"],
    ["-2", "5", "Stok"],
    ["1.5", "5", "Stok"],
    ["20", "abc", "Batas minimum stok"],
    ["20", "-1", "Batas minimum stok"],
  ]) {
    const document = await staged(
      `sku,nama_produk,stok,minimum\nA-1,Kopi,${stock},${minimum}`,
    );
    await assert.rejects(
      prepareDocumentBatch([{ id: document.id }], [document]),
      (error) => {
        assert.equal(error.code, "VALIDATION_FAILED");
        assert.match(error.message, /08_produk.csv · Data · baris 2:/);
        assert.ok(error.message.includes(field));
        assert.doesNotMatch(error.message, /Periode analisis/);
        assert.equal(error.details.field, field);
        assert.equal(error.details.row, 2);
        assert.equal(error.details.documentId, document.id);
        return true;
      },
    );
  }
});

test("catalog API errors distinguish missing stock, revision, completed quantity, and production stage", () => {
  const product = { sku: "A-1", name: "Kopi", stock: 120 };
  assert.equal(
    validateCatalog({ revision: 0, rows: [product] }, "inventory").rows[0]
      .minimum,
    0,
  );
  assert.throws(
    () => validateCatalog({ revision: "bad", rows: [product] }, "inventory"),
    (e) => e.code === "INVALID_REVISION" && !e.message.includes("Periode"),
  );
  assert.throws(
    () =>
      validateCatalog(
        { revision: 0, rows: [{ ...product, stock: null }] },
        "inventory",
      ),
    (e) => e.details.field === "Stok",
  );
  const production = {
    id: "P-1",
    name: "Kopi",
    qty: 10,
    target: "2026-10-26",
    supplier: "Vendor",
  };
  assert.throws(
    () =>
      validateCatalog(
        { revision: 0, rows: [{ ...production, completed: 11 }] },
        "production",
      ),
    (e) => e.details.field === "Jumlah selesai",
  );
  assert.throws(
    () =>
      validateCatalog(
        { revision: 0, rows: [{ ...production, stage: 4 }] },
        "production",
      ),
    (e) => e.code === "INVALID_STAGE",
  );
});
