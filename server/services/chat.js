import { adaptiveReply } from "../../web/adaptive.js";
import { AppError, text, sha256 } from "../http.js";
import { groundedAnswer } from "./ai-answer.js";

const currency = (value) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);

export function ruleIntent(question) {
  const q = question.toLowerCase();
  if (/dokumen|invoice|faktur|tinjau/.test(q)) return "documents";
  if (/stok|restock|persediaan/.test(q)) return "stock";
  if (/produksi|batch|terlambat/.test(q)) return "production";
  if (/kanal|channel|platform/.test(q)) return "channels";
  if (/terlaris|laku|teratas|produk/.test(q)) return "products";
  if (/unit|kuantitas/.test(q)) return "units";
  if (/pesanan/.test(q)) return "orders";
  if (/penjualan|omzet|revenue/.test(q)) return "sales";
  if (/ringkasan|kondisi|summary/.test(q)) return "summary";
  return "unsupported";
}

export function factualAnswer(intent, snapshot, question = "") {
  const adaptive = adaptiveReply(snapshot.adaptiveDashboard, question, intent);
  if (adaptive) return adaptive;
  const d = snapshot.dashboard;
  const m = d.metrics;
  const sources = d.sources.map((s) => ({
    id: s.id,
    name: s.name,
    domain: "sales",
  }));
  let title = "",
    lines = [],
    route = "sales";
  switch (intent) {
    case "sales":
      title = `Total penjualan ${currency(m.revenue)}`;
      lines = [`${m.orders} pesanan · ${m.units} unit`];
      break;
    case "orders":
      title = `${m.orders} pesanan`;
      lines = [
        `Nilai rata-rata ${currency(m.orders ? m.revenue / m.orders : 0)}`,
      ];
      break;
    case "units":
      title = `${m.units} unit terjual`;
      lines = [`${m.orders} pesanan · ${currency(m.revenue)}`];
      break;
    case "products":
      title = "Produk teratas berdasarkan penjualan";
      lines = d.products
        .slice(0, 5)
        .map((p) => `${p.name}: ${currency(p.total)} · ${p.units} unit`);
      break;
    case "channels":
      title = "Penjualan per kanal";
      lines = d.channels.map((c) => `${c.name}: ${currency(c.total)}`);
      break;
    case "stock": {
      title = "Persediaan di bawah batas minimum";
      route = "inventory";
      const rows = snapshot.products.filter((p) => p.stock < p.minimum);
      lines = rows
        .slice(0, 5)
        .map((p) => `${p.name}: ${p.stock} unit · minimum ${p.minimum}`);
      sources.splice(
        0,
        sources.length,
        ...rows.map((p) => ({
          name: p.source,
          row: p.source_row,
          domain: "inventory",
        })),
      );
      break;
    }
    case "production": {
      title = "Produksi terlambat";
      route = "production";
      const rows = snapshot.production.filter((p) => p.status === "Terlambat");
      lines = rows
        .slice(0, 5)
        .map(
          (p) =>
            `${p.id} · ${p.name}: ${p.qty - p.completed} unit belum selesai · target ${p.target}`,
        );
      sources.splice(
        0,
        sources.length,
        ...rows.map((p) => ({ name: p.source, domain: "production" })),
      );
      break;
    }
    case "documents":
      title = "Dokumen perlu ditinjau";
      route = "sources";
      lines = snapshot.files
        .filter((f) => f.status !== "Terhubung")
        .map((f) => f.name);
      sources.length = 0;
      break;
    case "summary":
      title = "Ringkasan bisnis";
      lines = [
        `Penjualan ${currency(m.revenue)}`,
        `${m.orders} pesanan · ${m.units} unit`,
        `${d.inventory.low} SKU di bawah stok minimum`,
        `${d.production.late} batch terlambat`,
      ];
      break;
    default:
      title = "Analisis belum didukung";
      route = "sources";
      lines = [
        "Topik tersedia: penjualan, produk, kanal, persediaan, dan produksi.",
      ];
      sources.length = 0;
  }
  if (!lines.length)
    lines = [
      d.rowCount || ["stock", "production", "documents"].includes(intent)
        ? "Tidak ada data yang sesuai."
        : "Belum ada transaksi pada periode ini.",
    ];
  return {
    title,
    lines,
    sources,
    route,
    period: d.period,
    metrics: intent === "unsupported" ? null : m,
  };
}

export async function answerChat({
  body,
  owner,
  requestKey,
  env,
  repository,
  fetcher,
  snapshot,
}) {
  const question = text(body.question, "Pertanyaan", 500);
  const hash = await sha256(
    JSON.stringify({
      question,
      days: body.days || 21,
      datasetId: body.datasetId,
      adaptiveDays: body.adaptiveDays,
      metricKey: body.metricKey,
      dateKey: body.dateKey,
      groupKey: body.groupKey,
    }),
  );
  const reservation = await repository.call(owner, "chat_start", {
    requestKey,
    question,
    hash,
  });
  if (reservation.cached) return { ...reservation.cached, id: reservation.id };
  const intent = ruleIntent(question);
  const facts = factualAnswer(intent, snapshot, question);
  let result = {
    ...facts,
    intent,
    mode: "rules",
    notice: null,
    id: reservation.id,
  };
  if (env.OPENROUTER_API_KEY || env.LARAS_AI_COMPLETION) {
    try {
      const answer = await groundedAnswer(
        question,
        snapshot,
        facts,
        env,
        fetcher,
      );
      result = {
        ...result,
        ...answer,
        mode: "ai",
        provider: env.LARAS_AI_COMPLETION ? "chatgpt" : "openrouter",
        verifiedFacts: ![
          "Analisis belum didukung",
          "Pertanyaan belum didukung",
        ].includes(facts.title)
          ? { title: facts.title, lines: facts.lines, sources: facts.sources }
          : null,
      };
    } catch (error) {
      result.notice =
        (error instanceof AppError ? error.message + " " : "") +
        "Jawaban menggunakan perhitungan dan aturan analisis.";
    }
  }
  await repository.call(owner, "chat_finish", {
    id: reservation.id,
    answer: result,
  });
  return result;
}
