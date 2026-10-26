import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startLocal } from "../local/server.mjs";
import http from "node:http";
test("local adapter requires its own cookie, strips spoofed identity and rejects cross-site requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "laras-http-"));
  let app;
  try {
    app = await startLocal({ port: 0, directory, environment: {} });
    const home = await fetch(app.url);
    assert.equal(home.status, 200);
    const cookie = home.headers.get("set-cookie").split(";")[0];
    assert.match(home.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
    assert.equal(
      (
        await fetch(app.url + "/api/status", {
          headers: { "oai-authenticated-user-id": "spoofed" },
        })
      ).status,
      401,
    );
    const status = await fetch(app.url + "/api/status", {
      headers: { cookie },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).data.chatgpt.available, true);
    assert.equal(
      (
        await fetch(app.url + "/api/chatgpt/disconnect", {
          method: "POST",
          headers: {
            cookie,
            origin: "https://other.example",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    const badHost = await new Promise((resolve, reject) => {
      const request = http.get(
        app.url + "/api/health",
        { headers: { host: "attacker.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
    });
    assert.equal(badHost, 403);
    await assert.rejects(
      startLocal({ port: 0, directory, environment: {} }),
      /already running/,
    );
    const cb = await fetch(app.url + "/auth/callback?state=bad&code=secret", {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(cb.status, 303);
    assert.equal(cb.headers.get("location"), "/#settings");
    assert.doesNotMatch(await cb.text(), /secret/);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
