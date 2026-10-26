export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data, status = 200, requestId) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}

export async function readJson(request, maxBytes = 2_200_000) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError(415, "JSON_REQUIRED", "Gunakan format JSON.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError(400, "EMPTY_BODY", "Data permintaan diperlukan.");
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new AppError(
          413,
          "BODY_TOO_LARGE",
          "Ukuran permintaan melebihi batas.",
        );
      }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    const value = JSON.parse(new TextDecoder().decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "INVALID_JSON", "Data JSON tidak valid.");
  }
}

export function identity(request, env) {
  const id = request.headers.get("oai-authenticated-user-id");
  if (!id || id.length > 200)
    throw new AppError(
      401,
      "AUTH_REQUIRED",
      "Silakan masuk untuk melanjutkan.",
    );
  if (env.LARAS_OWNER_ID && id !== env.LARAS_OWNER_ID)
    throw new AppError(
      403,
      "FORBIDDEN",
      "Anda tidak memiliki akses ke bisnis ini.",
    );
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (
      (origin && origin !== new URL(request.url).origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new AppError(
        403,
        "ORIGIN_REJECTED",
        "Permintaan lintas situs ditolak.",
      );
  }
  return id;
}

export function integer(value, fallback = 21, min = 1, max = 366) {
  if (value === undefined || value === null) return fallback;
  if (!/^\d+$/.test(String(value)))
    throw new AppError(422, "INVALID_PERIOD", "Periode analisis tidak valid.");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new AppError(422, "INVALID_PERIOD", "Periode analisis tidak valid.");
  return result;
}

export function text(value, name, max = 200) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new AppError(422, "INVALID_FIELD", `${name} tidak valid.`);
  return value.trim();
}

export function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new AppError(422, "INVALID_ID", "ID tidak valid.");
  return value;
}

export async function sha256(value) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
