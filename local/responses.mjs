import { AppError } from "../server/http.js";

export function responseError(code) {
  if (code === "subscription_sharing_usage_limit_exceeded")
    return new AppError(
      429,
      "CHATGPT_USAGE_LIMIT",
      "Batas penggunaan paket ChatGPT tercapai. Buka ChatGPT Settings → Usage.",
    );
  if (code === "subscription_sharing_usage_unavailable")
    return new AppError(
      403,
      "CHATGPT_PLAN_UNAVAILABLE",
      "Penggunaan paket ChatGPT belum tersedia untuk akun atau workspace ini.",
    );
  return new AppError(
    503,
    "CHATGPT_INFERENCE_FAILED",
    "ChatGPT belum dapat menyelesaikan jawaban. Coba lagi atau periksa akses model.",
  );
}
export async function completedText(response) {
  if (!response.body) throw responseError();
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    text = "",
    size = 0,
    completed = false;
  function event(block) {
    const raw = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!raw || raw === "[DONE]") return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new AppError(
        502,
        "CHATGPT_STREAM_INVALID",
        "Stream jawaban ChatGPT tidak valid.",
      );
    }
    if (data.type === "response.output_text.delta") {
      text += data.delta || "";
      if (text.length > 16000)
        throw new AppError(
          502,
          "CHATGPT_OUTPUT_LIMIT",
          "Jawaban ChatGPT terlalu panjang. Persempit pertanyaan.",
        );
    }
    if (["response.failed", "error"].includes(data.type))
      throw responseError(
        data.response?.error?.code || data.error?.code || data.code,
      );
    if (data.type === "response.incomplete")
      throw new AppError(
        502,
        "CHATGPT_INCOMPLETE",
        "Jawaban ChatGPT belum selesai. Coba pertanyaan yang lebih singkat.",
      );
    if (data.type === "response.completed") {
      if (data.response?.status && data.response.status !== "completed")
        throw responseError();
      if (!text)
        text = (data.response?.output || [])
          .flatMap((item) => item.content || [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text || "")
          .join("");
      completed = true;
    }
  }
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) event(buffer);
        break;
      }
      size += value.byteLength;
      if (size > 1_000_000)
        throw new AppError(
          502,
          "CHATGPT_STREAM_LIMIT",
          "Stream ChatGPT melebihi batas pemrosesan.",
        );
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll(
        "\r\n",
        "\n",
      );
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        event(block);
        if (completed) break;
      }
      if (buffer.length > 200000)
        throw new AppError(
          502,
          "CHATGPT_STREAM_LIMIT",
          "Event ChatGPT terlalu besar.",
        );
    }
    if (!completed || !text.trim())
      throw new AppError(
        502,
        "CHATGPT_INTERRUPTED",
        "Koneksi terputus sebelum ChatGPT menyelesaikan jawaban.",
      );
    if (text.length > 16000)
      throw new AppError(
        502,
        "CHATGPT_OUTPUT_LIMIT",
        "Jawaban ChatGPT terlalu panjang. Persempit pertanyaan.",
      );
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
