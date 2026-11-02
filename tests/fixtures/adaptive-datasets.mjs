import { inferColumns } from "../../web/adaptive.js";

export function sampleDatasets() {
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
  ];
}
