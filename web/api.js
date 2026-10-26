export async function request(path, { method = "GET", body, key } = {}) {
  let response;
  try {
    response = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      signal: AbortSignal.timeout(path === "/chat" ? 100_000 : method === "GET" ? 20_000 : 40_000),
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    const error = new Error(
      "Koneksi ke server terputus. Silakan coba kembali.",
    );
    error.code = "NETWORK_ERROR";
    throw error;
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Respons server tidak valid.");
  }
  if (!response.ok) {
    const error = new Error(result.error?.message || "Permintaan gagal.");
    error.code = result.error?.code;
    error.details = result.error?.details;
    throw error;
  }
  return result.data;
}
