import { mkdir, readFile, writeFile, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { provisionBusiness } from "../server/services/provision.js";
import { management } from "../server/infrastructure/supabase.js";

// Values come from the caller's secret environment, never command-line arguments.
const env = process.env;
const key = createHash("sha256")
  .update(`${env.SUPABASE_ORGANIZATION_ID}:${env.SUPABASE_PROJECT_NAME}`)
  .digest("hex")
  .slice(0, 20);
await mkdir(".laras", { recursive: true });
const lock = `.laras/${key}.lock`,
  journal = `.laras/${key}.json`;
try {
  await mkdir(lock);
} catch {
  console.error(
    "Penyiapan bisnis ini sedang berjalan. Periksa proses sebelumnya.",
  );
  process.exit(1);
}
try {
  let prior = {};
  try {
    prior = JSON.parse(await readFile(journal, "utf8"));
  } catch {}
  const { project, created } = await provisionBusiness(env, {
    pending: prior.status === "creating",
    onCreating: () =>
      writeFile(
        journal,
        JSON.stringify({
          status: "creating",
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      ),
  });
  const ref = project.ref || project.id;
  if (!/^[a-z0-9]{20}$/.test(ref))
    throw new Error("Referensi proyek tidak valid.");
  await writeFile(journal, JSON.stringify({ status: "created", ref }), {
    mode: 0o600,
  });
  console.log(
    `${created ? "Proyek dibuat" : "Proyek yang sama ditemukan"}: ${ref}. Menunggu database siap…`,
  );
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const current = await management(env, `/projects/${ref}`);
    if (current.status === "ACTIVE_HEALTHY") {
      ready = true;
      break;
    }
    if (attempt % 6 === 0) console.log(`Status: ${current.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!ready)
    throw new Error(
      "Database masih disiapkan. Jalankan kembali perintah ini untuk melanjutkan proyek yang sama.",
    );
  const migration =
    (await readFile("supabase/migrations/001_laras.sql", "utf8")) +
    "\n" +
    (await readFile("supabase/migrations/002_multi_documents.sql", "utf8")) +
    "\n" +
    (await readFile("supabase/migrations/003_office_documents.sql", "utf8"));
  await management(env, `/projects/${ref}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query: migration }),
  });
  await writeFile(journal, JSON.stringify({ status: "ready", ref }), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      projectRef: ref,
      projectUrl: `https://${ref}.supabase.co`,
      schemaVersion: 1,
    }),
  );
  console.log(
    "Konfigurasikan SUPABASE_PROJECT_REF pada runtime Laras. Tidak ada kunci atau kata sandi yang ditulis ke berkas atau output.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await rmdir(lock);
}
