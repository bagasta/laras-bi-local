import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../server/app.js";
import { AppError } from "../server/http.js";
import {
  createRepository,
  sqlJson,
  rpcFor,
} from "../server/infrastructure/supabase.js";
import { provisionBusiness } from "../server/services/provision.js";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/001_laras.sql", import.meta.url),
  "utf8",
);
const secondMigration = fs.readFileSync(
  new URL("../supabase/migrations/002_multi_documents.sql", import.meta.url),
  "utf8",
);
const csv =
  "order_id,date,sku,product,quantity,unit_price,discount,total,status,channel\nA-1,2026-10-21,SKU-1,Kemeja,2,100000,0,200000,Selesai,Website\nA-2,2026-10-21,SKU-2,Celana,1,300000,0,300000,Selesai,Shopee";
const env = {
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
};
async function setup(
  fetcher = () => {
    throw new Error("Unexpected network call");
  },
) {
  const db = new PGlite();
  await db.exec(
    "create role anon;create role authenticated;create role service_role;",
  );
  await db.exec(migration);
  await db.exec(secondMigration);
  const repository = {
    async call(owner, action, payload = {}) {
      const result = (
        await db.query(
          `select public.${rpcFor(action)}($1,$2,$3::jsonb) as result`,
          [owner, action, JSON.stringify(payload)],
        )
      ).rows[0].result;
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
    repositoryFactory: () => repository,
    migration,
    fetcher,
    logger: { error() {} },
  });
  async function request(
    path,
    {
      method = "GET",
      body,
      owner = "owner-a",
      key = crypto.randomUUID(),
      headers = {},
    } = {},
  ) {
    return app.fetch(
      new Request("https://laras.test" + path, {
        method,
        headers: {
          ...(owner ? { "oai-authenticated-user-id": owner } : {}),
          "content-type": "application/json",
          "idempotency-key": key,
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
  }
  async function data(path, options) {
    const response = await request(path, options);
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result.data;
  }
  async function preview(content = csv, key = crypto.randomUUID()) {
    return data("/api/imports/preview", {
      method: "POST",
      key,
      body: { name: "sales.csv", csv: content },
    });
  }
  async function commit(id) {
    return data(`/api/imports/${id}/commit`, {
      method: "POST",
      body: { approved: true },
    });
  }
  return { db, app, repository, request, data, preview, commit };
}

test("API requires identity, rejects cross-site writes, and exposes no secret values", async () => {
  const t = await setup();
  try {
    assert.equal(
      (await t.request("/api/workspace", { owner: null })).status,
      401,
    );
    assert.equal(
      (
        await t.request("/api/preferences", {
          method: "PATCH",
          headers: { origin: "https://evil.test" },
          body: { name: "Other" },
        })
      ).status,
      403,
    );
    const status = await t.data("/api/status");
    assert.equal(status.database, true);
    assert.equal(status.mode, "supabase-rest");
    assert.doesNotMatch(JSON.stringify(status), /test-service-key/);
    const response = await t.app.fetch(
      new Request("https://laras.test/api/workspace", {
        headers: { "oai-authenticated-user-id": "other" },
      }),
      { ...env, LARAS_OWNER_ID: "owner-a" },
    );
    assert.equal(response.status, 403);
  } finally {
    await t.db.close();
  }
});

test("CSV preview never mutates business rows; approved commit is atomic and retry-safe", async () => {
  const t = await setup();
  try {
    const p = await t.preview();
    assert.equal(p.added, 2);
    assert.equal((await t.data("/api/workspace")).orders.length, 0);
    const denied = await t.request(`/api/imports/${p.id}/commit`, {
      method: "POST",
      body: { approved: false },
    });
    assert.equal(denied.status, 422);
    const committed = await t.commit(p.id);
    assert.equal(committed.added, 2);
    assert.deepEqual(await t.commit(p.id), committed);
    const snap = await t.data("/api/workspace");
    assert.equal(snap.dashboard.metrics.revenue, 500000);
    assert.equal(snap.dashboard.metrics.orders, 2);
    assert.equal(snap.files.length, 1);
    assert.equal(snap.orders[0].row, 2);
    const again = await t.preview();
    assert.equal(again.unchanged, 2);
    await t.commit(again.id);
    assert.equal((await t.data("/api/workspace")).files.length, 1);
  } finally {
    await t.db.close();
  }
});

test("business ownership isolates reads, approvals, rollback, and source records", async () => {
  const t = await setup();
  try {
    const p = await t.preview();
    await t.commit(p.id);
    const other = await t.data("/api/workspace", { owner: "owner-b" });
    assert.equal(other.orders.length, 0);
    assert.equal(other.files.length, 0);
    assert.equal(other.dashboard.metrics.revenue, 0);
    for (const operation of ["commit", "rollback"])
      assert.equal(
        (
          await t.request(`/api/imports/${p.id}/${operation}`, {
            owner: "owner-b",
            method: "POST",
            body: { approved: true },
          })
        ).status,
        404,
      );
  } finally {
    await t.db.close();
  }
});

test("stale previews and conflicting idempotency keys cannot overwrite newer data", async () => {
  const t = await setup();
  try {
    const p1 = await t.preview(csv, "request-1");
    assert.equal((await t.preview(csv, "request-1")).id, p1.id);
    const p2 = await t.preview(csv.replace("200000", "210000"));
    const conflict = await t.request("/api/imports/preview", {
      method: "POST",
      key: "request-1",
      body: { name: "sales.csv", csv: csv.replace("200000", "210000") },
    });
    assert.equal(conflict.status, 409);
    await t.commit(p1.id);
    assert.equal(
      (
        await t.request(`/api/imports/${p2.id}/commit`, {
          method: "POST",
          body: { approved: true },
        })
      ).status,
      409,
    );
    assert.equal((await t.data("/api/dashboard")).metrics.revenue, 500000);
  } finally {
    await t.db.close();
  }
});

test("invalid CSV, repeated keys, malformed JSON, and invalid catalog rows cause no writes", async () => {
  const t = await setup();
  try {
    for (const bad of [
      csv.replace("2026-10-21", "2026-02-30"),
      csv + "\nA-1,2026-10-21,SKU-1,Kemeja,2,100000,0,200000,Selesai,Website",
      csv.replace(",2,100000", ",-2,100000"),
    ]) {
      assert.equal(
        (
          await t.request("/api/imports/preview", {
            method: "POST",
            body: { name: "sales.csv", csv: bad },
          })
        ).status,
        422,
      );
    }
    assert.equal(
      (
        await t.request("/api/inventory", {
          method: "PUT",
          body: {
            revision: 0,
            rows: [{ sku: "A", name: "Product", minimum: 1 }],
          },
        })
      ).status,
      422,
    );
    const raw = await t.app.fetch(
      new Request("https://laras.test/api/imports/preview", {
        method: "POST",
        headers: {
          "oai-authenticated-user-id": "owner-a",
          "content-type": "application/json",
        },
        body: "{",
      }),
      env,
    );
    assert.equal(raw.status, 400);
    assert.equal((await t.data("/api/workspace")).orders.length, 0);
  } finally {
    await t.db.close();
  }
});

test("rollback restores changed values and provenance and only permits the latest import", async () => {
  const t = await setup();
  try {
    const first = await t.preview();
    await t.commit(first.id);
    const original = await t.data("/api/workspace");
    const second = await t.preview(csv.replace("200000", "250000"));
    await t.commit(second.id);
    assert.equal(
      (
        await t.request(`/api/imports/${first.id}/rollback`, {
          method: "POST",
          body: {},
        })
      ).status,
      409,
    );
    await t.data(`/api/imports/${second.id}/rollback`, {
      method: "POST",
      body: {},
    });
    const restored = await t.data("/api/workspace");
    assert.deepEqual(restored.orders, original.orders);
    assert.equal(restored.files.length, 1);
    await t.data(`/api/imports/${first.id}/rollback`, {
      method: "POST",
      body: {},
    });
    assert.equal((await t.data("/api/workspace")).orders.length, 0);
    assert.equal(
      (await t.db.query("select count(*)::int n from laras.audit_log")).rows[0]
        .n,
      4,
    );
  } finally {
    await t.db.close();
  }
});

test("catalog data drives proactive findings and changed facts invalidate a review", async () => {
  const t = await setup();
  try {
    await t.data("/api/workspace");
    await t.data("/api/inventory", {
      method: "PUT",
      body: {
        revision: 0,
        rows: [
          {
            sku: "SKU-1",
            name: "Kemeja",
            stock: 4,
            minimum: 10,
            source: "inventory.csv",
            source_row: 2,
          },
        ],
      },
    });
    const s = await t.data("/api/workspace");
    assert.equal(s.insights.length, 1);
    assert.equal(s.dashboard.inventory.low, 1);
    const fingerprint = s.insights[0].fingerprint;
    await t.data("/api/insights/review", {
      method: "POST",
      body: { fingerprint, reviewed: true },
    });
    assert.deepEqual((await t.data("/api/workspace")).reviewed, [fingerprint]);
    await t.data("/api/inventory", {
      method: "PUT",
      body: {
        revision: 1,
        rows: [{ sku: "SKU-1", name: "Kemeja", stock: 3, minimum: 10 }],
      },
    });
    assert.notEqual(
      (await t.data("/api/workspace")).insights[0].fingerprint,
      fingerprint,
    );
  } finally {
    await t.db.close();
  }
});

test("database roles deny anonymous RPC execution and isolate internal tables", async () => {
  const t = await setup();
  try {
    await t.db.exec("set role anon");
    await assert.rejects(
      t.db.query("select public.laras_rpc('owner-a','bootstrap','{}')"),
    );
    await assert.rejects(t.db.query("select * from laras.orders"));
    await t.db.exec("reset role");
    await t.db.exec("set role service_role");
    assert.equal(
      (
        await t.db.query(
          "select public.laras_rpc('owner-a','bootstrap','{}') result",
        )
      ).rows[0].result.orders.length,
      0,
    );
    await t.db.exec("reset role");
  } finally {
    await t.db.close();
  }
});

test("AI explains approved evidence; computed facts remain unchanged and chat retries do not re-bill", async () => {
  let calls = 0;
  const t = await setup(async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    calls++;
    const sent = JSON.parse(options.body);
    assert.doesNotMatch(JSON.stringify(sent), /service-key|test-ai-key/);
    assert.match(JSON.stringify(sent), /500000|sales.csv/);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"title":"Ringkasan penjualan","lines":["Penjualan tercatat Rp500.000."],"sourceIds":["E0"]}' } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const p = await t.preview();
    await t.commit(p.id);
    const request = new Request("https://laras.test/api/chat", {
      method: "POST",
      headers: {
        "oai-authenticated-user-id": "owner-a",
        "content-type": "application/json",
        "idempotency-key": "chat-1",
      },
      body: JSON.stringify({ question: "Tolong analisis omzet", days: 21 }),
    });
    for (let n = 0; n < 2; n++) {
      const r = await t.app.fetch(request.clone(), {
        ...env,
        OPENROUTER_API_KEY: "test-ai-key",
      });
      assert.equal(r.status, 200);
      const answer = (await r.json()).data;
      assert.equal(answer.mode, "ai");
      assert.equal(answer.metrics.revenue, 500000);
      assert.equal(answer.sources[0].name, "sales.csv");
    }
    assert.equal(calls, 1);
  } finally {
    await t.db.close();
  }
});

test("AI failure and unsupported plans fall back explicitly without executing model SQL", async () => {
  const t = await setup(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"intent":"drop table orders"}' } }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  try {
    const response = await t.app.fetch(
      new Request("https://laras.test/api/chat", {
        method: "POST",
        headers: {
          "oai-authenticated-user-id": "owner-a",
          "content-type": "application/json",
          "idempotency-key": "chat-2",
        },
        body: JSON.stringify({ question: "Total penjualan?" }),
      }),
      { ...env, OPENROUTER_API_KEY: "test-ai-key" },
    );
    const answer = (await response.json()).data;
    assert.equal(answer.mode, "rules");
    assert.ok(answer.notice);
    assert.equal(answer.metrics.revenue, 0);
  } finally {
    await t.db.close();
  }
});

test("Supabase adapter parameterizes even hostile Unicode values and redacts upstream errors", async () => {
  const t = await setup();
  try {
    const payload = {
      owner: "owner');drop schema laras cascade;--😀",
      action: "bootstrap",
      payload: {},
    };
    const encoded = sqlJson(payload);
    assert.doesNotMatch(encoded, /drop schema/);
    assert.equal(
      (await t.db.query(`select (${encoded})->>'owner' as value`)).rows[0]
        .value,
      payload.owner,
    );
    const repository = createRepository(
      env,
      async () =>
        new Response(JSON.stringify({ error: "test-service-key" }), {
          status: 500,
        }),
    );
    await assert.rejects(
      repository.call("owner-a", "bootstrap"),
      (error) => !error.message.includes("test-service-key"),
    );
  } finally {
    await t.db.close();
  }
});

test("provisioning checks organization billing before creation and reconciles previous projects", async () => {
  const settings = {
    SUPABASE_ACCESS_TOKEN: "token",
    SUPABASE_ORGANIZATION_ID: "org",
    SUPABASE_PROJECT_NAME: "laras-one",
  };
  let creates = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith("/organizations/org"))
      return Response.json({ id: "org-id", plan: "free" });
    if (options.method === "POST") {
      creates++;
      const body = JSON.parse(options.body);
      assert.equal(body.organization_slug, "org");
      assert.equal(body.desired_instance_size, "nano");
      assert.ok(body.db_pass.length >= 32);
      return Response.json({
        id: "abcdefghijklmnopqrst",
        name: "laras-one",
        organization_id: "org-id",
        status: "COMING_UP",
      });
    }
    return Response.json([]);
  };
  const result = await provisionBusiness(settings, { fetcher });
  assert.equal(result.created, true);
  assert.equal(creates, 1);
  await assert.rejects(
    provisionBusiness(settings, { pending: true, fetcher }),
    (e) => e.code === "PROVISION_OUTCOME_UNKNOWN",
  );
  assert.equal(creates, 1);
  await assert.rejects(
    provisionBusiness(settings, {
      fetcher: async () => Response.json({ plan: "pro" }),
    }),
    (e) => e.code === "FREE_ORGANIZATION_REQUIRED",
  );
  const existing = await provisionBusiness(settings, {
    pending: true,
    fetcher: async (url) =>
      url.endsWith("/organizations/org")
        ? Response.json({ id: "org-id", plan: "free" })
        : Response.json([
            {
              id: "abcdefghijklmnopqrst",
              name: "laras-one",
              organization_id: "org-id",
            },
          ]),
  });
  assert.equal(existing.created, false);
});

test("a database failure midway through commit rolls back sources, records, and revision together", async () => {
  const t = await setup();
  try {
    const p = await t.preview();
    await t.db.exec(
      "create function laras.test_fail() returns trigger language plpgsql as $$begin if new.sku='SKU-2' then raise exception 'test failure';end if;return new;end$$;create trigger test_fail before insert on laras.orders for each row execute function laras.test_fail();",
    );
    const response = await t.request(`/api/imports/${p.id}/commit`, {
      method: "POST",
      body: { approved: true },
    });
    assert.equal(response.status, 500);
    const snapshot = await t.data("/api/workspace");
    assert.equal(snapshot.orders.length, 0);
    assert.equal(snapshot.files.length, 0);
    assert.equal(snapshot.workspace.revision, 0);
    await t.db.exec("drop trigger test_fail on laras.orders;");
    await t.commit(p.id);
    assert.equal((await t.data("/api/workspace")).orders.length, 2);
  } finally {
    await t.db.close();
  }
});

test("expired previews cannot be committed and chat limits bound provider spending", async () => {
  const t = await setup();
  try {
    const p = await t.preview();
    await t.db.query(
      "update laras.imports set expires_at=now()-interval '1 second' where id=$1",
      [p.id],
    );
    assert.equal(
      (
        await t.request(`/api/imports/${p.id}/commit`, {
          method: "POST",
          body: { approved: true },
        })
      ).status,
      409,
    );
    for (let i = 0; i < 20; i++)
      await t.data("/api/chat", {
        method: "POST",
        body: { question: "Total penjualan?" },
        key: "limited-" + i,
      });
    const response = await t.request("/api/chat", {
      method: "POST",
      body: { question: "Total penjualan?" },
      key: "limited-21",
    });
    assert.equal(response.status, 429);
  } finally {
    await t.db.close();
  }
});

test("cloud frontend replaces demo data and completes CSV approval through the API and database", async () => {
  const { JSDOM } = await import("jsdom");
  const { createUploadManager } = await import("../web/uploads.js");
  const { createAdaptiveDashboard } = await import("../web/dashboard.js");
  const fixture = await import("../web/data.js");
  const t = await setup();
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
  w.createUploadManager = createUploadManager;
  w.createAdaptiveDashboard = createAdaptiveDashboard;
  w.fetch = async () => {};
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.apiRequest = async (path, options = {}) => {
    const response = await t.request("/api" + path, {
      method: options.method,
      body: options.body,
      key: options.key,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error.message);
      error.details = result.error.details;
      throw error;
    }
    return result.data;
  };
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
  const wait = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail("Cloud DOM operation timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
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
        .textContent.includes("Supabase"),
    );
    assert.match(
      w.document.querySelector("main").textContent,
      /Dashboard mengikuti data Anda/,
    );
    assert.equal(w.localStorage.getItem("laras-demo-v1"), null);
    click('[data-action="upload"]');
    click('[data-action="batch-sample"]');
    click('[data-action="batch-process"]');
    await wait(() => w.document.querySelector('[data-action="batch-review"]'));
    click('[data-action="batch-review"]');
    await wait(() => w.document.querySelector("#approve-batch"));
    assert.equal((await t.data("/api/workspace")).orders.length, 0);
    click("#approve-batch");
    click('[data-action="batch-commit"]');
    await wait(() => !w.document.querySelector('[role="dialog"]'));
    await wait(
      () => w.document.querySelector("h1")?.textContent === "Sumber Data",
    );
    w.location.hash = "overview";
    await wait(
      () => w.document.querySelector(".kpi-value")?.title === "Rp 200.000",
    );
    assert.equal((await t.data("/api/workspace")).datasets[0].row_count, 1);
    assert.equal(w.localStorage.getItem("laras-demo-v1"), null);
    w.location.hash = "chat";
    await wait(() => w.document.querySelector("#chat-input"));
    const input = w.document.querySelector("#chat-input");
    input.value = "Total penjualan?";
    w.document
      .querySelector("#chat-form")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    await wait(() => w.document.querySelector(".message-answer"));
    assert.match(
      w.document.querySelector(".message-answer").textContent,
      /200.000/,
    );
    assert.match(
      w.document.querySelector(".answer-source").textContent,
      /contoh_proyek.csv/,
    );
  } finally {
    dom.window.close();
    await t.db.close();
  }
});

test("browser API client sends structured requests and reports transport errors safely", async () => {
  const { request } = await import("../web/api.js");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/api/imports/preview");
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.headers["idempotency-key"], "request-1");
      assert.deepEqual(JSON.parse(options.body), { name: "sales.csv" });
      return Response.json({ data: { id: "preview-id" } });
    };
    assert.deepEqual(
      await request("/imports/preview", {
        method: "POST",
        key: "request-1",
        body: { name: "sales.csv" },
      }),
      { id: "preview-id" },
    );
    globalThis.fetch = async () => {
      throw new Error("internal network details");
    };
    await assert.rejects(
      request("/status"),
      (error) =>
        error.code === "NETWORK_ERROR" && !error.message.includes("internal"),
    );
  } finally {
    globalThis.fetch = original;
  }
});
