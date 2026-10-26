import { AppError, text } from "../http.js";
import { management } from "../infrastructure/supabase.js";

/** Called by the operator's one-shot provisioning command, never by a public route. */
export async function provisionBusiness(
  env,
  { fetcher = fetch, onCreating = async () => {}, pending = false } = {},
) {
  const organization = text(
    env.SUPABASE_ORGANIZATION_ID,
    "Organisasi Supabase",
    100,
  );
  const name = text(env.SUPABASE_PROJECT_NAME, "Nama proyek", 80);
  const org = await management(
    env,
    `/organizations/${encodeURIComponent(organization)}`,
    {},
    fetcher,
  );
  // Plan is organization-scoped; deprecated {plan:'free'} does NOT enforce free billing.
  if (org.plan !== "free")
    throw new AppError(
      422,
      "FREE_ORGANIZATION_REQUIRED",
      "Gunakan organisasi Supabase berpaket Free. Penyiapan tidak akan mengubah paket atau membuat proyek berbayar.",
    );
  const projects = await management(env, "/projects", {}, fetcher);
  const matches = projects.filter(
    (p) =>
      p.name === name &&
      (p.organization_id === org.id || p.organization_slug === organization),
  );
  if (matches.length > 1)
    throw new AppError(
      409,
      "AMBIGUOUS_PROJECT",
      "Nama proyek tidak unik. Periksa proyek Supabase sebelum melanjutkan.",
    );
  if (matches.length === 1) return { project: matches[0], created: false };
  if (pending)
    throw new AppError(
      409,
      "PROVISION_OUTCOME_UNKNOWN",
      "Permintaan sebelumnya belum dapat dipastikan. Periksa dashboard Supabase; proyek baru tidak dibuat ulang otomatis.",
    );
  await onCreating();
  const password = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const project = await management(
    env,
    "/projects",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        organization_slug: organization,
        db_pass: password,
        region_selection: {
          type: "specific",
          code: env.SUPABASE_REGION || "ap-southeast-1",
        },
        desired_instance_size: "nano",
      }),
    },
    fetcher,
  );
  return { project, created: true };
}
