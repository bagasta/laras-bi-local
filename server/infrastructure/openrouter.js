import { AppError, text } from "../http.js";
import { upstream, decodeResponse } from "./upstream.js";
import { sealToken } from "./control.js";
export async function openRouter(path, env, options = {}, fetcher = fetch) {
  const response = await upstream(
    fetcher,
    "https://openrouter.ai/api/v1" + path,
    {
      ...options,
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "x-title": "Laras Business Intelligence",
      },
    },
    options.method === "POST" ? 28_000 : 12_000,
  );
  if (!response.ok) {
    await response.body?.cancel();
    const errors = {
      401: [
        401,
        "OPENROUTER_KEY_INVALID",
        "API key OpenRouter tidak valid atau sudah dicabut.",
      ],
      402: [
        422,
        "OPENROUTER_CREDITS_REQUIRED",
        "Kredit OpenRouter tidak mencukupi untuk model ini. Periksa saldo atau gunakan model gratis.",
      ],
      403: [
        403,
        "OPENROUTER_ACCESS_DENIED",
        "OpenRouter menolak akses. Periksa izin key, model, dan pengaturan akun.",
      ],
      404: [
        422,
        "OPENROUTER_MODEL_UNAVAILABLE",
        "Model OpenRouter tidak ditemukan atau tidak tersedia. Periksa ID model.",
      ],
      429: [
        429,
        "OPENROUTER_RATE_LIMITED",
        "Kuota atau batas permintaan OpenRouter tercapai. Coba kembali nanti.",
      ],
    };
    const [status, code, message] = errors[response.status] || [
      503,
      "OPENROUTER_UNAVAILABLE",
      "Model OpenRouter belum tersedia. Silakan coba kembali.",
    ];
    throw new AppError(status, code, message);
  }
  const data = await decodeResponse(response);
  if (data.error)
    throw new AppError(
      503,
      "OPENROUTER_UNAVAILABLE",
      "OpenRouter belum dapat menyelesaikan permintaan.",
    );
  return data;
}
export async function saveAIConnection(owner, body, env, fetcher, control) {
  const key = text(body.key, "API key OpenRouter", 1000);
  const model = text(body.model || "openrouter/free", "Model", 150);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(model))
    throw new AppError(
      422,
      "INVALID_MODEL",
      "Gunakan ID model OpenRouter yang valid, misalnya openrouter/free.",
    );
  const result = await openRouter(
    "/key",
    { ...env, OPENROUTER_API_KEY: key },
    {},
    fetcher,
  );
  if (!result.data || typeof result.data !== "object")
    throw new AppError(
      502,
      "UPSTREAM_INVALID",
      "Respons verifikasi OpenRouter tidak valid.",
    );
  await control.saveAIConnection(
    owner,
    await sealToken(key, owner + "|openrouter", env),
    model,
  );
  return { configured: true, model, source: "owner" };
}
export async function aiStatus(owner, env, control) {
  const saved = await control?.aiConnection?.(owner);
  return {
    configured: !!saved || !!env.OPENROUTER_API_KEY,
    model: saved?.model || env.OPENROUTER_MODEL || "openrouter/free",
    source: saved ? "owner" : env.OPENROUTER_API_KEY ? "deployment" : "none",
    canConfigure: !!control && !!env.LARAS_ENCRYPTION_KEY,
  };
}
