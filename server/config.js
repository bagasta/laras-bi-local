import { AppError } from "./http.js";

export function configuration(env) {
  const direct = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  const managed = Boolean(
    env.SUPABASE_ACCESS_TOKEN &&
    (env.SUPABASE_PROJECT_REF || env.SUPABASE_PROJECT_NAME),
  );
  return {
    database: direct || managed,
    management: Boolean(env.SUPABASE_ACCESS_TOKEN),
    ai: Boolean(
      env.OPENROUTER_API_KEY ||
      env.LARAS_AI_CONFIGURED ||
      env.LARAS_CHATGPT_ACTIVE,
    ),
    mode: direct
      ? "supabase-rest"
      : managed
        ? "supabase-management"
        : "unconfigured",
  };
}

export function supabaseUrl(env) {
  let url;
  try {
    url = new URL(env.SUPABASE_URL);
  } catch {
    throw new AppError(
      503,
      "CONFIG_INVALID",
      "Konfigurasi Supabase tidak valid.",
    );
  }
  // Avoid forwarding a server credential to an arbitrary destination.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/^([a-z0-9-]+\.)?supabase\.co$/.test(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new AppError(
      503,
      "CONFIG_INVALID",
      "Gunakan URL proyek Supabase resmi.",
    );
  return url.origin;
}
