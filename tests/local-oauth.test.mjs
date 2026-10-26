import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { oauthFixture } from "./fixtures/local-oauth.mjs";
import { ChatGPT } from "../local/chatgpt.mjs";
import { answerChat } from "../server/services/chat.js";

test("local OAuth uses PKCE and the exact loopback callback with a persistent host ID", async () => {
  const f = await oauthFixture();
  try {
    const result = await f.oauth.begin();
    const url = new URL(result.authorizationURL);
    assert.equal(url.origin, "https://auth.openai.com");
    assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(url.searchParams.get("agent_name_hint"), "Laras");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "http://127.0.0.1:3000/auth/callback",
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      url.searchParams.get("code_challenge"),
      createHash("sha256").update(f.oauth.pending.verifier).digest("base64url"),
    );
    const previous = url.searchParams.get("ext_agent_host_id");
    await f.store.initialize();
    const second = new ChatGPT({
      store: f.store,
      callbackURL: "http://127.0.0.1:3001/auth/callback",
      fetcher: f.fetcher,
    });
    assert.equal(
      new URL((await second.begin()).authorizationURL).searchParams.get(
        "ext_agent_host_id",
      ),
      previous,
    );
    assert.match(url.searchParams.get("scope"), /chatgpt.tokens.use.direct/);
    assert.equal(url.searchParams.has("client_secret"), false);
  } finally {
    await f.close();
  }
});
test("state validation precedes exchange, callbacks are single-use, and credentials stay encrypted", async () => {
  const f = await oauthFixture();
  try {
    const url = new URL((await f.oauth.begin()).authorizationURL);
    f.nonce = url.searchParams.get("nonce");
    await assert.rejects(
      f.oauth.callback(
        new URLSearchParams({
          state: "wrong",
          code: "x",
          client_id: "oaiapp_fixture_a",
        }),
      ),
      (e) => e.code === "CHATGPT_STATE_INVALID",
    );
    assert.equal(f.tokenCount, 0);
    const params = new URLSearchParams({
      state: url.searchParams.get("state"),
      code: "x",
      client_id: "oaiapp_fixture_a",
    });
    await f.oauth.callback(params);
    await assert.rejects(
      f.oauth.callback(params),
      (e) => e.code === "CHATGPT_STATE_INVALID",
    );
    const publicStatus = await f.oauth.status();
    assert.equal(publicStatus.account.sharing, true);
    assert.equal(publicStatus.account.verifiedAt, null);
    assert.doesNotMatch(
      JSON.stringify(publicStatus),
      /ACCESS_SECRET|REFRESH_SECRET|id_token/,
    );
    assert.doesNotMatch(
      await readFile(path.join(f.directory, "chatgpt.enc"), "utf8"),
      /ACCESS_SECRET|REFRESH_SECRET|fixture@example/,
    );
    if (process.platform !== "win32")
      assert.equal(
        (await stat(path.join(f.directory, "chatgpt.enc"))).mode & 0o777,
        0o600,
      );
    const request = f.calls.find((c) => c.url.endsWith("/oauth/token"));
    const body = new URLSearchParams(request.options.body);
    assert.equal(body.get("client_id"), "oaiapp_fixture_a");
    assert.equal(
      body.get("redirect_uri"),
      "http://127.0.0.1:3000/auth/callback",
    );
    assert.ok(body.get("code_verifier"));
  } finally {
    await f.close();
  }
});
test("ID token audience, expiry, nonce and returning-account identity are validated", async () => {
  for (const flag of ["badAudience", "badNonce", "expiredToken"]) {
    const f = await oauthFixture();
    try {
      f[flag] = true;
      await assert.rejects(f.login(), (e) =>
        ["CHATGPT_IDENTITY_INVALID", "CHATGPT_IDENTITY_MISMATCH"].includes(
          e.code,
        ),
      );
      assert.equal((await f.oauth.status()).account, null);
    } finally {
      await f.close();
    }
  }
  const f = await oauthFixture();
  try {
    await f.login();
    const initial = (await f.oauth.status()).account.id;
    f.subject = "another-person";
    await assert.rejects(
      f.login(),
      (e) => e.code === "CHATGPT_IDENTITY_MISMATCH",
    );
    assert.equal((await f.oauth.status()).account.id, initial);
  } finally {
    await f.close();
  }
});
test("identity-only login cannot perform inference and no fabricated model list is used", async () => {
  const f = await oauthFixture();
  try {
    f.scope = "openid profile email";
    await f.login();
    assert.equal((await f.oauth.status()).account.connected, true);
    assert.equal((await f.oauth.status()).account.sharing, false);
    await assert.rejects(
      f.oauth.models(),
      (e) => e.code === "CHATGPT_PLAN_PERMISSION_REQUIRED",
    );
    assert.equal(
      f.calls.some((c) => c.url.endsWith("/v1/models")),
      false,
    );
  } finally {
    await f.close();
  }
});
test("model choices come from the account and only completed SSE marks inference verified", async () => {
  const f = await oauthFixture();
  try {
    await f.login();
    assert.deepEqual(await f.oauth.models(), [
      { slug: "fixture-model", name: "Fixture Model" },
    ]);
    await assert.rejects(
      f.oauth.choose("hidden-model"),
      (e) => e.code === "CHATGPT_MODEL_INVALID",
    );
    await f.oauth.choose("fixture-model");
    assert.equal((await f.oauth.status()).account.verifiedAt, null);
    f.responseComplete = false;
    await assert.rejects(
      f.oauth.generate({ instructions: "Explain", input: "Approved evidence" }),
      (e) => e.code === "CHATGPT_INTERRUPTED",
    );
    assert.equal((await f.oauth.status()).account.verifiedAt, null);
    f.responseComplete = true;
    const answer = await f.oauth.generate({
      instructions: "Explain",
      input: "Approved evidence",
    });
    assert.match(answer.choices[0].message.content, /supervisor/);
    assert.ok((await f.oauth.status()).account.verifiedAt);
    const body = JSON.parse(
      f.calls.find((c) => c.url.endsWith("/v1/responses")).options.body,
    );
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.ok(Array.isArray(body.input));
    for (const field of [
      "temperature",
      "max_output_tokens",
      "max_tokens",
      "previous_response_id",
      "conversation",
      "metadata",
    ])
      assert.equal(field in body, false);
  } finally {
    await f.close();
  }
});
test("refresh rotation is serialized and revoked sessions are cleared without losing registrations", async () => {
  const f = await oauthFixture();
  try {
    await f.login();
    await f.store.run(async () => {
      const d = await f.store.read();
      d.profiles[0].tokens.expiresAt = Date.now() - 1;
      await f.store.write(d);
    });
    const values = await Promise.all([
      f.oauth.access(),
      f.oauth.access(),
      f.oauth.access(),
    ]);
    assert.equal(f.refreshCount, 1);
    assert.equal(new Set(values.map((v) => v.token)).size, 1);
    assert.match(
      (await f.store.read()).profiles[0].tokens.refreshToken,
      /REFRESH_SECRET_2/,
    );
    const id = (await f.store.read()).hostId;
    assert.equal((await f.oauth.disconnect()).revoked, true);
    const d = await f.store.read();
    assert.equal(d.profiles[0].clientId, "oaiapp_fixture_a");
    assert.equal(d.profiles[0].tokens, undefined);
    assert.equal(d.hostId, id);
    assert.equal((await f.oauth.status()).account.connected, false);
  } finally {
    await f.close();
  }
});
test("switching accounts keeps client registrations and tokens separate", async () => {
  const f = await oauthFixture();
  try {
    await f.login();
    const a = (await f.oauth.status()).account.id;
    f.subject = "subject-b";
    await f.login({ newAccount: true, client: "oaiapp_fixture_b" });
    const b = (await f.oauth.status()).account.id;
    assert.notEqual(a, b);
    assert.equal((await f.oauth.status()).accounts.length, 2);
    await f.oauth.select(a);
    assert.equal((await f.oauth.access()).token, "ACCESS_SECRET_1");
    await f.oauth.select(b);
    assert.equal((await f.oauth.access()).token, "ACCESS_SECRET_2");
  } finally {
    await f.close();
  }
});
test("Chat with Data uses the OAuth Responses provider without an OpenRouter key", async () => {
  const f = await oauthFixture();
  try {
    await f.login();
    await f.oauth.choose("fixture-model");
    const writes = [];
    const answer = await answerChat({
      body: { question: "Bagaimana SOP pembayaran?", days: 21 },
      owner: "local-owner",
      requestKey: "local-chat",
      env: { LARAS_AI_COMPLETION: (params) => f.oauth.generate(params) },
      repository: {
        async call(owner, action, payload) {
          writes.push({ owner, action, payload });
          return action === "chat_start"
            ? { id: "chat-fixture" }
            : { saved: true };
        },
      },
      fetcher: () => {
        throw new Error("OpenRouter should not be called");
      },
      snapshot: {
        files: [
          {
            id: "source-sop",
            documentId: "doc-sop",
            name: "sop.docx",
            type: "DOCX",
          },
        ],
        products: [],
        documentContent: [
          {
            id: "doc-sop",
            name: "sop.docx",
            pages: [
              {
                page: 1,
                label: "Dokumen",
                text: "Hubungi supervisor untuk pembayaran ganda.",
              },
            ],
          },
        ],
        dashboard: {
          metrics: { revenue: 0, orders: 0, units: 0 },
          sources: [],
          period: {},
          rowCount: 0,
        },
      },
    });
    assert.equal(answer.mode, "ai");
    assert.equal(answer.provider, "chatgpt");
    assert.equal(answer.title, "SOP");
    assert.match(answer.lines[0], /supervisor/);
    assert.equal(writes.at(-1).action, "chat_finish");
    assert.equal(
      f.calls.filter((c) => c.url.endsWith("/v1/responses")).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("a rejected refresh stops use of the old session and failed revocation is disclosed", async () => {
  const f = await oauthFixture();
  try {
    await f.login();
    f.revokeStatus = 503;
    assert.equal((await f.oauth.disconnect()).revoked, false);
    assert.match((await f.oauth.status()).notice, /belum terkonfirmasi/);
    await f.login();
    await f.store.run(async () => {
      const d = await f.store.read();
      d.profiles[0].tokens.expiresAt = 0;
      await f.store.write(d);
    });
    f.tokenStatus = 400;
    await assert.rejects(
      f.oauth.access(),
      (e) => e.code === "CHATGPT_RECONNECT_REQUIRED",
    );
    assert.equal((await f.oauth.status()).account.connected, false);
  } finally {
    await f.close();
  }
});
