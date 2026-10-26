import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import * as fixture from "../web/data.js";
import {
  inferColumns,
  buildAdaptiveModel,
  demoDatasets,
  adaptiveReply,
} from "../web/adaptive.js";
import { createAdaptiveDashboard } from "../web/dashboard.js";
import { createUploadManager } from "../web/uploads.js";
function data(headers, values) {
  const rows = values.map((values, index) => ({ line: index + 2, values }));
  return {
    id: "fixture",
    name: "data.csv",
    domain: "dataset",
    columns: inferColumns(headers, rows),
    rows,
  };
}

test("metrics follow uploaded columns across projects, staff, and reservations", () => {
  const examples = demoDatasets();
  const project = buildAdaptiveModel(examples[0]);
  assert.equal(project.context, "Proyek dan layanan");
  assert.equal(project.kpis[0].value, 91000000);
  assert.ok(project.kpis.some((k) => k.label === "Klien" && k.value === 3));
  assert.doesNotMatch(JSON.stringify(project.kpis), /Stok|Pesanan|kanal/);
  const staff = buildAdaptiveModel(examples[1]);
  assert.equal(staff.context, "Tim dan operasional");
  assert.ok(
    staff.kpis.some((k) => /Biaya/.test(k.label) && k.value === 6300000),
  );
  assert.ok(staff.kpis.some((k) => /Jam/.test(k.label) && k.value === 95));
  const hotel = buildAdaptiveModel(examples[2]);
  assert.equal(hotel.context, "Reservasi dan akomodasi");
  assert.ok(hotel.kpis.some((k) => k.label === "Booking" && k.value === 3));
  assert.equal(hotel.kpis[0].value, 6600000);
});

test("numeric identifiers are not summed and chart types follow available data", () => {
  const dataset = data(
    ["EmployeeID", "Nama", "Departemen", "Gaji"],
    [
      ["001", "A", "Operasi", 4000000],
      ["002", "B", "Admin", 5000000],
    ],
  );
  const model = buildAdaptiveModel(dataset);
  assert.ok(!model.options.metrics.some((c) => c.label === "Employee ID"));
  assert.equal(model.kpis[0].value, 9000000);
  assert.equal(model.trend.points.length, 0);
  assert.ok(model.breakdown.items.length);
  const text = buildAdaptiveModel(
    data(
      ["Kategori", "Status"],
      [
        ["A", "Selesai"],
        ["B", "Berjalan"],
      ],
    ),
  );
  assert.ok(text.kpis.every((k) => k.format !== "currency"));
  assert.equal(text.trend.points.length, 0);
  assert.equal(text.kpis[0].value, 2);
});

test("metric choices, date ranges, and answer facts remain tied to the selected dataset", () => {
  const dataset = demoDatasets()[0];
  const defaultModel = buildAdaptiveModel(dataset);
  const hours = defaultModel.options.metrics.find(
    (c) => c.label === "Jam kerja",
  );
  const changed = buildAdaptiveModel(dataset, {
    metricKey: hours.key,
    days: 7,
  });
  assert.equal(changed.kpis[0].value, 36);
  assert.equal(changed.table.total, 1);
  assert.match(changed.trend.title, /Jam kerja/);
  const answer = adaptiveReply(defaultModel, "Berapa rata-rata nilai kontrak?");
  assert.equal(answer.title, "Rata-rata Nilai kontrak");
  assert.match(answer.lines[0], /30.333.333/);
  assert.equal(answer.route, "records");
  assert.equal(answer.sources[0].name, dataset.name);
});

test("invalid dates are reported without discarding original data", () => {
  const dataset = data(
    ["Tanggal", "Nilai"],
    Array.from({ length: 10 }, (_, i) => [
      i === 9 ? "bukan tanggal" : `2026-10-${String(i + 1).padStart(2, "0")}`,
      100,
    ]),
  );
  const model = buildAdaptiveModel(dataset);
  assert.equal(model.table.total, 10);
  assert.equal(model.trend.points.length, 9);
  assert.ok(model.findings.some((f) => /tanggal valid/.test(f.title)));
  assert.equal(model.table.rows[9].values[0], "bukan tanggal");
});

test("connected demo presents a neutral workspace and switches its metrics without commerce menus", async () => {
  const dom = new JSDOM(
    '<div id="app"></div><div id="overlay-root"></div><div id="toast-root"></div>',
    {
      url: "https://laras.test",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  w.fixture = fixture;
  w.createAdaptiveDashboard = createAdaptiveDashboard;
  w.createUploadManager = createUploadManager;
  w.fetch = async () => {};
  w.apiRequest = async () => ({
    backend: true,
    database: false,
    ai: false,
    cloud: { configured: false },
  });
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const source =
    "const {products:seedProducts,production:seedProduction,initialFiles,seedOrders,parseCSV,detectMapping,normalizeRows,upsertOrders,metricSummary}=window.fixture;const apiRequest=window.apiRequest;const createUploadManager=window.createUploadManager;const createAdaptiveDashboard=window.createAdaptiveDashboard;\n" +
    fs.readFileSync("web/app.js", "utf8").replace(/^import[^\n]+\n/gm, "");
  const wait = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail("Adaptive DOM timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    w.eval(source);
    await wait(
      () =>
        w.document.querySelector("h1")?.textContent === "Proyek dan layanan",
    );
    assert.doesNotMatch(
      w.document.querySelector(".dashboard-tabs").textContent,
      /Penjualan|Persediaan|Produksi/,
    );
    assert.match(w.document.querySelector(".kpi-grid").textContent, /Klien/);
    assert.doesNotMatch(
      w.document.querySelector(".kpi-grid").textContent,
      /Stok|Pesanan/,
    );
    let sourceControl = w.document.querySelector("#adaptive-source");
    sourceControl.value = "demo-staff";
    sourceControl.dispatchEvent(new w.Event("change", { bubbles: true }));
    await wait(
      () =>
        w.document.querySelector("h1")?.textContent === "Tim dan operasional",
    );
    assert.match(
      w.document.querySelector(".kpi-grid").textContent,
      /Biaya operasional/,
    );
    sourceControl = w.document.querySelector("#adaptive-source");
    sourceControl.value = "demo-reservations";
    sourceControl.dispatchEvent(new w.Event("change", { bubbles: true }));
    await wait(
      () =>
        w.document.querySelector("h1")?.textContent ===
        "Reservasi dan akomodasi",
    );
    assert.match(w.document.querySelector(".kpi-grid").textContent, /Booking/);
  } finally {
    w.close();
  }
});

test("non-financial scores and quantities do not inherit currency formatting", () => {
  const exams = buildAdaptiveModel(
    data(
      ["Siswa", "Nilai ujian", "Tahun"],
      [
        ["A", 80, 2026],
        ["B", 90, 2026],
      ],
    ),
  );
  assert.equal(exams.kpis[0].value, 85);
  assert.equal(exams.kpis[0].format, "number");
  assert.match(exams.kpis[0].label, /Rata-rata/);
  assert.ok(!exams.options.metrics.some((c) => c.label === "Tahun"));
  const hours = buildAdaptiveModel(
    data(
      ["Tim", "Total jam"],
      [
        ["A", 10],
        ["B", 12],
      ],
    ),
  );
  assert.equal(hours.kpis[0].value, 22);
  assert.equal(hours.kpis[0].format, "number");
  assert.doesNotMatch(hours.kpis[0].label, /Total Total/);
  const units = buildAdaptiveModel(
    data(
      ["Produk", "Quantity total"],
      [
        ["A", 5],
        ["B", 3],
      ],
    ),
  );
  assert.equal(units.kpis[0].value, 8);
  assert.equal(units.kpis[0].format, "number");
});
