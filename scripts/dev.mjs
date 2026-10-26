import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { localControl } from "./local-control.mjs";
import { createApp } from "../server/app.js";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const assets = {};
async function collect(dir) {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, file.name);
    if (file.isDirectory()) {
      await collect(full);
      continue;
    }
    const binary = file.name.endsWith(".woff2");
    assets["/" + path.relative("web", full).split(path.sep).join("/")] = {
      type: types[path.extname(full)] || "application/octet-stream",
      encoding: binary ? "base64" : "utf8",
      body: (await readFile(full)).toString(binary ? "base64" : "utf8"),
    };
  }
}
await collect("web");
const env = { ...process.env, DB: localControl() };
const app = createApp({
  assets,
  migration:
    (await readFile("supabase/migrations/001_laras.sql", "utf8")) +
    "\n" +
    (await readFile("supabase/migrations/002_multi_documents.sql", "utf8")) +
    "\n" +
    (await readFile("supabase/migrations/003_office_documents.sql", "utf8")),
});
http
  .createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers(incoming.headers);
      // Loopback-only development adapter; the deployed Worker never injects an identity.
      headers.delete("oai-authenticated-user-id");
      if (process.env.LARAS_DEV_USER)
        headers.set("oai-authenticated-user-id", process.env.LARAS_DEV_USER);
      const request = new Request("http://127.0.0.1:3000" + incoming.url, {
        method: incoming.method,
        headers,
        ...(!["GET", "HEAD"].includes(incoming.method)
          ? { body: incoming, duplex: "half" }
          : {}),
      });
      const response = await app.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end("Request failed");
    }
  })
  .listen(3000, "127.0.0.1", () =>
    console.log("Laras development server: http://127.0.0.1:3000"),
  );
