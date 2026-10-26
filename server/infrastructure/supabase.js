import { AppError } from "../http.js";
import { configuration, supabaseUrl } from "../config.js";
import { upstream, decodeResponse } from "./upstream.js";

const MANAGEMENT = "https://api.supabase.com/v1";
const allowedActions = new Set([
  "bootstrap",
  "dashboard",
  "preview",
  "commit",
  "rollback",
  "preferences",
  "review",
  "catalog",
  "chat_start",
  "chat_finish",
  "history",
  "dataset_get",
  "document_stage",
  "document_get",
  "document_remove",
  "documents_get",
  "batch_preview",
  "batch_commit",
]);

export async function management(env, path, options = {}, fetcher = fetch) {
  if (!env.SUPABASE_ACCESS_TOKEN)
    throw new AppError(
      503,
      "MANAGEMENT_NOT_CONFIGURED",
      "Koneksi pengelolaan Supabase belum dikonfigurasi.",
    );
  const response = await upstream(
    fetcher,
    MANAGEMENT + path,
    {
      ...options,
      headers: {
        authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
        "content-type": "application/json",
        ...options.headers,
      },
    },
    options.method === "POST" ? 30_000 : 15_000,
  );
  if (!response.ok) {
    await response.body?.cancel();
    const failures = {
      401: [
        401,
        "SUPABASE_TOKEN_INVALID",
        "Personal access token Supabase tidak valid atau sudah kedaluwarsa. Gunakan token dari Account → Access Tokens, bukan API key proyek.",
      ],
      403: [
        403,
        "SUPABASE_ACCESS_DENIED",
        "Token Supabase tidak memiliki izin untuk organisasi atau proyek ini. Periksa izin token dan keanggotaan organisasi.",
      ],
      404: [
        422,
        "SUPABASE_RESOURCE_NOT_FOUND",
        path.startsWith("/organizations/")
          ? "Organisasi Supabase tidak ditemukan atau tidak dapat diakses. Periksa token kembali lalu pilih organisasi dari daftar."
          : "Proyek atau layanan Supabase tidak ditemukan. Periksa konfigurasi proyek.",
      ],
      429: [
        429,
        "SUPABASE_RATE_LIMITED",
        "Batas permintaan Supabase tercapai. Coba kembali nanti.",
      ],
    };
    const [status, code, message] = failures[response.status] || [
      503,
      "SUPABASE_MANAGEMENT_ERROR",
      "Supabase belum dapat memproses permintaan. Periksa konfigurasi proyek.",
    ];
    const error = new AppError(status, code, message);
    error.upstreamStatus = response.status;
    throw error;
  }
  return decodeResponse(response);
}

export async function resolveProject(env, fetcher = fetch) {
  if (env.SUPABASE_PROJECT_REF) {
    if (!/^[a-z0-9]{20}$/.test(env.SUPABASE_PROJECT_REF))
      throw new AppError(
        503,
        "CONFIG_INVALID",
        "Referensi proyek Supabase tidak valid.",
      );
    return env.SUPABASE_PROJECT_REF;
  }
  const projects = await management(env, "/projects", {}, fetcher);
  const matches = projects.filter(
    (p) =>
      p.name === env.SUPABASE_PROJECT_NAME &&
      (!env.SUPABASE_ORGANIZATION_ID ||
        p.organization_id === env.SUPABASE_ORGANIZATION_ID ||
        p.organization_slug === env.SUPABASE_ORGANIZATION_ID),
  );
  if (matches.length !== 1)
    throw new AppError(
      503,
      "PROJECT_NOT_READY",
      matches.length
        ? "Terdapat lebih dari satu proyek dengan nama yang sama. Gunakan referensi proyek."
        : "Proyek bisnis belum tersedia. Jalankan penyiapan Supabase.",
    );
  const ref = matches[0].ref || matches[0].id;
  if (!/^[a-z0-9]{20}$/.test(ref))
    throw new AppError(
      502,
      "UPSTREAM_INVALID",
      "Referensi proyek Supabase tidak valid.",
    );
  if (matches[0].status !== "ACTIVE_HEALTHY")
    throw new AppError(
      503,
      "PROJECT_STARTING",
      "Proyek Supabase sedang disiapkan.",
    );
  return ref;
}

// Values become UTF-8 hex literals; no user string is interpolated as SQL syntax.
export function sqlJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const alphabet = new TextEncoder().encode("0123456789abcdef");
  const encoded = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    encoded[i * 2] = alphabet[bytes[i] >> 4];
    encoded[i * 2 + 1] = alphabet[bytes[i] & 15];
  }
  const hex = new TextDecoder().decode(encoded);
  return `convert_from(decode('${hex}','hex'),'UTF8')::jsonb`;
}

export function createRepository(env, fetcher = fetch) {
  let projectPromise;
  async function call(owner, action, payload = {}) {
    if (!allowedActions.has(action))
      throw new Error("Unsupported repository action");
    if (!configuration(env).database)
      throw new AppError(
        503,
        "DATABASE_NOT_CONFIGURED",
        "Koneksi Supabase belum dikonfigurasi.",
      );
    const rpc = rpcFor(action);
    let result;
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      const response = await upstream(
        fetcher,
        supabaseUrl(env) + "/rest/v1/rpc/" + rpc,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            p_owner: owner,
            p_action: action,
            p_payload: payload,
          }),
        },
        25_000,
      );
      result = await decodeResponse(response);
      if (!response.ok)
        throw new AppError(
          503,
          result.code === "PGRST202" ? "SCHEMA_REQUIRED" : "DATABASE_ERROR",
          "Basis data belum siap. Periksa migrasi dan konfigurasi Supabase.",
        );
    } else {
      projectPromise ??= resolveProject(env, fetcher).catch((error) => {
        projectPromise = null;
        throw error;
      });
      const ref = await projectPromise;
      const args = sqlJson({ owner, action, payload });
      const rows = await management(
        env,
        `/projects/${ref}/database/query`,
        {
          method: "POST",
          body: JSON.stringify({
            query: `select public.${rpc}(v->>'owner',v->>'action',v->'payload') as result from (select ${args} as v) as input;`,
          }),
        },
        fetcher,
      );
      result = rows?.[0]?.result;
    }
    if (!result || typeof result !== "object")
      throw new AppError(
        502,
        "UPSTREAM_INVALID",
        "Respons basis data tidak valid.",
      );
    if (result.error)
      throw new AppError(
        result.error.status || 409,
        result.error.code,
        result.error.message,
        result.error.details,
      );
    return result;
  }
  return { call };
}

export const rpcFor = (action) =>
  [
    "bootstrap",
    "dataset_get",
    "rollback",
    "commit",
    "catalog",
    "document_stage",
    "document_get",
    "document_remove",
    "documents_get",
    "batch_preview",
    "batch_commit",
  ].includes(action)
    ? "laras_batch_rpc"
    : "laras_rpc";
