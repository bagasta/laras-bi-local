import http from "node:http";
import {
  readFile,
  readdir,
  open,
  unlink,
  mkdir,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.js";
import { AppError, identity, json, readJson } from "../server/http.js";
import { localControl } from "../scripts/local-control.mjs";
import { localKey, SecureStore } from "./storage.mjs";
import { ChatGPT } from "./chatgpt.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
async function assets() {
  const result = {};
  async function collect(dir) {
    for (const f of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) await collect(full);
      else {
        const binary = f.name.endsWith(".woff2");
        result[
          "/" +
            path
              .relative(path.join(root, "web"), full)
              .split(path.sep)
              .join("/")
        ] = {
          type: mime[path.extname(f.name)] || "application/octet-stream",
          encoding: binary ? "base64" : "utf8",
          body: (await readFile(full)).toString(binary ? "base64" : "utf8"),
        };
      }
    }
  }
  await collect(path.join(root, "web"));
  return result;
}
async function runtimeLock(directory) {
  const file = path.join(directory, "runtime.lock");
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await unlink(file).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(file, "utf8"));
      try {
        if (!Number.isInteger(pid) || pid < 1) throw new Error("invalid");
        process.kill(pid, 0);
      } catch (check) {
        if (check.code === "EPERM")
          throw new Error("Laras data directory is locked by another process.");
        await unlink(file);
        continue;
      }
      throw new Error("Laras is already running with this data directory.");
    }
  throw new Error("Could not acquire the Laras local data lock.");
}
export async function startLocal({
  port = 3000,
  directory = path.join(root, ".laras"),
  environment = process.env,
  fetcher = fetch,
  oauthFactory = (options) => new ChatGPT(options),
} = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const key = environment.LARAS_ENCRYPTION_KEY || (await localKey(directory));
  const release = await runtimeLock(directory);
  const db = localControl(path.join(directory, "control.sqlite"));
  await chmod(path.join(directory, "control.sqlite"), 0o600);
  const owner =
    environment.LARAS_LOCAL_OWNER_ID ||
    environment.LARAS_OWNER_ID ||
    "local-owner";
  const secret = randomBytes(32).toString("hex");
  const env = { ...environment, DB: db, LARAS_ENCRYPTION_KEY: key };
  const migration = (
    await Promise.all(
      [
        "001_laras.sql",
        "002_multi_documents.sql",
        "003_office_documents.sql",
      ].map((f) => readFile(path.join(root, "supabase/migrations", f), "utf8")),
    )
  ).join("\n");
  const app = createApp({
    assets: await assets(),
    migration,
    fetcher,
    instanceId: "laras-local",
  });
  let oauth, baseURL;
  const server = http.createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableEnded) abort.abort();
    });
    try {
      if (incoming.headers.host !== new URL(baseURL).host) {
        outgoing.writeHead(403);
        outgoing.end("Invalid local host");
        return;
      }
      const url = new URL(incoming.url, baseURL);
      const headers = new Headers(incoming.headers);
      headers.delete("oai-authenticated-user-id");
      headers.delete("oai-authenticated-user-email");
      const session = incoming.headers.cookie
        ?.split(/;\s*/)
        .some((value) => value === "laras_session=" + secret);
      if (session) headers.set("oai-authenticated-user-id", owner);
      const request = new Request(url, {
        method: incoming.method,
        headers,
        signal: abort.signal,
        ...(!["GET", "HEAD"].includes(incoming.method)
          ? { body: incoming, duplex: "half" }
          : {}),
      });
      let response;
      if (url.pathname === "/auth/callback") {
        if (!session)
          throw new AppError(
            401,
            "LOCAL_SESSION_REQUIRED",
            "Buka Laras di komputer ini, lalu mulai login kembali.",
          );
        try {
          await oauth.callback(url.searchParams);
        } catch (error) {
          oauth.notice =
            error instanceof AppError
              ? error.message
              : "Login ChatGPT gagal. Mulai kembali dari Pengaturan.";
        }
        response = new Response(null, {
          status: 303,
          headers: {
            location: "/#settings",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      } else if (url.pathname.startsWith("/api/chatgpt/")) {
        identity(request, env);
        let result;
        if (url.pathname === "/api/chatgpt/status" && request.method === "GET")
          result = await oauth.status();
        else if (
          url.pathname === "/api/chatgpt/models" &&
          request.method === "GET"
        )
          result = { models: await oauth.models() };
        else if (request.method === "POST") {
          const body = await readJson(request, 2048);
          if (url.pathname === "/api/chatgpt/connect")
            result = await oauth.begin({
              profileId: body.profileId,
              newAccount: body.newAccount === true,
            });
          else if (url.pathname === "/api/chatgpt/model")
            result = await oauth.choose(body.model);
          else if (url.pathname === "/api/chatgpt/select")
            result = await oauth.select(body.id);
          else if (url.pathname === "/api/chatgpt/disconnect")
            result = await oauth.disconnect();
          else throw new AppError(404, "NOT_FOUND", "Operasi tidak ditemukan.");
        } else
          throw new AppError(
            405,
            "METHOD_NOT_ALLOWED",
            "Metode tidak tersedia.",
          );
        response = json({ data: result });
      } else {
        const status = await oauth.status();
        const chatgptActive = !!(
          status.account?.connected &&
          status.account.sharing &&
          status.account.model
        );
        response = await app.fetch(request, {
          ...env,
          LARAS_CHATGPT_STATUS: status,
          LARAS_CHATGPT_ACTIVE: chatgptActive,
          ...(chatgptActive
            ? {
                LARAS_AI_COMPLETION: (values) =>
                  oauth.generate({ ...values, signal: abort.signal }),
              }
            : {}),
        });
      }
      const outputHeaders = Object.fromEntries(response.headers);
      if (url.pathname === "/")
        outputHeaders["set-cookie"] =
          `laras_session=${secret}; Path=/; HttpOnly; SameSite=Lax`;
      outgoing.writeHead(response.status, outputHeaders);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const known = error instanceof AppError;
      const response = json(
        {
          error: {
            code: known ? error.code : "LOCAL_REQUEST_FAILED",
            message: known
              ? error.message
              : "Permintaan lokal belum dapat diproses.",
          },
        },
        known ? error.status : 500,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    baseURL = "http://127.0.0.1:" + server.address().port;
    const store = new SecureStore(directory, key);
    await store.initialize();
    oauth = oauthFactory({
      store,
      callbackURL: baseURL + "/auth/callback",
      fetcher,
    });
    return {
      url: baseURL,
      oauth,
      async close() {
        for (const c of oauth.controllers || []) c.abort();
        await new Promise((resolve) => server.close(resolve));
        db.close?.();
        await release();
      },
    };
  } catch (error) {
    server.close();
    db.close?.();
    await release();
    throw error;
  }
}
