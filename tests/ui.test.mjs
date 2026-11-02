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
    "const {detectMapping,metricSummary}=window.fixture;\n",
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
function click(w, selector) {
  const el = w.document.querySelector(selector);
  assert.ok(el, selector + " exists");
  el.click();
}
async function route(w, name) {
  w.location.hash = name;
  await tick();
}
test("without data every page renders empty and nothing is stored in the browser", async () => {
  const dom = setup();
  const w = dom.window;
  assert.equal(w.document.querySelector("h1").textContent, "Ringkasan data");
  assert.match(
    w.document.querySelector("main").textContent,
    /Dashboard mengikuti data Anda/,
  );
  assert.equal(w.document.querySelector(".kpi-grid"), null);
  assert.match(
    w.document.querySelector(".sidebar-status").textContent,
    /Belum terhubung/,
  );
  for (const page of [
    "records",
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
    assert.doesNotMatch(
      w.document.querySelector("main").textContent,
      /Nusa Studio|Kemeja Senja|data contoh|Data contoh/,
      page,
    );
  }
  await route(w, "sources");
  assert.match(
    w.document.querySelector("main").textContent,
    /0 berkas/,
  );
  await route(w, "insights");
  assert.match(
    w.document.querySelector("main").textContent,
    /0 temuan/,
  );
  assert.equal(w.localStorage.length, 0);
  dom.window.close();
});

test("navigation keeps the four main destinations and search navigates", async () => {
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
  click(w, '[data-action="search"]');
  const input = w.document.querySelector("#global-search");
  input.value = "sumber";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  click(w, '[data-search-go="sources"]');
  await tick();
  assert.match(w.document.querySelector("h1").textContent, /Sumber Data/);
  dom.window.close();
});

test("chat without data explains what is needed instead of inventing numbers", async () => {
  const dom = setup();
  const w = dom.window;
  await route(w, "chat");
  assert.equal(
    w.document.querySelectorAll(".chat-context-panel .chat-source").length,
    0,
  );
  const input = w.document.querySelector("#chat-input");
  input.value = "Total penjualan?";
  input.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await tick();
  const answer = w.document.querySelector(".answer-content").textContent;
  assert.match(answer, /Belum ada data/);
  assert.doesNotMatch(answer, /Rp|\d{3}\.\d{3}/);
  click(w, '[data-action="new-chat"]');
  assert.equal(w.document.querySelector(".message-pair"), null);
  dom.window.close();
});

test("empty dashboard explains setup steps and where data is stored", async () => {
  const dom = setup();
  const w = dom.window;
  const guide = w.document.querySelector(".setup-guide");
  assert.ok(guide, "setup guide is visible without data");
  assert.match(guide.textContent, /Belum ada data bisnis/);
  assert.match(guide.querySelector(".setup-progress").textContent, /0\/3/);
  assert.ok(guide.querySelector('[data-action="cloud-connect"]'));
  click(w, '.setup-guide [data-action="data-location"]');
  const dialog = w.document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Supabase/);
  assert.match(dialog.textContent, /\.laras\//);
  click(w, '[data-action="close-modal"]');
  click(w, '[data-action="about"]');
  assert.match(
    w.document.querySelector('[role="dialog"]').textContent,
    /Belum ada data/,
  );
  click(w, '[data-action="close-modal"]');
  await route(w, "settings");
  assert.match(w.document.querySelector("main").textContent, /Lokasi data/);
  assert.equal(w.document.querySelector('[data-action="reset-demo"]'), null);
  dom.window.close();
});
