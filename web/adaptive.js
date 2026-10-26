import { parseNumber } from "./csv.js";
const normalized = (value) =>
  String(value)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
const label = (value) =>
  String(value)
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
const present = (value) =>
  value !== null && value !== undefined && String(value).trim() !== "";
export function asDate(value) {
  const text = String(value ?? "").trim();
  let match;
  if ((match = text.match(/^(\d{4})[-/](\d{2})(?:[-/](\d{2}))?(?:T.*)?$/))) {
    const result = `${match[1]}-${match[2]}-${match[3] || "01"}`;
    const date = new Date(result + "T00:00:00Z");
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === result
      ? result
      : null;
  }
  if ((match = text.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/)))
    return asDate(`${match[3]}-${match[2]}-${match[1]}`);
  return null;
}
export function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "")
    .trim()
    .replace(/^(USD|IDR|EUR|Rp|\$|€)\s*/i, "")
    .replace(/%$/, "");
  if (!text || !/^[-+\d.,\s]+$/.test(text)) return null;
  const result = parseNumber(text);
  return Number.isFinite(result) ? result : null;
}
export function inferColumns(headers, rows) {
  return headers.map((header, index) => {
    const name = normalized(header);
    const values = rows.map((r) => r.values[index]).filter(present);
    const sample = values.slice(0, 1000);
    let role = /((^|_)(id|kode|nomor|no|nik|phone|telepon|rekening)(_|$))/.test(
      name,
    )
      ? "identifier"
      : /(deadline|tenggat|target|due_date)/.test(name)
        ? "deadline"
        : /(status|keadaan|progress|progres)/.test(name)
          ? "status"
          : /(proyek|project|klien|client|customer|pelanggan|pasien|pegawai|karyawan|booking|reservasi|nama)/.test(
                name,
              )
            ? "entity"
            : /(pendapatan|revenue|omzet|income|fee|biaya|cost|expense|gaji|salary|nilai|amount|harga|price|budget|anggaran|total|tarif)/.test(
                  name,
                )
              ? "money"
              : /(jam|hours|durasi|duration|menit)/.test(name)
                ? "duration"
                : "category";
    const financialNames =
      /(pendapatan|revenue|omzet|income|fee|biaya|cost|expense|gaji|salary|amount|harga|price|budget|anggaran|tarif|nilai_kontrak|nilai_transaksi|nominal|pembayaran|penjualan)/;
    if (!["identifier", "deadline"].includes(role)) {
      if (/(jam|hours|durasi|duration|menit)/.test(name)) role = "duration";
      else if (
        /(^|_)(jumlah|count|qty|quantity|unit|tiket|skor|score|nilai_ujian)(_|$)/.test(
          name,
        ) &&
        !/(harga|price)/.test(name)
      )
        role = "measure";
      else if (
        role === "money" &&
        !financialNames.test(name) &&
        !sample.some((v) => /^\s*(Rp|IDR|USD|EUR|\$|€)/i.test(String(v)))
      ) {
        const tableMoney = headers.some(
          (h) =>
            financialNames.test(normalized(h)) ||
            /(order|pesanan|invoice)/.test(normalized(h)),
        );
        if (!(name === "total" && tableMoney)) role = "category";
      }
      if (
        /(progress|progres)/.test(name) &&
        sample.every((v) => asNumber(v) !== null)
      )
        role = "measure";
    }
    if (/^(tahun|year|kode_pos|postal_code)$/.test(name)) role = "identifier";
    let type =
      sample.length &&
      sample.filter((v) => asDate(v) !== null).length / sample.length >= 0.8
        ? "date"
        : sample.length &&
            sample.filter((v) => asNumber(v) !== null).length / sample.length >=
              0.9
          ? "number"
          : "text";
    if (
      role === "identifier" ||
      role === "status" ||
      (role === "entity" && !/(jumlah|count|total)_/.test(name))
    )
      type = "text";
    if (type === "date" && role !== "deadline") role = "date";
    if (type === "text" && role === "money") role = "category";
    const percent =
      sample.some((v) => String(v).includes("%")) ||
      /(persen|percent|rate_persen)/.test(name);
    return {
      key: "c" + index,
      label: label(header),
      type,
      role,
      format: percent
        ? "percent"
        : type === "number" && role === "money"
          ? "currency"
          : "number",
      currency:
        /usd|dolar/.test(name) ||
        sample.some((v) => /^\s*(USD|\$)/i.test(String(v)))
          ? "USD"
          : /eur|euro/.test(name)
            ? "EUR"
            : "IDR",
      aggregation:
        percent ||
        /(unit_price|harga_satuan|tarif|rate|rata_rata|skor|score|nilai_ujian|progress|progres)/.test(
          name,
        )
          ? "avg"
          : "sum",
    };
  });
}
export function contextFor(columns) {
  const names = columns.map((c) => normalized(c.label)).join(" ");
  if (/(pasien|diagnosa|kunjungan|klinik)/.test(names))
    return "Layanan dan kunjungan";
  if (/(kamar|room|menginap|malam)/.test(names))
    return "Reservasi dan akomodasi";
  if (/(reservasi|booking)/.test(names)) return "Reservasi";
  if (/(proyek|project)/.test(names)) return "Proyek dan layanan";
  if (/(klien|client)/.test(names)) return "Klien dan operasional";
  if (/(pegawai|karyawan|gaji|salary|absensi)/.test(names))
    return "Tim dan operasional";
  if (/(produksi|batch|supplier|pemasok)/.test(names)) return "Produksi";
  if (/(stok|stock|minimum|gudang)/.test(names)) return "Persediaan";
  if (/(penjualan|order|pesanan|sales|sku)/.test(names)) return "Penjualan";
  if (/(layanan|service|durasi|hours|jam)/.test(names)) return "Layanan";
  if (
    /(pendapatan|income|expense|biaya|anggaran|budget|saldo|debit|kredit)/.test(
      names,
    )
  )
    return "Keuangan";
  return "Ringkasan data";
}
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
export function formatAdaptive(value, format = "number", currency = "IDR") {
  if (format === "currency")
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "IDR" ? 0 : 2,
    })
      .format(value)
      .replaceAll("\u00a0", " ");
  if (format === "percent")
    return (
      new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(
        value,
      ) + "%"
    );
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(
    value,
  );
}
function aggregate(rows, measure) {
  const values = measure
    ? rows
        .map((r) => asNumber(r.values[measure.index]))
        .filter((v) => v !== null)
    : [];
  return !measure
    ? rows.length
    : measure.aggregation === "avg"
      ? values.length
        ? round(values.reduce((a, b) => a + b, 0) / values.length)
        : 0
      : round(values.reduce((a, b) => a + b, 0));
}
export function buildAdaptiveModel(
  dataset,
  {
    metricKey,
    dateKey,
    groupKey,
    days = "all",
    offset = 0,
    now = new Date(),
  } = {},
) {
  const columns = dataset.columns.map((c, index) => ({ ...c, index }));
  const numeric = columns.filter(
    (c) => c.type === "number" && c.role !== "identifier",
  );
  const dates = columns.filter((c) => c.type === "date");
  const categories = columns.filter(
    (c) =>
      c.type === "text" &&
      c.role !== "identifier" &&
      new Set(dataset.rows.map((r) => r.values[c.index]).filter(present)).size >
        1,
  );
  const preferred =
    numeric.find((c) =>
      /(pendapatan|revenue|nilai.kontrak|amount|total|fee|income|nilai)/i.test(
        c.label,
      ),
    ) ||
    numeric.find((c) => c.role === "money" && c.aggregation !== "avg") ||
    numeric.find((c) => c.role === "duration") ||
    numeric[0];
  const measure =
    metricKey === "count"
      ? null
      : numeric.find((c) => c.key === metricKey) || preferred || null;
  const date =
    dateKey === "none"
      ? null
      : dates.find((c) => c.key === dateKey) ||
        dates.find((c) => c.role !== "deadline") ||
        dates[0] ||
        null;
  const group =
    groupKey === "none"
      ? null
      : categories.find((c) => c.key === groupKey) ||
        categories.find((c) =>
          /(layanan|service|kategori|departemen|cabang|status|jenis)/i.test(
            c.label,
          ),
        ) ||
        categories[0] ||
        null;
  let rows = dataset.rows;
  let from = null,
    to = null;
  const allDates = date
    ? rows
        .map((r) => asDate(r.values[date.index]))
        .filter(Boolean)
        .sort()
    : [];
  if (date && days !== "all" && allDates.length) {
    const start = new Date(allDates.at(-1) + "T00:00:00Z");
    start.setUTCDate(start.getUTCDate() - Number(days) + 1);
    const minimum = start.toISOString().slice(0, 10);
    rows = rows.filter((r) => {
      const d = asDate(r.values[date.index]);
      return d && d >= minimum;
    });
  }
  const selectedDates = date
    ? rows
        .map((r) => asDate(r.values[date.index]))
        .filter(Boolean)
        .sort()
    : [];
  from = selectedDates[0] || null;
  to = selectedDates.at(-1) || null;
  offset = Math.min(
    Math.max(0, Math.floor(Number(offset) || 0)),
    Math.max(0, Math.floor((rows.length - 1) / 50) * 50),
  );
  const total = aggregate(rows, measure);
  const kpis = [];
  const sources = {
    datasetId: dataset.id,
    name: dataset.name,
    part: dataset.part_name || "",
    sourceId: dataset.source_id,
    documentId: dataset.document_id,
  };
  const addKpi = (
    name,
    value,
    field,
    format = "number",
    aggregation = "count",
    currency = "IDR",
  ) => {
    if (kpis.length < 4)
      kpis.push({
        label: name,
        value,
        field,
        format,
        aggregation,
        currency,
        source: sources,
      });
  };
  if (!measure) addKpi("Baris data", rows.length, null);
  if (measure)
    addKpi(
      measure.aggregation === "sum" && /^total( |$)/i.test(measure.label)
        ? measure.label
        : `${measure.aggregation === "avg" ? "Rata-rata" : "Total"} ${measure.label}`,
      total,
      measure.key,
      measure.format,
      measure.aggregation,
      measure.currency,
    );
  const entity =
    columns.find(
      (c) =>
        /(project|proyek|reservasi|booking|pasien|pegawai|karyawan)/i.test(
          c.label,
        ) && c.role === "entity",
    ) || columns.find((c) => c.role === "identifier");
  if (entity)
    addKpi(
      entity.label,
      new Set(rows.map((r) => r.values[entity.index]).filter(present)).size,
      entity.key,
      "number",
      "distinct",
    );
  const client = columns.find((c) =>
    /(klien|client|pelanggan|customer)/i.test(c.label),
  );
  if (client && client !== entity)
    addKpi(
      client.label,
      new Set(rows.map((r) => r.values[client.index]).filter(present)).size,
      client.key,
      "number",
      "distinct",
    );
  const duration = numeric.find(
    (c) => c.role === "duration" && c.key !== measure?.key,
  );
  if (duration)
    addKpi(
      `Total ${duration.label}`,
      aggregate(rows, duration),
      duration.key,
      duration.format,
      duration.aggregation,
      duration.currency,
    );
  const status = columns.find((c) => c.role === "status");
  const completed = (value) =>
    /^(selesai|completed|done|lunas|paid|closed)$/i.test(String(value).trim());
  if (status) {
    const done = rows.filter((r) => completed(r.values[status.index]));
    if (done.length)
      addKpi(
        "Status " + String(done[0].values[status.index]),
        done.length,
        status.key,
        "number",
        "count matching",
      );
  }
  if (!kpis.some((k) => k.label === "Baris data"))
    addKpi("Baris data", rows.length, null);
  const trend = [];
  if (date) {
    const grouped = new Map();
    const monthly =
      selectedDates.length > 0 && new Set(selectedDates).size > 60;
    for (const row of rows) {
      const value = asDate(row.values[date.index]);
      if (!value) continue;
      const key = monthly ? value.slice(0, 7) : value;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    for (const [key, list] of [...grouped].sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      trend.push({ date: key, value: aggregate(list, measure) });
  }
  const grouped = new Map();
  if (group) {
    for (const row of rows) {
      const key =
        String(row.values[group.index] ?? "").trim() || "Tanpa kategori";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
  }
  const breakdown = [...grouped]
    .map(([name, list]) => ({
      name,
      value: aggregate(list, measure),
      count: list.length,
    }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const findings = [];
  const deadline = columns.find((c) => c.role === "deadline");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  if ((dataset.domain || "dataset") === "dataset" && deadline && status) {
    const late = rows.filter((r) => {
      const due = asDate(r.values[deadline.index]);
      return due && due < today && !completed(r.values[status.index]);
    });
    if (late.length)
      findings.push({
        id: "data-deadline-" + dataset.id,
        icon: "clock",
        title: `${late.length} tenggat terlewati`,
        stat: `${late.length} baris`,
        evidence: late
          .slice(0, 3)
          .map(
            (r) =>
              String(r.values[entity?.index ?? 0]) +
              " · " +
              r.values[deadline.index],
          )
          .join(" · "),
        recommendation: `Tinjau ${deadline.label.toLowerCase()} dan ${status.label.toLowerCase()} pada sumber ini.`,
        source: dataset.name,
        route: "records",
        link: "Lihat data",
        priority: "Tindak lanjut",
        tone: "amber",
        question: "Ringkasan tenggat pada data ini?",
      });
  }
  if ((dataset.domain || "dataset") === "dataset" && measure) {
    const missing = rows.filter(
      (r) => asNumber(r.values[measure.index]) === null,
    ).length;
    if (missing)
      findings.push({
        id: "data-values-" + dataset.id,
        icon: "warning",
        title: `${missing} baris tanpa nilai ${measure.label.toLowerCase()}`,
        stat: String(missing),
        evidence: `Perhitungan ${measure.label.toLowerCase()} menggunakan ${rows.length - missing} baris bernilai valid.`,
        recommendation: "Periksa nilai pada berkas sumber.",
        source: dataset.name,
        route: "records",
        link: "Periksa data",
        priority: "Kualitas data",
        tone: "amber",
        question: "Ringkasan kualitas data ini?",
      });
  }
  if ((dataset.domain || "dataset") === "dataset" && date) {
    const missing = dataset.rows.filter(
      (r) => !asDate(r.values[date.index]),
    ).length;
    if (missing)
      findings.push({
        id: "data-dates-" + dataset.id,
        icon: "warning",
        title: `${missing} baris tanpa tanggal valid`,
        stat: String(missing),
        evidence: `Grafik waktu memakai nilai valid pada ${date.label}. Baris asli tetap tersimpan.`,
        recommendation: "Periksa format tanggal pada sumber.",
        source: dataset.name,
        route: "records",
        link: "Periksa data",
        priority: "Kualitas data",
        tone: "amber",
        question: "Ringkasan kualitas data?",
      });
  }
  return {
    context: contextFor(columns),
    dataset: {
      ...sources,
      id: dataset.id,
      label:
        dataset.label ||
        dataset.name + (dataset.part_name ? " · " + dataset.part_name : ""),
      domain: dataset.domain || "dataset",
    },
    kpis,
    stats: numeric.map((c) => {
      const values = rows
        .map((r) => asNumber(r.values[c.index]))
        .filter((v) => v !== null);
      return {
        key: c.key,
        label: c.label,
        format: c.format,
        currency: c.currency,
        sum: round(values.reduce((a, b) => a + b, 0)),
        avg: values.length
          ? round(values.reduce((a, b) => a + b, 0) / values.length)
          : 0,
        min: values.length ? Math.min(...values) : 0,
        max: values.length ? Math.max(...values) : 0,
      };
    }),
    period: { from, to, days, dateLabel: date?.label || null },
    selection: {
      metricKey: measure?.key || "count",
      dateKey: date?.key || "none",
      groupKey: group?.key || "none",
      days,
    },
    options: {
      metrics: numeric.map((c) => ({ key: c.key, label: c.label })),
      dates: dates.map((c) => ({ key: c.key, label: c.label })),
      groups: categories.map((c) => ({ key: c.key, label: c.label })),
    },
    trend: {
      title: measure
        ? `${measure.label} menurut ${date?.label || "tanggal"}`
        : "Jumlah baris menurut " + (date?.label || "tanggal"),
      points: trend,
      format: measure?.format || "number",
      currency: measure?.currency || "IDR",
    },
    breakdown: {
      title:
        (measure?.label || "Jumlah baris") +
        " per " +
        (group?.label || "kategori"),
      items: breakdown.slice(0, 7),
      totalGroups: breakdown.length,
      format: measure?.format || "number",
      currency: measure?.currency || "IDR",
    },
    table: {
      columns: columns.map(({ index, ...c }) => c),
      rows: rows
        .slice(offset, offset + 50)
        .map((r) => ({ row: r.line, values: r.values })),
      total: rows.length,
      offset,
    },
    findings,
  };
}
export function demoDatasets(orders = []) {
  const day = (offset) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const make = (id, name, headers, values, domain = "dataset") => {
    const rows = values.map((values, index) => ({ line: index + 2, values }));
    return {
      id,
      name: id.replace("demo-", "contoh_") + ".csv",
      label: name,
      domain,
      headers,
      columns: inferColumns(headers, rows),
      rows,
      row_count: rows.length,
      part_name: "",
    };
  };
  return [
    make(
      "demo-projects",
      "Contoh: proyek layanan",
      [
        "Tanggal",
        "Proyek",
        "Klien",
        "Nilai kontrak",
        "Jam kerja",
        "Status",
        "Tenggat",
      ],
      [
        [
          day(-15),
          "Desain merek",
          "Studio A",
          25000000,
          80,
          "Selesai",
          day(-5),
        ],
        [
          day(-10),
          "Pengembangan aplikasi",
          "Koperasi B",
          48000000,
          120,
          "Berjalan",
          day(-2),
        ],
        [
          day(-3),
          "Riset pelanggan",
          "Klinik C",
          18000000,
          36,
          "Berjalan",
          day(8),
        ],
      ],
    ),
    make(
      "demo-staff",
      "Contoh: operasional tim",
      ["Tanggal", "Pegawai", "Departemen", "Jam kerja", "Biaya operasional"],
      [
        [day(-7), "Tim A", "Operasional", 32, 2400000],
        [day(-4), "Tim B", "Administrasi", 28, 1800000],
        [day(-1), "Tim C", "Operasional", 35, 2100000],
      ],
    ),
    make(
      "demo-reservations",
      "Contoh: reservasi",
      ["Tanggal", "Booking", "Jenis kamar", "Malam", "Pendapatan"],
      [
        [day(-6), "R-001", "Studio", 2, 1400000],
        [day(-3), "R-002", "Suite", 3, 4500000],
        [day(-1), "R-003", "Studio", 1, 700000],
      ],
    ),
    make(
      "demo-sales",
      "Contoh: penjualan",
      ["ID pesanan", "Tanggal", "SKU", "Produk", "Jumlah", "Total", "Kanal"],
      orders.map((o) => [
        o.id,
        o.date,
        o.sku,
        o.product,
        o.quantity,
        o.total,
        o.channel,
      ]),
      "sales",
    ),
  ];
}

export function adaptiveReply(model, question, intent = "summary") {
  if (!model || !["dataset", "documents"].includes(model.dataset.domain))
    return null;
  const q = String(question).toLowerCase();
  const unsupported = () => ({
    title: "Pertanyaan belum didukung",
    lines: [
      "Kolom tersedia: " +
        model.table.columns
          .slice(0, 7)
          .map((c) => c.label)
          .join(", "),
    ],
    sources: [
      {
        id: model.dataset.sourceId,
        name: model.dataset.name,
        domain: "records",
      },
    ],
    route: "records",
    period: model.period,
    metrics: null,
  });
  if (/\b(hapus|delete|drop|password|token|kredensial)\b/.test(q))
    return unsupported();
  const words = (value) =>
    normalized(value)
      .split("_")
      .filter((w) => w.length > 2);
  const stat = (model.stats || [])
    .map((s) => ({
      s,
      score: words(s.label).filter((w) => q.includes(w)).length,
    }))
    .filter((x) => x.score)
    .sort((a, b) => b.score - a.score)[0]?.s;
  const kpi = model.kpis.find((k) =>
    words(k.label)
      .filter((w) => !["total", "rata", "data"].includes(w))
      .some((w) => q.includes(w)),
  );
  const relevant =
    stat ||
    kpi ||
    /ringkasan|summary|data|total|jumlah|analisis|kondisi|tenggat|deadline|kualitas/.test(
      q,
    );
  if (!relevant) return unsupported();
  let title = model.context,
    lines;
  if (/tenggat|deadline/.test(q) && model.findings.length)
    lines = model.findings.map((f) => f.title + " · " + f.evidence);
  else if (stat) {
    const kind = /rata|average/.test(q)
      ? "avg"
      : /tertinggi|maksimum|maximum/.test(q)
        ? "max"
        : /terendah|minimum/.test(q)
          ? "min"
          : "sum";
    const label = {
      sum: "Total",
      avg: "Rata-rata",
      min: "Minimum",
      max: "Maksimum",
    }[kind];
    title = label + " " + stat.label;
    lines = [formatAdaptive(stat[kind], stat.format, stat.currency)];
  } else if (kpi) {
    title = kpi.label;
    lines = [formatAdaptive(kpi.value, kpi.format, kpi.currency)];
  } else
    lines = model.kpis.map(
      (k) => k.label + ": " + formatAdaptive(k.value, k.format, k.currency),
    );
  return {
    title,
    lines,
    sources: [
      {
        id: model.dataset.sourceId,
        name: model.dataset.name,
        part: model.dataset.part,
        datasetId: model.dataset.id,
        domain: "records",
      },
    ],
    route: "records",
    period: model.period,
    metrics: null,
  };
}
