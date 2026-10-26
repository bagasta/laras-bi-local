import { AppError } from "../http.js";

export async function upstream(fetcher, url, options = {}, timeout = 15_000) {
  try {
    const response = await fetcher(url, {
      ...options,
      signal: AbortSignal.timeout(timeout),
      // Workers supports manual/follow only. Never forward credentials on a redirect.
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AppError(
        502,
        "UPSTREAM_REDIRECT",
        "Layanan data mengalihkan permintaan. Koneksi dihentikan; silakan coba kembali nanti.",
      );
    }
    return response;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      error.name === "TimeoutError" || error.name === "AbortError" ? 504 : 503,
      error.name === "TimeoutError" || error.name === "AbortError"
        ? "UPSTREAM_TIMEOUT"
        : "UPSTREAM_UNAVAILABLE",
      error.name === "TimeoutError" || error.name === "AbortError"
        ? "Layanan data terlalu lama merespons. Silakan coba kembali."
        : "Server belum dapat menjangkau layanan data. Silakan coba kembali.",
    );
  }
}

export async function decodeResponse(response) {
  try {
    return await response.json();
  } catch {
    throw new AppError(
      502,
      "UPSTREAM_INVALID",
      "Respons layanan data tidak valid.",
    );
  }
}
