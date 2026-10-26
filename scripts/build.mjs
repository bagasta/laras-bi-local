import { build } from "esbuild";
import { readFile, readdir, mkdir, rm, copyFile } from "node:fs/promises";
import path from "node:path";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const assets = {};
async function collect(directory) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, file.name);
    if (file.isDirectory()) {
      await collect(full);
      continue;
    }
    const extension = path.extname(file.name);
    const binary = extension === ".woff2";
    assets["/" + path.relative("web", full).split(path.sep).join("/")] = {
      type: types[extension] || "application/octet-stream",
      encoding: binary ? "base64" : "utf8",
      body: (await readFile(full)).toString(binary ? "base64" : "utf8"),
    };
  }
}
await collect("web");
await rm("dist", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });
await mkdir("dist/.openai", { recursive: true });
await build({
  entryPoints: ["server/entry.js"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  loader: { ".sql": "text" },
  minifyWhitespace: true,
  legalComments: "external",
  plugins: [
    {
      name: "sites-assets",
      setup(builder) {
        builder.onResolve({ filter: /^sites:assets$/ }, () => ({
          path: "assets",
          namespace: "sites",
        }));
        builder.onLoad({ filter: /.*/, namespace: "sites" }, () => ({
          contents: "export default " + JSON.stringify(assets),
          loader: "js",
        }));
      },
    },
  ],
});
await (await import("node:fs/promises")).writeFile("dist/.openai/hosting.json", JSON.stringify({d1:"DB"}));
await mkdir("dist/drizzle", { recursive: true });
for (const file of await readdir("drizzle"))
  if (file.endsWith(".sql"))
    await copyFile("drizzle/" + file, "dist/drizzle/" + file);

const worker = await import("../dist/server/index.js?" + Date.now());
if (typeof worker.default?.fetch !== "function")
  throw new Error("Worker fetch export missing");
const response = await worker.default.fetch(
  new Request("https://laras.test/api/health"),
  {},
);
if (response.status !== 200) throw new Error("Worker health validation failed");
const home = await worker.default.fetch(new Request("https://laras.test/"), {});
if (!(await home.text()).includes('id="app"'))
  throw new Error("Static asset validation failed");
console.log(
  `Built and validated Worker with ${Object.keys(assets).length} embedded assets.`,
);
