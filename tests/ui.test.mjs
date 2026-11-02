import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { createAdaptiveDashboard } from "../web/dashboard.js";
import { createUploadManager } from "../web/uploads.js";
import * as data from "../web/data.js";

const source = fs
  .readFileSync(new URL("../web/app.js", import.meta.url), "utf8")
  .replace(
    /^import[^\n]+\n/,
    "const {products:seedProducts,production:seedProduction,initialFiles,seedOrders,parseCSV,detectMapping,normalizeRows,upsertOrders,metricSummary}=window.fixture;\n",
  )
  .replace(/^import[^\n]+\n/m, "const apiRequest=window.apiRequest;\n")
  .replace(
    /^import[^\n]+\n/m,
    "const createUploadManager=window.createUploadManager;\n",
  )
  .replace(
    /^import[^\n]+\n/m,
    "const createAdaptiveDashboard=window.createAdaptiveDashboard;\n",
  );
function setup() {
  const dom = new JSDOM(
    '<div id="app"></div><div id="overlay-root"></div><div id="toast-root"></div>',
    {
      url: "https://laras.test/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  w.fixture = data;
  w.createUploadManager = createUploadManager;
  w.createAdaptiveDashboard = createAdaptiveDashboard;
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.URL.createObjectURL = () => "blob:test";
  w.URL.revokeObjectURL = () => {};
  w.eval(source);
  return dom;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("Navigation did not complete");
    await tick();
  }
}
function click(w, selector) {
  const el = w.document.querySelector(selector);
  assert.ok(el, selector + " exists");
  el.click();
}
async function route(w, name) {
  w.location.hash = name;
  await tick();
}
async function sampleImport(w) {
  click(w, '[data-action="upload"]');
  click(w, '[data-action="use-sample"]');
  assert.equal(w.document.querySelector("#upload-next").disabled, false);
  click(w, '[data-action="upload-next"]');
  assert.equal(w.document.querySelector("#upload-next").disabled, true);
  click(w, "#approve-import");
  click(w, '[data-action="import-confirm"]');
  await tick();
}

test("all workspace pages render and chart controls change metric", async () => {
  const dom = setup();
  const w = dom.window;
  assert.match(w.document.querySelector("h1").textContent, /Ringkasan/);
  click(w, '[data-chart="orders"]');
  assert.match(
    w.document.querySelector(".chart-legend").textContent,
    /Pesanan unik/,
  );
  for (const page of [
    "sales",
    "inventory",
    "production",
    "sources",
    "insights",
    "chat",
    "settings",
    "overview",
  ]) {
    await route(w, page);
    assert.ok(w.document.querySelector("main h1"), page);
    assert.equal(
      w.document.querySelectorAll(".nav-link.active").length,
      page === "settings" ? 0 : 1,
    );
  }
  dom.window.close();
});

test("review blocks invalid mapping and Escape closes the dialog", () => {
  const dom = setup();
  const w = dom.window;
  click(w, '[data-action="upload"]');
  click(w, '[data-action="use-sample"]');
  const mapping = w.document.querySelector('[data-map="date"]');
  mapping.value = "";
  mapping.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.equal(w.document.querySelector("#upload-next").disabled, true);
  assert.match(
    w.document.querySelector("#validation-summary").textContent,
    /belum valid/,
  );
  w.document.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(w.document.querySelector('[role="dialog"]'), null);
  assert.equal(w.localStorage.getItem("laras-demo-v1"), null);
  dom.window.close();
});

test("CSV import, repeat upload, and versioned rollback preserve correct records", async () => {
  const dom = setup();
  const w = dom.window;
  const original = data.metricSummary(data.seedOrders()).revenue;
  await sampleImport(w);
  let persisted = JSON.parse(w.localStorage.getItem("laras-demo-v1"));
  assert.equal(persisted.orders.length, 131);
  assert.equal(persisted.history[0].added, 5);
  assert.equal(
    data.metricSummary(persisted.orders).revenue,
    original + 3747000,
  );
  await sampleImport(w);
  persisted = JSON.parse(w.localStorage.getItem("laras-demo-v1"));
  assert.equal(persisted.orders.length, 131);
  assert.equal(persisted.history[1].unchanged, 5);
  assert.equal(persisted.files.filter((f) => f.type === "CSV").length, 2);
  await route(w, "sources");
  click(w, '[data-action="rollback"]');
  click(w, '[data-action="confirm-rollback"]');
  persisted = JSON.parse(w.localStorage.getItem("laras-demo-v1"));
  assert.equal(persisted.orders.length, 131);
  assert.equal(persisted.history[1].rolledBack, true);
  click(w, '[data-action="rollback"]');
  click(w, '[data-action="confirm-rollback"]');
  persisted = JSON.parse(w.localStorage.getItem("laras-demo-v1"));
  assert.equal(persisted.orders.length, 126);
  assert.equal(data.metricSummary(persisted.orders).revenue, original);
  assert.equal(persisted.history.length, 2);
  dom.window.close();
});

test("questions cite deterministic sources, insight review persists, and search navigates", async () => {
  const dom = setup();
  const w = dom.window;
  await route(w, "chat");
  click(w, '[data-question="Stok perlu diisi?"]');
  assert.match(
    w.document.querySelector(".answer-content").textContent,
    /Kemeja Senja/,
  );
  assert.match(
    w.document.querySelector(".answer-source").textContent,
    /stok_gudang_utama/,
  );
  await route(w, "insights");
  click(w, '[data-action="resolve"]');
  assert.equal(
    JSON.parse(w.localStorage.getItem("laras-demo-v1")).resolved.length,
    1,
  );
  click(w, '[data-action="search"]');
  const input = w.document.querySelector("#global-search");
  input.value = "persediaan";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  click(w, '[data-search-go="inventory"]');
  await tick();
  assert.match(w.document.querySelector("h1").textContent, /Persediaan/);
  dom.window.close();
});

test("four main destinations preserve dashboard domain views and expose Chat with Data", async () => {
  const dom = setup();
  const w = dom.window;
  const labels = [
    ...w.document.querySelectorAll(
      ".primary-navigation .nav-link>span:first-of-type",
    ),
  ].map((e) => e.textContent);
  assert.deepEqual(labels, [
    "Dashboard",
    "Proaktif",
    "Chat with Data",
    "Sumber Data",
  ]);
  assert.equal(
    w.document.querySelector('.primary-navigation a[href="#sales"]'),
    null,
  );
  for (const page of ["sales", "inventory", "production"]) {
    await route(w, page);
    assert.equal(
      w.document
        .querySelector(".primary-navigation .active")
        .getAttribute("href"),
      "#overview",
    );
    assert.equal(
      w.document
        .querySelector('.dashboard-tabs [aria-current="page"]')
        .getAttribute("href"),
      "#" + page,
    );
  }
  click(w, '.primary-navigation a[href="#chat"]');
  await waitFor(
    () => w.document.querySelector("h1")?.textContent === "Chat with Data",
  );
  assert.equal(w.document.querySelector("h1").textContent, "Chat with Data");
  assert.ok(w.document.querySelector("textarea#chat-input"));
  assert.equal(
    w.document.querySelectorAll(".chat-context-panel .chat-source").length,
    3,
  );
  dom.window.close();
});

test("proactive priorities precede KPIs and reviewed findings remain accessible", async () => {
  const dom = setup();
  const w = dom.window;
  const brief = w.document.querySelector(".priority-brief"),
    kpis = w.document.querySelector(".kpi-grid");
  assert.ok(
    brief.compareDocumentPosition(kpis) & w.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(brief.querySelectorAll(".priority-card").length, 3);
  await route(w, "insights");
  for (let i = 0; i < 3; i++) click(w, '[data-action="resolve"]');
  assert.match(
    w.document.querySelector(".proactive-list").textContent,
    /Semua temuan sudah ditinjau/,
  );
  assert.equal(
    w.document.querySelector('.primary-navigation a[href="#insights"] .count')
      .textContent,
    "0",
  );
  click(w, '[data-insight-filter="all"]');
  assert.equal(
    w.document.querySelectorAll(".proactive-card.resolved").length,
    3,
  );
  await route(w, "overview");
  assert.equal(w.document.querySelectorAll(".priority-card").length, 0);
  assert.match(
    w.document.querySelector(".priority-brief").textContent,
    /Semua temuan sudah ditinjau/,
  );
  dom.window.close();
});

test("a proactive finding opens a contextual conversation and its evidence route", async () => {
  const dom = setup();
  const w = dom.window;
  click(w, '.priority-card[data-priority="stock"] [data-insight-chat="stock"]');
  await tick();
  assert.equal(w.location.hash, "#chat");
  assert.match(
    w.document.querySelector(".chat-insight-context").textContent,
    /Dua produk di bawah stok minimum/,
  );
  assert.match(
    w.document.querySelector(".message-user").textContent,
    /Stok perlu diisi/,
  );
  assert.match(
    w.document.querySelector(".answer-content").textContent,
    /Kemeja Senja/,
  );
  assert.match(
    w.document.querySelector(".answer-source").textContent,
    /stok_gudang_utama.xlsx/,
  );
  click(w, '.answer-source [data-go="inventory"]');
  await tick();
  assert.match(w.document.querySelector("h1").textContent, /Persediaan/);
  dom.window.close();
});

test("typed chat supports Enter, new conversations, and document review evidence", async () => {
  const dom = setup();
  const w = dom.window;
  await route(w, "chat");
  let input = w.document.querySelector("#chat-input");
  input.value = "Berapa penjualan pada periode ini?";
  input.dispatchEvent(
    new w.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(w.document.querySelectorAll(".message-pair").length, 1);
  assert.match(w.document.querySelector(".answer-content").textContent, /Rp/);
  input = w.document.querySelector("#chat-input");
  input.value = "Dokumen apa yang perlu direview?";
  w.document
    .querySelector("#chat-form")
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(w.document.querySelectorAll(".message-pair").length, 2);
  assert.match(
    w.document.querySelectorAll(".answer-content")[1].textContent,
    /invoice_vendor_oktober.pdf/,
  );
  assert.match(
    w.document.querySelectorAll(".answer-source")[1].textContent,
    /status perlu ditinjau/,
  );
  click(w, '[data-action="new-chat"]');
  assert.equal(w.document.querySelectorAll(".message-pair").length, 0);
  assert.ok(w.document.querySelector(".question-grid"));
  assert.equal(w.document.activeElement.id, "chat-input");
  dom.window.close();
});

test("dashboard channel breakdown follows period filters and its question opens data chat", async () => {
  const dom = setup();
  const w = dom.window;
  const bars = [...w.document.querySelectorAll(".channel-bar>span")];
  assert.equal(bars.length, 3);
  assert.ok(
    Math.abs(
      bars.reduce((sum, b) => sum + parseFloat(b.style.width), 0) - 100,
    ) < 0.01,
  );
  const period = w.document.querySelector("#period");
  period.value = "7";
  period.dispatchEvent(new w.Event("change", { bubbles: true }));
  const expected = data.metricSummary(
    data.seedOrders().filter((r) => r.date >= "2026-10-15"),
  ).revenue;
  assert.equal(
    w.document.querySelector(".kpi-value").title,
    new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    })
      .format(expected)
      .replace("Rp ", "Rp "),
  );
  w.document.querySelector("#dashboard-question").value =
    "Berapa penjualan pada periode ini?";
  w.document
    .querySelector("#dashboard-question-form")
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(
    () => w.document.querySelector("h1")?.textContent === "Chat with Data",
  );
  assert.match(
    w.document.querySelector(".message-user").textContent,
    /Berapa penjualan/,
  );
  assert.match(
    w.document.querySelector(".answer-content").textContent,
    /15 Okt/,
  );
  assert.match(
    w.document.querySelector(".answer-source").textContent,
    /berkas penjualan/,
  );
  dom.window.close();
});

test("demo mode explains setup steps and where data is stored", async () => {
  const dom = setup();
  const w = dom.window;
  const guide = w.document.querySelector(".setup-guide");
  assert.ok(guide, "setup guide is visible in demo mode");
  assert.match(guide.textContent, /data contoh/);
  assert.match(guide.querySelector(".setup-progress").textContent, /0\/3/);
  assert.ok(guide.querySelector('[data-action="cloud-connect"]'));
  click(w, '.setup-guide [data-action="data-location"]');
  const dialog = w.document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Supabase/);
  assert.match(dialog.textContent, /\.laras\//);
  click(w, '[data-action="close-modal"]');
  await route(w, "settings");
  assert.match(w.document.querySelector("main").textContent, /Lokasi data/);
  dom.window.close();
});
