import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import {
  ControlStore,
  openToken,
  ownerEnvironment,
} from "../server/infrastructure/control.js";
import { createApp } from "../server/app.js";
import { createUploadManager } from "../web/uploads.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const f of fs
    .readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(fs.readFileSync("drizzle/" + f, "utf8"));
  const prepare = (sql, params = []) => ({
    bind(...values) {
      return prepare(sql, values);
    },
    async first() {
      return db.prepare(sql).get(...params) || null;
    },
    async run() {
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes) } };
    },
  });
  const adapter = { prepare };
  const control = new ControlStore(adapter);
  return {
    db,
    control,
    env: {
      DB: adapter,
      LARAS_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
    },
  };
}
test("OpenRouter keys are verified, owner-encrypted, redacted from status, and removable independently", async () => {
  const f = fixture();
  let calls = 0;
  const app = createApp({
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "https://openrouter.ai/api/v1/key");
      assert.equal(
        options.headers.authorization,
        "Bearer sk-or-fixture-private",
      );
      return Response.json({ data: { label: "private", limit_remaining: 0 } });
    },
    controlFactory: () => f.control,
  });
  const request = (path, method = "GET", body, owner = "owner-a") =>
    app.fetch(
      new Request("https://laras.test/api" + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(owner ? { "oai-authenticated-user-id": owner } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      f.env,
    );
  try {
    assert.equal(
      (await request("/ai/connection", "POST", { key: "ignored" }, null))
        .status,
      401,
    );
    assert.equal(calls, 0);
    const response = await request("/ai/connection", "POST", {
      key: "sk-or-fixture-private",
      model: "openrouter/free",
    });
    assert.equal(response.status, 200);
    const record = await f.control.aiConnection("owner-a");
    assert.doesNotMatch(record.encrypted_key, /fixture-private/);
    assert.equal(
      await openToken(record.encrypted_key, "owner-a|openrouter", f.env),
      "sk-or-fixture-private",
    );
    await assert.rejects(
      openToken(record.encrypted_key, "owner-b|openrouter", f.env),
    );
    await assert.rejects(openToken(record.encrypted_key, "owner-a", f.env));
    assert.equal(
      (await ownerEnvironment(f.env, "owner-a", f.control)).OPENROUTER_API_KEY,
      "sk-or-fixture-private",
    );
    const status = await (await request("/status")).json();
    assert.equal(status.data.ai, true);
    assert.equal(status.data.aiConnection.model, "openrouter/free");
    assert.doesNotMatch(
      JSON.stringify(status),
      /fixture-private|encrypted_key/,
    );
    assert.equal(
      (
        await (
          await request("/ai/connection", "GET", undefined, "owner-b")
        ).json()
      ).data.configured,
      false,
    );
    assert.equal((await request("/ai/connection", "DELETE", {})).status, 200);
    assert.equal(await f.control.aiConnection("owner-a"), null);
  } finally {
    f.db.close();
  }
});
test("invalid OpenRouter keys or model IDs are never saved, and invalid AI envelopes do not break data status", async () => {
  const f = fixture();
  let calls = 0;
  const app = createApp({
    fetcher: async () => {
      calls++;
      return new Response("fixture-secret-provider-detail", { status: 401 });
    },
    controlFactory: () => f.control,
  });
  const req = (body) =>
    app.fetch(
      new Request("https://laras.test/api/ai/connection", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "oai-authenticated-user-id": "a",
        },
        body: JSON.stringify(body),
      }),
      f.env,
    );
  try {
    const bad = await req({ key: "fixture-secret", model: "openrouter/free" });
    assert.equal(bad.status, 401);
    assert.doesNotMatch(await bad.text(), /fixture-secret/);
    assert.equal(await f.control.aiConnection("a"), null);
    assert.equal(
      (
        await req({
          key: "fixture-secret",
          model: "https://arbitrary.test model",
        })
      ).status,
      422,
    );
    assert.equal(calls, 1);
    await f.control.saveAIConnection("a", "invalid", "openrouter/free");
    assert.equal(
      (await ownerEnvironment(f.env, "a", f.control, { includeAI: false }))
        .LARAS_AI_CONFIGURED,
      true,
    );
    await assert.rejects(
      ownerEnvironment(f.env, "a", f.control),
      (e) => e.code === "AI_CONNECTION_UNREADABLE",
    );
  } finally {
    f.db.close();
  }
});
test("OpenRouter form submits through the same-origin API and clears the key after success", async () => {
  const dom = new JSDOM('<div id="modal"></div>', {
    url: "https://laras.test",
  });
  const doc = dom.window.document;
  const root = doc.querySelector("#modal");
  let saved;
  const manager = createUploadManager({
    document: doc,
    crypto,
    state: { backend: { aiConnection: { model: "openrouter/free" } } },
    api: async (path, options) => {
      assert.equal(path, "/ai/connection");
      saved = options.body;
    },
    escape: (value) => String(value).replaceAll('"', "&quot;"),
    icon: () => "",
    openModal: (html) => (root.innerHTML = html),
    closeModal: () => (root.innerHTML = ""),
    initializeBackend: async () => {},
    toast() {},
  });
  try {
    manager.handleClick({ dataset: { action: "ai-connect" } });
    doc.querySelector("#ai-key").value = "sk-or-fixture-private";
    doc
      .querySelector("#ai-connection-form")
      .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(saved.key, "sk-or-fixture-private");
    assert.equal(saved.model, "openrouter/free");
    assert.equal(doc.querySelector("#ai-key"), null);
    assert.equal(dom.window.localStorage.length, 0);
  } finally {
    dom.window.close();
  }
});
