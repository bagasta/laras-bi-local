import test from "node:test";
import {officeFixtures} from "./fixtures/office.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { zipSync, strToU8 } from "fflate";
import {
  extractDocument,
  prepareDocumentBatch,
} from "../server/domain/documents.js";
import {
  ControlStore,
  sealToken,
  openToken,
  ownerEnvironment,
} from "../server/infrastructure/control.js";
import { advanceProvisioning } from "../server/services/cloud-setup.js";
import { createApp } from "../server/app.js";
import { AppError } from "../server/http.js";
import { rpcFor } from "../server/infrastructure/supabase.js";
const sql =
  fs.readFileSync("supabase/migrations/001_laras.sql", "utf8") +
  "\n" +
  fs.readFileSync("supabase/migrations/002_multi_documents.sql", "utf8") + "\n" + fs.readFileSync("supabase/migrations/003_office_documents.sql", "utf8");
const csv = (id = "A-1", amount = 200000) =>
  `order_id,date,sku,product,quantity,unit_price,total\n${id},2026-10-26,SKU-1,Kemeja,2,100000,${amount}`;
const base64 = (value) => Buffer.from(value).toString("base64");
function workbook() {
  const cells = (id, date) =>
    `<worksheet><sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>order_id</t></is></c><c r="B3" t="inlineStr"><is><t>date</t></is></c><c r="C3" t="inlineStr"><is><t>sku</t></is></c><c r="D3" t="inlineStr"><is><t>product</t></is></c><c r="E3" t="inlineStr"><is><t>quantity</t></is></c><c r="F3" t="inlineStr"><is><t>total</t></is></c></row><row r="7"><c r="A7" t="inlineStr"><is><t>${id}</t></is></c><c r="B7" t="d"><v>${date}</v></c><c r="C7" t="inlineStr"><is><t>SKU-2</t></is></c><c r="D7" t="inlineStr"><is><t>Celana</t></is></c><c r="E7"><v>1</v></c><c r="F7"><v>300000</v></c></row></sheetData></worksheet>`;
  return zipSync(
    Object.fromEntries(
      Object.entries({
        "xl/workbook.xml":
          '<workbook><sheets><sheet name="Oktober" sheetId="1" r:id="rId1"/><sheet name="November" sheetId="2" r:id="rId2"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels":
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": cells("X-1", "2026-10-26"),
        "xl/worksheets/sheet2.xml": cells("X-2", "2026-11-01"),
      }).map(([name, value]) => [name, strToU8(value)]),
    ),
  );
}
function pdf(text = "Invoice vendor October", pages = 1) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => 4 + i * 2 + " 0 R").join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(value);
  value +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(value);
}
function control() {
  const db = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync("drizzle").filter(f=>f.endsWith(".sql")).sort()) db.exec(fs.readFileSync("drizzle/"+file, "utf8"));
  function prepare(sql, params = []) {
    return {
      sql,
      params,
      bind(...values) {
        return prepare(sql, values);
      },
      async first() {
        return db.prepare(sql).get(...params) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  const adapter = {
    prepare,
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, adapter, store: new ControlStore(adapter) };
}
async function setup() {
  const db = new PGlite();
  await db.exec(sql);
  const repo = {
    async call(owner, action, payload = {}) {
      const result = (
        await db.query(`select public.${rpcFor(action)}($1,$2,$3::jsonb) r`, [
          owner,
          action,
          JSON.stringify(payload),
        ])
      ).rows[0].r;
      if (result.error)
        throw new AppError(
          result.error.status,
          result.error.code,
          result.error.message,
        );
      return result;
    },
  };
  const app = createApp({
    repositoryFactory: () => repo,
    migration: sql,
    logger: { error() {} },
  });
  async function call(
    path,
    method = "GET",
    body,
    owner = "a",
    key = crypto.randomUUID(),
  ) {
    const response = await app.fetch(
      new Request("https://laras.test/api" + path, {
        method,
        headers: {
          "oai-authenticated-user-id": owner,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      {
        SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "fixture",
      },
    );
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error.message);
      error.status = response.status;
      error.code = value.error.code;
      throw error;
    }
    return value.data;
  }
  const stage = (name, bytes, owner = "a", key) =>
    call(
      "/documents/extract",
      "POST",
      { name, base64: base64(bytes) },
      owner,
      key,
    );
  const preview = (documents) =>
    call("/uploads/preview", "POST", {
      documents: documents.map((d) => ({
        id: d.id,
        tables: d.tables.map((t) => ({
          id: t.id,
          mapping: t.mapping,
          include: true,
        })),
      })),
    });
  return { db, repo, app, call, stage, preview };
}

test("real XLSX with two worksheets preserves dates, headers, and original row provenance", async () => {
  const extracted = await extractDocument({
    name: "book.xlsx",
    base64: base64(workbook()),
  });
  assert.equal(extracted.content.tables.length, 2);
  assert.equal(extracted.content.tables[0].rows[0].line, 7);
  const id = crypto.randomUUID();
  const document = {
    ...extracted,
    id,
    status: "staged",
    expires_at: new Date(Date.now() + 10000).toISOString(),
  };
  const result = await prepareDocumentBatch([{ id }], [document]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].part, "Oktober");
  assert.equal(result.rows[0].row, 7);
  assert.equal(result.rows[1].date, "2026-11-01");
});

test("real PDF extraction keeps page references and rejects excessive pages and unsupported binaries", async () => {
  const extracted = await extractDocument({
    name: "invoice.pdf",
    base64: base64(pdf()),
  });
  assert.match(extracted.content.pages[0].text, /Invoice vendor/);
  assert.equal(extracted.content.pages[0].page, 1);
  assert.equal(extracted.content.tables.length, 0);
  await assert.rejects(
    extractDocument({ name: "invoice.pdf", base64: base64(pdf("text", 21)) }),
    (e) => e.code === "PAGE_LIMIT",
  );
  await assert.rejects(
    extractDocument({ name: "bad.xlsx", base64: base64("not a zip") }),
    (e) => e.code === "EXTRACTION_FAILED",
  );
  await assert.rejects(
    extractDocument({ name: "archive.exe", base64: base64("hello") }),
    (e) => e.code === "FORMAT_UNSUPPORTED",
  );
});

test("mixed multi-document approval atomically stores CSV, all Excel sheets, PDF text, and originals", async () => {
  const t = await setup();
  try {
    const excelBytes = workbook();
    const docs = [
      await t.stage("sales.csv", csv()),
      await t.stage("workbook.xlsx", excelBytes),
      await t.stage("invoice.pdf", pdf()),
    ];
    const batch = await t.preview(docs);
    assert.equal(batch.added, 3);
    let workspace = await t.call("/workspace");
    assert.equal(workspace.orders.length, 0);
    assert.equal(workspace.files.length, 0);
    const result = await t.call(`/uploads/${batch.id}/commit`, "POST", {
      approved: true,
    });
    assert.equal(result.added, 3);
    assert.deepEqual(
      await t.call(`/uploads/${batch.id}/commit`, "POST", { approved: true }),
      result,
    );
    workspace = await t.call("/workspace");
    assert.equal(workspace.orders.length, 3);
    assert.equal(workspace.files.length, 3);
    assert.equal(workspace.dashboard.metrics.revenue, 800000);
    assert.equal(
      workspace.files.find((f) => f.type === "PDF").status,
      "Perlu review",
    );
    assert.match(workspace.documentContent[0].pages[0].text, /Invoice vendor/);
    const excel = workspace.orders.find((o) => o.id === "X-1");
    assert.equal(excel.part, "Oktober");
    assert.equal(excel.row, 7);
    const original = await t.repo.call("a", "document_get", { id: docs[1].id });
    assert.deepEqual(
      Buffer.from(original.original, "base64"),
      Buffer.from(excelBytes),
    );
    await assert.rejects(
      t.call("/documents/" + docs[0].id, "GET", undefined, "b"),
      (e) => e.status === 404,
    );
  } finally {
    await t.db.close();
  }
});

test("all seven supported formats commit as one group, preserve text originals, and roll back together", async () => {
  const t = await setup();
  try {
    const docs = [await t.stage("sales.csv", csv()), await t.stage("products.csv", "sku,nama_produk,stok\nSKU-2,Celana,20"), await t.stage("sales.xlsx", workbook()), await t.stage("profile.pdf", pdf())];
    for (const [name, bytes] of Object.entries(officeFixtures())) docs.push(await t.stage(name, bytes));
    const preview = await t.preview(docs);
    await t.call(`/uploads/${preview.id}/commit`, "POST", { approved: true });
    const snapshot = await t.call("/workspace");
    assert.equal(snapshot.files.length, 8);
    assert.equal(snapshot.orders.length, 3);
    assert.equal(snapshot.products.length, 1);
    assert.equal(snapshot.documentContent.length, 5);
    assert.match(snapshot.documentContent.find(d=>d.name==="sop.docx").pages[0].text, /Contact supervisor/);
    const word = docs.find(d=>d.name==="sop.docx");
    const response = await t.app.fetch(new Request(`https://laras.test/api/documents/${word.id}/download`, { headers: {"oai-authenticated-user-id":"a"} }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /wordprocessingml/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(officeFixtures()["sop.docx"]));
    await t.call(`/imports/${preview.id}/rollback`, "POST", {});
    const rolledBack = await t.call("/workspace");
    assert.equal(rolledBack.orders.length, 0);
    assert.equal(rolledBack.products.length, 0);
    assert.equal(rolledBack.datasets.length, 0);
  } finally { await t.db.close(); }
});

test("product CSV without a minimum threshold commits with transactions and a PDF, then rolls back together", async () => {
  const t = await setup();
  try {
    const docs = [
      await t.stage("08_produk.csv", "sku,nama_produk,stok,harga_jual\nA-1,Kopi,120,25000"),
      await t.stage("07_transaksi.csv", csv()),
      await t.stage("01_profil_bisnis.pdf", pdf("Business profile")),
    ];
    const preview = await t.preview(docs);
    assert.equal((await t.call("/workspace")).products.length, 0);
    await t.call(`/uploads/${preview.id}/commit`, "POST", { approved: true });
    const workspace = await t.call("/workspace");
    assert.equal(workspace.products[0].stock, 120);
    assert.equal(workspace.products[0].minimum, 0);
    assert.equal(workspace.orders.length, 1);
    assert.equal(workspace.files.length, 3);
    assert.equal(workspace.datasets.length, 2);
    assert.equal(workspace.dashboard.inventory.low, 0);
    await t.call(`/imports/${preview.id}/rollback`, "POST", {});
    const rolledBack = await t.call("/workspace");
    assert.equal(rolledBack.products.length, 0);
    assert.equal(rolledBack.orders.length, 0);
    assert.equal(rolledBack.datasets.length, 0);
  } finally {
    await t.db.close();
  }
});

test("conflicting orders across files block the whole batch; identical rows are deduplicated visibly", async () => {
  const t = await setup();
  try {
    const one = await t.stage("one.csv", csv());
    const bad = await t.stage("bad.csv", csv("A-1", 250000));
    await assert.rejects(
      t.preview([one, bad]),
      (e) => e.code === "CROSS_FILE_CONFLICT",
    );
    assert.equal((await t.call("/workspace")).orders.length, 0);
    const same = await t.stage("same.csv", csv());
    const batch = await t.preview([one, same]);
    assert.equal(batch.added, 1);
    assert.equal(batch.unchanged, 1);
    await t.call(`/uploads/${batch.id}/commit`, "POST", { approved: true });
    assert.equal((await t.call("/workspace")).orders.length, 1);
  } finally {
    await t.db.close();
  }
});

test("failed grouped writes leave no sources or sales, and latest rollback works across legacy and new imports", async () => {
  const t = await setup();
  try {
    const legacy = await t.call("/imports/preview", "POST", {
      name: "legacy.csv",
      csv: csv(),
    });
    await t.call(`/imports/${legacy.id}/commit`, "POST", { approved: true });
    const original = (await t.call("/workspace")).orders;
    const docs = [
      await t.stage("change.csv", csv("A-1", 250000)),
      await t.stage("new.csv", csv("NEW-2", 700000)),
    ];
    const batch = await t.preview(docs);
    await t.db.exec(
      "create function laras.fail_multi() returns trigger language plpgsql as $$begin if new.id='NEW-2' then raise exception 'failure';end if;return new;end$$;create trigger fail_multi before insert on laras.orders for each row execute function laras.fail_multi();",
    );
    await assert.rejects(
      t.call(`/uploads/${batch.id}/commit`, "POST", { approved: true }),
      (e) => e.status === 500,
    );
    let current = await t.call("/workspace");
    assert.deepEqual(current.orders, original);
    assert.equal(current.files.length, 1);
    await t.db.exec("drop trigger fail_multi on laras.orders");
    await t.call(`/uploads/${batch.id}/commit`, "POST", { approved: true });
    await assert.rejects(
      t.call(`/imports/${legacy.id}/rollback`, "POST", {}),
      (e) => e.status === 409,
    );
    await t.call(`/imports/${batch.id}/rollback`, "POST", {});
    current = await t.call("/workspace");
    assert.deepEqual(current.orders, original);
    assert.equal(current.files.length, 1);
    await t.call(`/imports/${legacy.id}/rollback`, "POST", {});
    assert.equal((await t.call("/workspace")).orders.length, 0);
  } finally {
    await t.db.close();
  }
});

test("expired staged files and stale batch previews never partially commit", async () => {
  const t = await setup();
  try {
    const doc = await t.stage("sales.csv", csv());
    const batch = await t.preview([doc]);
    await t.db.query(
      "update laras.documents set expires_at=now()-interval '1 second' where id=$1",
      [doc.id],
    );
    await assert.rejects(
      t.call(`/uploads/${batch.id}/commit`, "POST", { approved: true }),
      (e) => e.code === "DOCUMENT_EXPIRED",
    );
    assert.equal((await t.call("/workspace")).files.length, 0);
  } finally {
    await t.db.close();
  }
});

test("durable leases allow only one create request and continue the same project after restart", async () => {
  const c = control();
  let creates = 0;
  const env = {
    DB: c.adapter,
    SUPABASE_ACCESS_TOKEN: "fixture",
    SUPABASE_ORGANIZATION_ID: "org",
    SUPABASE_PROJECT_NAME: "laras-test",
  };
  let existing = [];
  const fetcher = async (url, options) => {
    if (url.endsWith("/organizations/org"))
      return Response.json({ id: "org-id", plan: "free" });
    if (url.endsWith("/projects") && options.method === "POST") {
      creates++;
      await new Promise((r) => setTimeout(r, 20));
      existing = [
        {
          id: "abcdefghijklmnopqrst",
          organization_id: "org-id",
          name: "laras-test",
          status: "COMING_UP",
        },
      ];
      return Response.json(existing[0]);
    }
    if (url.endsWith("/projects")) return Response.json(existing);
    if (url.includes("/database/query")) return Response.json([]);
    return Response.json({
      id: "abcdefghijklmnopqrst",
      status: "ACTIVE_HEALTHY",
    });
  };
  try {
    const results = await Promise.all([
      advanceProvisioning("a", env, "migration", fetcher, c.store),
      advanceProvisioning("a", env, "migration", fetcher, c.store),
    ]);
    assert.equal(creates, 1);
    assert.ok(results.some((r) => r.busy));
    assert.equal((await c.store.job("a")).project_ref, "abcdefghijklmnopqrst");
    const restarted = new ControlStore(c.adapter);
    const ready = await advanceProvisioning(
      "a",
      env,
      "migration",
      fetcher,
      restarted,
    );
    assert.equal(ready.phase, "ready");
    assert.equal(creates, 1);
    assert.equal(
      (await advanceProvisioning("a", env, "migration", fetcher, restarted))
        .phase,
      "ready",
    );
    const previousHash = (await restarted.job("a")).schema_hash;
    const held = await restarted.lease("a");
    const waiting = await advanceProvisioning("a", env, "migration-v2", fetcher, restarted);
    assert.equal(waiting.phase, "migrating");
    assert.equal(waiting.busy, true);
    await restarted.release("a", held.lease_owner);
    assert.equal((await advanceProvisioning("a", env, "migration-v2", fetcher, restarted)).phase, "ready");
    assert.notEqual((await restarted.job("a")).schema_hash, previousHash);
    assert.equal(creates, 1);
    assert.equal((await restarted.job("a")).project_ref, "abcdefghijklmnopqrst");
  } finally {
    c.db.close();
  }
});

test("uncertain create outcomes never trigger a second project; paid organizations are rejected", async () => {
  const c = control();
  let creates = 0;
  const env = {
    DB: c.adapter,
    SUPABASE_ACCESS_TOKEN: "fixture",
    SUPABASE_ORGANIZATION_ID: "org",
    SUPABASE_PROJECT_NAME: "laras-test",
  };
  const fetcher = async (url, options) => {
    if (url.endsWith("/organizations/org"))
      return Response.json({ id: "org-id", plan: "free" });
    if (options.method === "POST") {
      creates++;
      throw new Error("connection lost");
    }
    return Response.json([]);
  };
  try {
    await assert.rejects(
      advanceProvisioning("a", env, "migration", fetcher, c.store),
    );
    assert.equal((await c.store.job("a")).phase, "uncertain");
    await assert.rejects(
      advanceProvisioning("a", env, "migration", fetcher, c.store),
      (e) => e.code === "PROVISION_OUTCOME_UNKNOWN",
    );
    assert.equal(creates, 1);
    await assert.rejects(
      advanceProvisioning(
        "b",
        env,
        "migration",
        async () => Response.json({ plan: "pro" }),
        c.store,
      ),
      (e) => e.code === "FREE_ORGANIZATION_REQUIRED",
    );
    assert.equal(creates, 1);
  } finally {
    c.db.close();
  }
});

test("Supabase token is authenticated, encrypted, owner-bound, and absent from status responses", async () => {
  const c = control();
  const key = base64(crypto.getRandomValues(new Uint8Array(32)));
  const env = { DB: c.adapter, LARAS_ENCRYPTION_KEY: key };
  const app = createApp({
    fetcher: async () => Response.json({ id: "org-id", plan: "free" }),
    controlFactory: () => c.store,
  });
  const req = (path, method = "GET", body, owner = "a") =>
    app.fetch(
      new Request("https://laras.test/api" + path, {
        method,
        headers: {
          "oai-authenticated-user-id": owner,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
  try {
    const response = await req("/cloud/connection", "POST", {
      token: "sbp_fake_private_test_token",
      organization: "org",
      projectName: "laras-test",
    });
    assert.equal(response.status, 200);
    const saved = await c.store.connection("a");
    assert.doesNotMatch(saved.encrypted_token, /sbp_fake/);
    assert.equal(
      await openToken(saved.encrypted_token, "a", env),
      "sbp_fake_private_test_token",
    );
    await assert.rejects(openToken(saved.encrypted_token, "b", env));
    const status = await (await req("/status")).text();
    assert.doesNotMatch(status, /sbp_fake|encrypted_token/);
    assert.equal(JSON.parse(status).data.cloud.configured, true);
    const other = await (await req("/status", "GET", undefined, "b")).json();
    assert.equal(other.data.cloud.configured, false);
  } finally {
    c.db.close();
  }
});

test("browser connection form creates one cloud project and resumes queued document processing automatically", async () => {
  const { JSDOM } = await import("jsdom");
  const fixture = await import("../web/data.js");
  const { createUploadManager } = await import("../web/uploads.js");
  const { createAdaptiveDashboard } = await import("../web/dashboard.js");
  const t = await setup();
  const c = control();
  let creates = 0,
    project = [];
  const root = {
    DB: c.adapter,
    LARAS_ENCRYPTION_KEY: base64(crypto.getRandomValues(new Uint8Array(32))),
  };
  const fetcher = async (url, options) => {
    if (url.endsWith("/organizations"))
      return Response.json([
        { id: "org-id", slug: "org", name: "Bisnis Contoh" },
      ]);
    if (url.endsWith("/organizations/org"))
      return Response.json({ id: "org-id", plan: "free" });
    if (url.endsWith("/projects") && options.method === "POST") {
      creates++;
      const body = JSON.parse(options.body);
      project = [
        {
          id: "abcdefghijklmnopqrst",
          name: body.name,
          organization_id: "org-id",
          status: "COMING_UP",
        },
      ];
      return Response.json(project[0]);
    }
    if (url.endsWith("/projects")) return Response.json(project);
    if (url.includes("/database/query")) {
      assert.match(JSON.parse(options.body).query, /laras_batch_rpc/);
      return Response.json([]);
    }
    return Response.json({
      id: "abcdefghijklmnopqrst",
      status: "ACTIVE_HEALTHY",
    });
  };
  const app = createApp({
    repositoryFactory: () => t.repo,
    controlFactory: () => c.store,
    fetcher,
    migration: sql,
    logger: { error() {} },
  });
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
  w.createUploadManager = (options) =>
    createUploadManager({ ...options, sleep: async () => {} });
  w.fetch = async () => {};
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.apiRequest = async (path, options = {}) => {
    const response = await app.fetch(
      new Request("https://laras.test/api" + path, {
        method: options.method || "GET",
        headers: {
          "oai-authenticated-user-id": "a",
          "content-type": "application/json",
          ...(options.key ? { "idempotency-key": options.key } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      }),
      root,
    );
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error.message);
      error.code = value.error.code;
      throw error;
    }
    return value.data;
  };
  const source =
    "const {products:seedProducts,production:seedProduction,initialFiles,seedOrders,parseCSV,detectMapping,normalizeRows,upsertOrders,metricSummary}=window.fixture;const apiRequest=window.apiRequest;const createUploadManager=window.createUploadManager;const createAdaptiveDashboard=window.createAdaptiveDashboard;\n" +
    fs.readFileSync("web/app.js", "utf8").replace(/^import[^\n]+\n/gm, "");
  const wait = async (predicate) => {
    const end = Date.now() + 7000;
    while (!predicate()) {
      if (Date.now() > end)
        assert.fail(
          "Auto-setup UI timed out: " +
            w.document.querySelector("#overlay-root").textContent.slice(-600),
        );
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const click = (selector) => {
    const element = w.document.querySelector(selector);
    assert.ok(element, selector);
    element.click();
  };
  try {
    w.eval(source);
    await wait(() =>
      w.document
        .querySelector(".sidebar-status")
        ?.textContent.includes("Mode demo"),
    );
    click('[data-action="upload"]');
    assert.equal(w.document.querySelector("#multi-file-input").multiple, true);
    click('[data-action="batch-sample"]');
    click('[data-action="cloud-connect"]');
    w.document.querySelector("#cloud-token").value = "sbp_fake_fixture_token";
    click("#cloud-check-token");
    await wait(() => !w.document.querySelector("#cloud-organization").disabled);
    assert.equal(w.document.querySelector("#cloud-organization").value, "org");
    w.document.querySelector("#cloud-project-name").value = "bagasta's Project";
    w.document
      .querySelector("#cloud-connection-form")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    await wait(() => w.document.querySelector('[data-action="batch-review"]'));
    assert.equal(creates, 1);
    assert.equal((await c.store.job("a")).phase, "ready");
    assert.equal((await t.repo.call("a", "bootstrap")).orders.length, 0);
    assert.equal(w.localStorage.length, 0);
    click('[data-action="batch-review"]');
    await wait(() => w.document.querySelector("#approve-batch"));
    click("#approve-batch");
    click('[data-action="batch-commit"]');
    await wait(
      () => w.document.querySelector("h1")?.textContent === "Sumber Data",
    );
    assert.equal(
      (await t.repo.call("a", "bootstrap")).datasets[0].row_count,
      1,
    );
    assert.equal(creates, 1);
    assert.doesNotMatch(w.document.body.innerHTML, /sbp_fake_fixture_token/);
  } finally {
    dom.window.close();
    c.db.close();
    await t.db.close();
  }
});

test("sales, inventory, and production share one approved transaction and one reversible history entry", async () => {
  const t = await setup();
  try {
    const docs = [
      await t.stage("sales.csv", csv()),
      await t.stage("stock.csv", "sku,name,stock,minimum\nSKU-1,Kemeja,18,30"),
      await t.stage(
        "production.csv",
        "batch_id,name,qty,completed,stage,target,supplier\nPRD-1,Kemeja,120,30,Jahit,2026-10-20,Konveksi",
      ),
    ];
    assert.equal(docs[1].tables[0].domain, "inventory");
    assert.equal(docs[2].tables[0].domain, "production");
    const preview = await t.preview(docs);
    assert.equal(preview.added, 3);
    await t.call(`/uploads/${preview.id}/commit`, "POST", { approved: true });
    const workspace = await t.call("/workspace");
    assert.equal(workspace.dashboard.metrics.revenue, 200000);
    assert.equal(workspace.dashboard.inventory.low, 1);
    assert.equal(workspace.dashboard.production.late, 1);
    assert.equal(workspace.products[0].source, "stock.csv");
    assert.equal(workspace.products[0].source_row, 2);
    assert.equal(workspace.production[0].source, "production.csv");
    assert.equal(workspace.insights.length, 2);
    await t.call(`/imports/${preview.id}/rollback`, "POST", {});
    const restored = await t.call("/workspace");
    assert.equal(restored.orders.length, 0);
    assert.equal(restored.products.length, 0);
    assert.equal(restored.production.length, 0);
    assert.equal(restored.files.length, 0);
  } finally {
    await t.db.close();
  }
});

test("removing a staged document releases its slot and never deletes an approved document", async () => {
  const t = await setup();
  try {
    const one = await t.stage("one.csv", csv());
    await t.call("/documents/" + one.id, "DELETE");
    await assert.rejects(
      t.call("/documents/" + one.id),
      (e) => e.status === 404,
    );
    const two = await t.stage("two.csv", csv());
    const batch = await t.preview([two]);
    await t.call(`/uploads/${batch.id}/commit`, "POST", { approved: true });
    await assert.rejects(
      t.call("/documents/" + two.id, "DELETE"),
      (e) => e.code === "DOCUMENT_COMMITTED",
    );
    assert.equal((await t.call("/workspace")).orders.length, 1);
  } finally {
    await t.db.close();
  }
});

test("credential rotation preserves the project reference and cannot change a leased destination", async () => {
  const c = control();
  try {
    await c.store.saveConnection("a", {
      encryptedToken: "cipher",
      organization: "org",
      projectName: "laras-one",
    });
    await c.store.ensureJob("a");
    const lease = await c.store.lease("a");
    await c.store.rememberProject("a", "abcdefghijklmnopqrst");
    await c.store.saveConnection("a", {
      encryptedToken: "rotated",
      organization: "org",
      projectName: "laras-one",
    });
    assert.equal(
      (await c.store.connection("a")).project_ref,
      "abcdefghijklmnopqrst",
    );
    await assert.rejects(
      c.store.saveConnection("a", {
        encryptedToken: "other",
        organization: "org",
        projectName: "laras-two",
      }),
      (e) => e.code === "PROVISIONING_ACTIVE",
    );
    assert.equal((await c.store.connection("a")).project_name, "laras-one");
    await c.store.release("a", lease.lease_owner);
  } finally {
    c.db.close();
  }
});

test("rolling back catalog updates restores earlier balances, production state, and source metadata", async () => {
  const t = await setup();
  try {
    await t.call("/inventory", "PUT", {
      revision: 0,
      rows: [
        {
          sku: "SKU-1",
          name: "Kemeja",
          stock: 50,
          minimum: 30,
          source: "opening-stock.csv",
          source_row: 2,
        },
      ],
    });
    await t.call("/production", "PUT", {
      revision: 1,
      rows: [
        {
          id: "PRD-1",
          name: "Kemeja",
          qty: 120,
          completed: 0,
          stage: 0,
          target: "2030-01-01",
          supplier: "Konveksi",
          source: "opening-production.csv",
        },
      ],
    });
    const before = await t.call("/workspace");
    const docs = [
      await t.stage("stock.csv", "sku,name,stock,minimum\nSKU-1,Kemeja,18,30"),
      await t.stage(
        "production.csv",
        "batch_id,name,qty,completed,stage,target,supplier\nPRD-1,Kemeja,120,30,Jahit,2026-10-20,Konveksi",
      ),
    ];
    const batch = await t.preview(docs);
    assert.equal(batch.updated, 2);
    await t.call(`/uploads/${batch.id}/commit`, "POST", { approved: true });
    assert.equal((await t.call("/workspace")).products[0].stock, 18);
    await t.call(`/imports/${batch.id}/rollback`, "POST", {});
    const after = await t.call("/workspace");
    assert.deepEqual(after.products, before.products);
    assert.deepEqual(after.production, before.production);
    assert.equal(after.files.length, 0);
  } finally {
    await t.db.close();
  }
});

test('arbitrary service data needs no order or SKU mapping and produces an owner-scoped adaptive dashboard',async()=>{
 const t=await setup();try{
  const document=await t.stage('proyek.csv','tanggal,proyek,klien,nilai_kontrak,jam_kerja,status,tenggat\n2026-10-01,Desain,Klien A,10000000,12,Selesai,2026-10-02\n2026-10-25,Riset,Klien B,20000000,7,Berjalan,2026-10-20');
  assert.equal(document.tables[0].domain,'dataset');const preview=await t.preview([document]);assert.equal(preview.added,2);await t.call(`/uploads/${preview.id}/commit`,'POST',{approved:true});
  const workspace=await t.call('/workspace');assert.equal(workspace.orders.length,0);assert.equal(workspace.datasets.length,1);assert.equal(workspace.adaptiveDashboard.context,'Proyek dan layanan');assert.equal(workspace.adaptiveDashboard.kpis[0].value,30000000);assert.doesNotMatch(JSON.stringify(workspace.adaptiveDashboard.kpis),/Pesanan|Stok/);
  const sourceId=workspace.datasets[0].id;const hours=workspace.adaptiveDashboard.options.metrics.find(c=>c.label==='jam kerja');
  const changed=await t.call(`/adaptive-dashboard?datasetId=${sourceId}&metricKey=${hours.key}&adaptiveDays=7`);assert.equal(changed.kpis[0].value,7);assert.equal(changed.table.total,1);
  await assert.rejects(t.call('/adaptive-dashboard?datasetId='+sourceId,'GET',undefined,'b'),e=>e.status===404);
  const answer=await t.call('/chat','POST',{question:'Berapa rata-rata nilai kontrak?',datasetId:sourceId,adaptiveDays:'all'});assert.match(answer.lines[0],/15.000.000/);assert.equal(answer.sources[0].name,'proyek.csv');
  await t.call(`/imports/${preview.id}/rollback`,'POST',{});assert.equal((await t.call('/workspace')).datasets.length,0);
 }finally{await t.db.close();}
});

test('PDF-only uploads show document facts instead of invented financial KPIs',async()=>{
 const t=await setup();try{const document=await t.stage('brief.pdf',pdf('Project brief'));const preview=await t.preview([document]);await t.call(`/uploads/${preview.id}/commit`,'POST',{approved:true});const workspace=await t.call('/workspace');assert.equal(workspace.adaptiveDashboard.context,'Dokumen bisnis');assert.ok(workspace.adaptiveDashboard.kpis.every(k=>k.format!=='currency'));assert.ok(workspace.adaptiveDashboard.kpis.some(k=>k.label==='Dokumen'&&k.value===1));}finally{await t.db.close();}
});
