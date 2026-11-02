# Laras — Business Intelligence Lokal

Dashboard yang menyesuaikan sumber data bisnis, unggah beberapa dokumen, dan Chat with Data menggunakan **OAuth ChatGPT** atau OpenRouter. Dashboard dan proses OAuth berjalan di komputer Anda; data bisnis tetap disimpan pada Supabase cloud.

## Mulai

Gunakan **Node.js 24.6 atau lebih baru** (Node.js 24 LTS disarankan).

```bash
git clone https://github.com/bagasta/laras-bi-local.git
cd laras-bi-local
npm ci
npm start
```

Buka **http://127.0.0.1:3000**. Konfigurasi `.env` tidak diperlukan untuk menjalankan aplikasi. Kunci enkripsi lokal dan database pengaturan dibuat otomatis di `.laras/`.

## Penyiapan pertama

Saat pertama dibuka, Laras menampilkan **data contoh** (bisnis fiktif) yang hanya tersimpan di peramban. Panel *Anda sedang melihat data contoh* di dashboard memandu tiga langkah:

1. **Hubungkan Supabase**: wajib untuk memproses dan menyimpan data bisnis Anda.
2. **Unggah data bisnis**: CSV, Excel, PDF, Word, PowerPoint, TXT, atau MD.
3. **Hubungkan AI** (opsional): ChatGPT atau OpenRouter. Tanpa AI, Chat with Data memakai analisis berbasis aturan.

## Di mana data disimpan

"Lokal" berarti aplikasi berjalan di komputer Anda. Data bisnis tidak disimpan di komputer Anda.

| Data | Lokasi |
| --- | --- |
| Data bisnis dan dokumen asli | Proyek Supabase milik Anda (cloud) |
| Token Supabase, kredensial AI, pengaturan | Komputer ini, terenkripsi di `.laras/` |
| Data contoh mode demo | `localStorage` peramban |
| Pertanyaan Chat with Data | Jika AI terhubung, pertanyaan dan potongan data relevan (maks. ±24 KB per pertanyaan) dikirim ke ChatGPT/OpenRouter |

Cadangkan `.laras/master.key`. Tanpa berkas ini, kredensial tersimpan tidak dapat dibuka kembali. Ringkasan yang sama tersedia di **Pengaturan → Lokasi data**.

## Hubungkan ChatGPT

1. Buka **Pengaturan → Continue with ChatGPT**.
2. Masuk melalui halaman resmi OpenAI dan izinkan penggunaan paket ChatGPT.
3. Setelah kembali ke Laras, buka **Kelola ChatGPT**, pilih model dari akun Anda, lalu **Simpan model**.
4. Buka **Chat with Data** setelah data bisnis selesai diimpor.

Gunakan akun/paket ChatGPT yang memenuhi syarat. Login dan daftar model belum membuktikan akses inferensi; aplikasi menandai permintaan berhasil setelah menerima event `response.completed`. Kuota mengikuti akun dan workspace ChatGPT. **Manage usage** membuka pengaturan penggunaan ChatGPT.

OAuth memakai PKCE, state dan nonce sekali pakai, validasi signature/issuer/audience ID token, serta callback `http://127.0.0.1:3000/auth/callback`. Token tidak diambil dari Codex CLI, cookie browser, atau akun milik pengguna lain. Aplikasi mendaftarkan OAuth client-nya sendiri melalui alur resmi open-source OpenAI. Refresh token diserialkan; logout menghentikan permintaan dan mencoba mencabut sesi sebelum menghapus token lokal.

## Hubungkan data bisnis

1. **Pengaturan → Hubungkan Supabase**.
2. Masukkan Personal Access Token Supabase, klik **Periksa token**, dan pilih organisasi Free.
3. Simpan nama proyek yang unik. Jika ingin memakai proyek Supabase Laras yang sudah ada, gunakan organisasi dan nama proyek yang sama; aplikasi mencarinya sebelum membuat proyek baru.
4. Unggah dokumen → **Proses dokumen** → tinjau kolom → setujui impor.

Supabase disiapkan dan dimigrasikan otomatis. Proyek berikutnya tidak dibuat untuk setiap berkas. Kuota Free Supabase tetap berlaku. Token perlu izin membaca organisasi/pengaturan proyek, membuat proyek organisasi, dan membaca/menulis database; [panduan token Supabase](https://supabase.com/docs/guides/platform/personal-access-tokens).

**Koneksi dan data privat dari versi Sites tidak disertakan di repository.** Sambungkan Supabase kembali di versi lokal. Workspace lokal memakai owner ID stabil `local-owner`, sehingga unggahan sebelumnya milik identitas Sites tidak otomatis terbaca. Anda dapat mengunggah ulang data, atau mengatur `LARAS_LOCAL_OWNER_ID` di `.env` ke `owner_id` workspace Anda yang sudah ada di Supabase. Pilih ID milik Anda sendiri; nilai ini hanya untuk runtime pribadi di loopback, bukan login multiuser.

## Berkas dan analisis

- CSV dan XLSX: semua worksheet, pemetaan kolom, angka/tanggal lokal, deduplikasi lintas berkas, preview, persetujuan, dan rollback transaksi.
- PDF, DOCX, PPTX, TXT, Markdown: teks dan berkas asli untuk ditinjau; slide mempertahankan urutannya. Gambar hasil pindai memerlukan OCR yang belum tersedia.
- Maksimal 20 berkas, 2 MB per berkas, 10 MB per kelompok. Tabel dibatasi 5.000 baris per berkas dan 10.000 baris per kelompok.
- Kolom data menentukan metrik dan pilihan grafik; sumber/kolom analisis dapat diubah. Angka ID tidak dijumlahkan sebagai metrik.
- Chat mengirim fakta terhitung dan cuplikan data/dokumen yang sudah disetujui ke provider terpilih. Jawaban AI menyertakan sumber, dengan perhitungan deterministik tersedia terpisah. Model tidak mengeksekusi SQL atau mengubah data. Rujukan ID yang valid tidak menjamin semua penjelasan AI benar; periksa sumber untuk keputusan penting.
- Teks dokumen diperlakukan sebagai data tidak tepercaya; instruksi di dalam berkas tidak menjadi instruksi sistem. Gabungan tabel atau aturan bisnis tidak dibuat otomatis tanpa bukti.

OpenRouter tetap tersedia melalui **Pengaturan → Hubungkan OpenRouter**. Ketika koneksi ChatGPT aktif dan modelnya sudah dipilih, chat menggunakan paket ChatGPT. Kegagalan ChatGPT menghasilkan fallback berbasis aturan, tanpa diam-diam mengirim ulang ke model berbayar lain.

## Penyimpanan dan akses lokal

`.laras/master.key` mengenkripsi token OAuth dan kredensial pengaturan. Direktori memakai izin `0700` dan berkas kredensial `0600` pada sistem Unix. Simpan cadangan direktori ini secara aman; kehilangan kunci membuat koneksi tersimpan tidak dapat dibuka. Enkripsi ini melindungi cadangan/ekspor yang tidak menyertakan kuncinya; pengguna OS yang dapat membaca seluruh direktori tetap memiliki akses.

Server hanya bind ke `127.0.0.1`, memeriksa Host/Origin, dan memakai cookie sesi HttpOnly. Jangan memaparkan server ini melalui tunnel atau reverse proxy: versi ini adalah workspace pribadi lokal, bukan layanan multiuser. `PORT=3001` bisa ditetapkan dalam `.env`; callback OAuth mengikuti port tersebut.

## Pengembangan

```bash
npm test
npm run check
npm run build
```

Tes menjalankan PostgreSQL melalui PGlite, D1 adapter SQLite, simulasi provider, dan transport Workers. Pengujian OAuth mencakup state/nonce/PKCE, JWT, scopes, refresh, pemisahan akun, model, dan stream yang wajib selesai. Login OAuth serta inferensi sungguhan memerlukan persetujuan pengguna di browser komputer yang menjalankan Laras.

Kode utama: `local/` (runtime dan OAuth), `server/` (API dan analisis), `web/` (UI), `supabase/migrations/` (database bisnis), `drizzle/` (pengaturan lokal). Artefak build dan seluruh rahasia diabaikan oleh Git.

## Referensi

- [OpenAI: registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI: models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI: accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

Lisensi proyek: ISC. Font Inter menyertakan lisensi OFL di `web/fonts/`.
