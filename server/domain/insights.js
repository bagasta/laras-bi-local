import { sha256 } from "../http.js";

export async function deriveInsights(snapshot, now = new Date()) {
  const findings = [];
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const low = snapshot.products.filter((p) => p.stock < p.minimum);
  if (low.length)
    findings.push({
      id: "stock",
      icon: "box",
      title: `${low.length} produk di bawah stok minimum`,
      stat: `${low.length} SKU`,
      evidence: low
        .slice(0, 3)
        .map((p) => `${p.name}: ${p.stock} / ${p.minimum} unit`)
        .join(" · "),
      recommendation:
        "Tinjau penjualan dan produksi sebelum menentukan jumlah pengisian stok.",
      source: [...new Set(low.map((p) => p.source))].join(", "),
      route: "inventory",
      link: "Lihat persediaan",
      priority: "Persediaan",
      tone: "amber",
      question: "Stok perlu diisi?",
    });
  const late = snapshot.production.filter(
    (p) => p.completed < p.qty && p.target < date,
  );
  if (late.length)
    findings.push({
      id: "late",
      icon: "clock",
      title: `${late.length} batch produksi terlambat`,
      stat: `${late.reduce((n, p) => n + p.qty - p.completed, 0)} unit`,
      evidence: late
        .slice(0, 3)
        .map((p) => `${p.id} · ${p.name} · Target ${p.target}`)
        .join(" · "),
      recommendation: "Konfirmasikan estimasi penyelesaian dengan pemasok.",
      source: [...new Set(late.map((p) => p.source))].join(", "),
      route: "production",
      link: "Lihat produksi",
      priority: "Produksi",
      tone: "amber",
      question: "Produksi terlambat?",
    });
  const pending = snapshot.files.filter((f) => f.status !== "Terhubung");
  if (pending.length)
    findings.push({
      id: "fresh",
      icon: "data",
      title: `${pending.length} dokumen perlu ditinjau`,
      stat: `${pending.length} dokumen`,
      evidence: pending
        .slice(0, 3)
        .map((f) => f.name)
        .join(", "),
      recommendation:
        "Periksa hasil pengolahan dokumen sebelum menyertakannya dalam perhitungan.",
      source: pending.map((f) => f.name).join(", "),
      route: "sources",
      link: "Tinjau sumber",
      priority: "Kualitas data",
      tone: "",
      question: "Dokumen apa yang perlu ditinjau?",
    });
  for (const finding of findings)
    finding.fingerprint = await sha256(
      JSON.stringify([
        finding.id,
        finding.id === "stock" ? low : finding.id === "late" ? late : pending,
      ]),
    );
  return findings;
}
