import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import {
  extractDocument,
  prepareDocumentBatch,
} from "../server/domain/documents.js";
const zip = (files) =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  );
const extract = (name, bytes) =>
  extractDocument({ name, base64: Buffer.from(bytes).toString("base64") });
import { officeFixtures } from "./fixtures/office.mjs";

test("Word, presentation, plain text, and Markdown keep readable content and original bytes", async () => {
  const documents = [];
  for (const [name, bytes] of Object.entries(officeFixtures())) {
    const d = await extract(name, bytes);
    assert.equal(d.content.tables.length, 0);
    assert.ok(d.content.pages.every((p) => p.label && p.text.length));
    assert.deepEqual(Buffer.from(d.original, "base64"), Buffer.from(bytes));
    documents.push({
      ...d,
      id: crypto.randomUUID(),
      status: "staged",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });
  }
  assert.match(documents[0].content.pages[0].text, /escalation\nContact/);
  assert.equal(documents[1].content.pages[0].text, "First slide");
  assert.equal(documents[1].content.pages[1].label, "Slide 2");
  const batch = await prepareDocumentBatch(
    documents.map((d) => ({ id: d.id })),
    documents,
  );
  assert.equal(batch.documents.length, 4);
  assert.equal(batch.rows.length, 0);
  assert.equal(batch.datasets.length, 0);
});
test("namespaced spreadsheets preserve dates and recognize Order ID and Omzet columns", async () => {
  const bytes = zip({
    "xl/workbook.xml":
      '<x:workbook xmlns:x="urn:x" xmlns:r="urn:r"><x:sheets><x:sheet name="Transaksi" sheetId="1" r:id="r1"/></x:sheets></x:workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="r1" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
    "xl/styles.xml":
      '<x:styleSheet xmlns:x="urn:x"><x:cellXfs><x:xf numFmtId="0"/><x:xf numFmtId="14"/></x:cellXfs></x:styleSheet>',
    "xl/worksheets/sheet1.xml":
      '<x:worksheet xmlns:x="urn:x"><x:sheetData><x:row r="1">' +
      [
        "Order ID",
        "Tanggal",
        "SKU",
        "Jumlah",
        "Harga Satuan",
        "Omzet",
        "Status",
      ]
        .map((v) => `<x:c t="str"><x:v>${v}</x:v></x:c>`)
        .join("") +
      '</x:row><x:row r="2"><x:c t="str"><x:v>O-1</x:v></x:c><x:c s="1"><x:v>46320</x:v></x:c><x:c t="str"><x:v>P-1</x:v></x:c><x:c><x:v>1</x:v></x:c><x:c><x:v>22000</x:v></x:c><x:c><x:v>0</x:v></x:c><x:c t="str"><x:v>Dibatalkan</x:v></x:c></x:row></x:sheetData></x:worksheet>',
  });
  const d = {
    ...(await extract("data.xlsx", bytes)),
    id: crypto.randomUUID(),
    status: "staged",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  assert.equal(d.content.tables[0].domain, "sales");
  const result = await prepareDocumentBatch([{ id: d.id }], [d]);
  assert.equal(result.rows[0].total, 0);
  assert.match(result.rows[0].date, /^2026-/);
});
test("Office parsers reject external slide targets, XML entities, excessive slides, and binary text", async () => {
  const bad = zip({
    "word/document.xml":
      '<!DOCTYPE x [<!ENTITY x SYSTEM "https://example.invalid">]><w:document xmlns:w="urn:w">&x;</w:document>',
  });
  await assert.rejects(
    extract("bad.docx", bad),
    (e) => e.code === "XML_UNSUPPORTED",
  );
  await assert.rejects(
    extract("bad.txt", Buffer.from([0, 1, 2])),
    (e) => e.code === "TEXT_INVALID",
  );
  const slides = zip({
    "ppt/presentation.xml":
      '<presentation><sldIdLst><sldId r:id="r1"/></sldIdLst></presentation>',
    "ppt/_rels/presentation.xml.rels":
      '<Relationships><Relationship Id="r1" Target="https://example.invalid/slide.xml" TargetMode="External"/></Relationships>',
  });
  await assert.rejects(
    extract("bad.pptx", slides),
    (e) => e.code === "OFFICE_INVALID",
  );
  const many = zip({
    "ppt/presentation.xml":
      "<presentation><sldIdLst>" +
      Array.from({ length: 51 }, (_, i) => `<sldId r:id="r${i}"/>`).join("") +
      "</sldIdLst></presentation>",
    "ppt/_rels/presentation.xml.rels": "<Relationships/>",
  });
  await assert.rejects(
    extract("many.pptx", many),
    (e) => e.code === "SLIDE_LIMIT",
  );
});
