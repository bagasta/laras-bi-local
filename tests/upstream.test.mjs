import test from "node:test";
import assert from "node:assert/strict";
import { upstream } from "../server/infrastructure/upstream.js";
import { management } from "../server/infrastructure/supabase.js";
import { saveCloudConnection } from "../server/services/cloud-setup.js";
import { createApp } from "../server/app.js";

test("outbound requests use Workers-compatible redirect handling without forwarding credentials", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let requests = 0,
      cancelled = false;
    await assert.rejects(
      upstream(
        async (_url, options) => {
          requests++;
          assert.equal(options.redirect, "manual");
          assert.equal(options.headers.authorization, "Bearer fixture-secret");
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              status,
              headers: { location: "https://another-host.test/" },
            },
          );
        },
        "https://api.supabase.com/v1/organizations/org",
        {
          headers: { authorization: "Bearer fixture-secret" },
          redirect: "follow",
        },
      ),
      (error) => error.code === "UPSTREAM_REDIRECT" && error.status === 502,
    );
    assert.equal(requests, 1);
    assert.equal(cancelled, true);
  }
});

test("Supabase connection errors distinguish token, access, organization, and rate limits without exposing response data", async () => {
  const errors = [
    [401, "SUPABASE_TOKEN_INVALID", 401],
    [403, "SUPABASE_ACCESS_DENIED", 403],
    [404, "SUPABASE_RESOURCE_NOT_FOUND", 422],
    [429, "SUPABASE_RATE_LIMITED", 429],
    [503, "SUPABASE_MANAGEMENT_ERROR", 503],
  ];
  for (const [upstreamStatus, code, status] of errors) {
    await assert.rejects(
      management(
        { SUPABASE_ACCESS_TOKEN: "fixture-secret" },
        "/organizations/org",
        {},
        async () =>
          new Response("provider-secret-in-non-json-body", {
            status: upstreamStatus,
          }),
      ),
      (error) =>
        error.code === code &&
        error.status === status &&
        error.upstreamStatus === upstreamStatus &&
        !JSON.stringify(error).includes("provider-secret"),
    );
  }
});

test("outbound timeouts differ from unavailable transports and successful responses remain readable", async () => {
  for (const name of ["TimeoutError", "AbortError", "TypeError"]) {
    await assert.rejects(
      upstream(async () => {
        throw new DOMException("fixture-secret", name);
      }, "https://api.supabase.com"),
      (error) =>
        error.code ===
          (name === "TypeError"
            ? "UPSTREAM_UNAVAILABLE"
            : "UPSTREAM_TIMEOUT") &&
        !JSON.stringify(error).includes("fixture-secret"),
    );
  }
  const result = await management(
    { SUPABASE_ACCESS_TOKEN: "fixture-secret" },
    "/organizations/org",
    {},
    async () => Response.json({ plan: "free" }),
  );
  assert.deepEqual(result, { plan: "free" });
});

test("connection form accepts a Supabase organization URL and saves only its validated slug", async () => {
  let saved, requested;
  const env = { LARAS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
  const store = {
    async saveConnection(owner, values) {
      saved = { owner, ...values };
    },
  };
  const fetcher = async (url) => {
    requested = url;
    return Response.json({ plan: "free" });
  };
  const body = {
    token: "fixture-token",
    organization:
      "https://supabase.com/dashboard/org/actual-org/settings/general",
    projectName: "bagasta's Project",
  };
  const result = await saveCloudConnection(
    "owner-a",
    body,
    env,
    fetcher,
    store,
  );
  assert.equal(
    requested,
    "https://api.supabase.com/v1/organizations/actual-org",
  );
  assert.equal(result.organization, "actual-org");
  assert.equal(saved.organization, "actual-org");
  assert.equal(saved.projectName, "bagasta's Project");
  assert.doesNotMatch(saved.encryptedToken, /fixture-token/);
  for (const organization of [
    "https://other-host.test/dashboard/org/actual-org",
    "https://supabase.com/dashboard/project/project-ref",
    "Account Name",
  ])
    await assert.rejects(
      saveCloudConnection(
        "owner-a",
        { ...body, organization },
        env,
        fetcher,
        store,
      ),
      (e) => e.code === "INVALID_ORGANIZATION",
    );
});

test("organization discovery uses the supplied token and returns only accessible names and canonical slugs", async () => {
  let calls = 0;
  const app = createApp({
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.supabase.com/v1/organizations");
      assert.equal(options.headers.authorization, "Bearer fixture-token");
      return Response.json([
        { id: "legacy", slug: "real-org", name: "Bagasta", private: "hidden" },
      ]);
    },
  });
  const request = (authenticated) =>
    new Request("https://laras.test/api/cloud/organizations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { "oai-authenticated-user-id": "owner-a" } : {}),
      },
      body: JSON.stringify({ token: "fixture-token" }),
    });
  assert.equal((await app.fetch(request(false))).status, 401);
  assert.equal(calls, 0);
  const response = await app.fetch(request(true));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result.data, {
    organizations: [{ slug: "real-org", name: "Bagasta" }],
  });
  assert.doesNotMatch(JSON.stringify(result), /fixture-token|hidden|legacy/);
});

test("ordinary project names remain bounded and the selected organization's Free plan is verified before saving", async () => {
  const body = {
    token: "fixture-token",
    organization: "org",
    projectName: "bagasta's Project",
  };
  let saves = 0;
  const store = {
    async saveConnection() {
      saves++;
    },
  };
  await assert.rejects(
    saveCloudConnection(
      "owner-a",
      body,
      {},
      async () => Response.json({ plan: "pro" }),
      store,
    ),
    (e) => e.code === "FREE_ORGANIZATION_REQUIRED",
  );
  for (const projectName of [" ", "x".repeat(81), "bad\u0000name"])
    await assert.rejects(
      saveCloudConnection(
        "owner-a",
        { ...body, projectName },
        {},
        async () => {
          throw new Error("Should validate first");
        },
        store,
      ),
      (e) => e.code === "INVALID_FIELD",
    );
  assert.equal(saves, 0);
});

test("failed connection requests log a safe error code and request reference without token values", async () => {
  const entries = [];
  const app = createApp({
    fetcher: async () => {
      throw new Error("private-token-and-provider-details");
    },
    controlFactory: () => ({}),
    logger: {
      error(value) {
        entries.push(JSON.parse(value));
      },
    },
  });
  const response = await app.fetch(
    new Request("https://laras.test/api/cloud/connection", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-id": "owner-a",
      },
      body: JSON.stringify({
        token: "private-token",
        organization: "org",
        projectName: "laras-test",
      }),
    }),
    { DB: {} },
  );
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.error.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(entries[0].code, "UPSTREAM_UNAVAILABLE");
  assert.equal(entries[0].requestId, result.requestId);
  assert.doesNotMatch(
    JSON.stringify({ entries, result }),
    /private-token|provider-details/,
  );
});
