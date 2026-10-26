import { AppError, text, sha256 } from "../http.js";
import { ControlStore, sealToken } from "../infrastructure/control.js";
import { management } from "../infrastructure/supabase.js";
import { provisionBusiness } from "./provision.js";

export async function listCloudOrganizations(body, env, fetcher) {
  const token = text(body.token, "Token Supabase", 1000);
  const rows = await management(
    { ...env, SUPABASE_ACCESS_TOKEN: token },
    "/organizations",
    {},
    fetcher,
  );
  if (!Array.isArray(rows) || rows.length > 500)
    throw new AppError(
      502,
      "UPSTREAM_INVALID",
      "Daftar organisasi Supabase tidak valid.",
    );
  const organizations = [];
  for (const row of rows) {
    const slug = row?.slug || row?.id;
    if (
      typeof slug !== "string" ||
      !/^[\w-]{1,100}$/.test(slug) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 200
    )
      throw new AppError(
        502,
        "UPSTREAM_INVALID",
        "Daftar organisasi Supabase tidak valid.",
      );
    if (!organizations.some((org) => org.slug === slug))
      organizations.push({ slug, name: row.name.trim() });
  }
  return {
    organizations: organizations.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function saveCloudConnection(
  owner,
  body,
  env,
  fetcher,
  store = new ControlStore(env.DB),
) {
  const token = text(body.token, "Token Supabase", 1000);
  let organization = text(body.organization, "Organisasi", 500);
  if (organization.startsWith("https://")) {
    try {
      const url = new URL(organization);
      const match = url.pathname.match(/^\/dashboard\/org\/([\w-]+)(?:\/|$)/);
      if (url.hostname !== "supabase.com" || !match) throw new Error();
      organization = match[1];
    } catch {
      throw new AppError(
        422,
        "INVALID_ORGANIZATION",
        "Gunakan ID/slug organisasi atau URL pengaturan organisasi Supabase.",
      );
    }
  }
  if (!/^[\w-]{1,100}$/.test(organization))
    throw new AppError(
      422,
      "INVALID_ORGANIZATION",
      "Gunakan ID/slug organisasi setelah /org/ pada URL dashboard Supabase.",
    );
  const projectName = text(body.projectName, "Nama proyek", 80);
  const org = await management(
    { ...env, SUPABASE_ACCESS_TOKEN: token },
    "/organizations/" + encodeURIComponent(organization),
    {},
    fetcher,
  );
  if (org.plan !== "free")
    throw new AppError(
      422,
      "FREE_ORGANIZATION_REQUIRED",
      "Pilih organisasi dengan paket Supabase Free.",
    );
  await store.saveConnection(owner, {
    encryptedToken: await sealToken(token, owner, env),
    organization,
    projectName,
  });
  return { saved: true, organization, projectName };
}
export function publicJob(job) {
  return {
    phase: job?.phase || "pending",
    projectRef: job?.project_ref || null,
    errorCode: job?.error_code || null,
    retryAfter: 5,
  };
}
export async function advanceProvisioning(
  owner,
  env,
  migration,
  fetcher,
  store = new ControlStore(env.DB),
) {
  if (
    !env.SUPABASE_ACCESS_TOKEN ||
    !env.SUPABASE_ORGANIZATION_ID ||
    !env.SUPABASE_PROJECT_NAME
  )
    throw new AppError(
      503,
      "SUPABASE_CONNECTION_REQUIRED",
      "Hubungkan akun Supabase untuk membuat proyek bisnis.",
    );
  await store.ensureJob(owner);
  let job = await store.job(owner);
  const schemaHash = await sha256(migration);
  if (job.phase === "ready" && job.schema_hash === schemaHash)
    return publicJob(job);
  const lease = await store.lease(owner);
  if (!lease)
    return {
      ...publicJob(job),
      ...(job.phase === "ready" ? { phase: "migrating" } : {}),
      busy: true,
    };
  const token = lease.lease_owner;
  job = lease;
  try {
    if (job.phase === "ready")
      await store.update(owner, token, { phase: "migrating", errorCode: null });
    if (!job.project_ref) {
      const result = await provisionBusiness(env, {
        fetcher,
        pending: !!job.create_attempted,
        onCreating: async () => {
          await store.update(owner, token, {
            phase: "creating",
            createAttempted: 1,
            errorCode: null,
          });
          job.create_attempted = 1;
        },
      });
      const ref = result.project.ref || result.project.id;
      if (!/^[a-z0-9]{20}$/.test(ref))
        throw new AppError(
          502,
          "UPSTREAM_INVALID",
          "Referensi proyek Supabase tidak valid.",
        );
      await store.update(owner, token, {
        phase: "starting",
        projectRef: ref,
        errorCode: null,
      });
      return publicJob(await store.job(owner));
    }
    const project = await management(
      env,
      "/projects/" + job.project_ref,
      {},
      fetcher,
    );
    if (project.status !== "ACTIVE_HEALTHY") {
      await store.update(owner, token, { phase: "starting", errorCode: null });
      return publicJob(await store.job(owner));
    }
    await store.update(owner, token, { phase: "migrating", errorCode: null });
    await management(
      env,
      `/projects/${job.project_ref}/database/query`,
      { method: "POST", body: JSON.stringify({ query: migration }) },
      fetcher,
    );
    await store.rememberProject(owner, job.project_ref);
    await store.update(owner, token, {
      phase: "ready",
      errorCode: null,
      schemaHash,
    });
    return publicJob(await store.job(owner));
  } catch (error) {
    const rejected = error.upstreamStatus >= 400 && error.upstreamStatus < 500;
    await store.update(owner, token, {
      phase:
        job.create_attempted && !job.project_ref && !rejected
          ? "uncertain"
          : "failed",
      ...(rejected && !job.project_ref ? { createAttempted: 0 } : {}),
      errorCode: error.code || "PROVISION_FAILED",
    });
    throw error;
  } finally {
    await store.release(owner, token);
  }
}
