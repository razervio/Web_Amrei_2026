# AMREI Property Platform v2

Aplikasi ini sudah dirapikan menjadi dua area utama: **Admin** dan **Marketer**, plus landing page referral customer.

## Fitur
- Login role Admin / Marketer.
- Admin: dashboard, AI Bot, CRUD properti, kelola lead (edit/hapus), baca XLSX customer, birthday checker, product blast, WhatsApp queue.
- Marketer: dashboard pribadi, AI Bot, informasi AMREI, pilih properti yang dipasarkan, link referral, melihat lead miliknya.
- Customer: `/m/:slug` melihat properti yang dipilih marketer lalu mengisi nama + WhatsApp untuk Tanya/Booking.
- Lead otomatis menyimpan marketer dan properti asal.
- XLSX digunakan untuk customer blast; tanggal lahir benar-benar difilter berdasarkan hari dan bulan saat ini.
- Queue WhatsApp default 60 detik per pesan.
- Data aplikasi utama disimpan di MySQL. File XLSX, unggahan, dokumen marketer, dan sesi WhatsApp tetap disimpan di folder `data/`.
- AI punya fallback jika `GEMINI_API_KEY` belum diisi.

## Jalankan di VS Code

1. Buka folder project.
2. Jalankan:
   ```bash
   npm install
   ```
3. Salin `.env.example` menjadi `.env`, lalu isi `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, dan `DB_PASSWORD` untuk MySQL. Database MySQL yang disarankan adalah MySQL 8.0.13 atau lebih baru.
4. Untuk AI Gemini, isi `GEMINI_API_KEY`. Jika kosong, bot memakai jawaban fallback.
5. Jalankan:
   ```bash
   npm start
   ```
6. Buka `http://localhost:3000`.

## Akun demo
- Admin: `admin` / `123`
- Marketer: `adhimas` / `123`
- Marketer: `budi` / `123`

## WhatsApp
Secara default `WHATSAPP_ENABLED=false` supaya aplikasi bisa start tanpa langsung membuka WhatsApp Web.

Jika sudah siap menghubungkan WhatsApp:
1. Ubah `.env` menjadi `WHATSAPP_ENABLED=true`.
2. Restart server.
3. Login Admin → WhatsApp Blast → **Hubungkan WhatsApp**.
4. Scan QR pada terminal.
5. Setelah status Ready, broadcast akan masuk antrean 1 menit/pesan.

Jeda 1 menit hanya mengatur kecepatan antrean; tidak menjamin akun WhatsApp tidak terkena pembatasan. Gunakan hanya untuk customer yang memang memberikan izin menerima pesan.

## Database

Aplikasi menggunakan MySQL sebagai database utama. Migrasi dari PostgreSQL telah selesai dan isi 9 tabel berhasil diverifikasi cocok; kode dan dependency PostgreSQL telah dihapus dari project. Database PostgreSQL lama tidak dihapus atau diubah dan sebaiknya tetap disimpan sebagai cadangan.

Folder `data/uploads/` dan `data/marketer-documents/` berisi file yang tidak berada di database. Folder tersebut tidak diubah oleh migrasi dan harus tetap tersedia saat memindahkan aplikasi ke server lain.

## Format XLSX yang disarankan
Header:
- `Nama`
- `No. WA`
- `Tanggal Lahir`
- `Status`
- `Tanggal Dibuat`

Tanggal lahir boleh berupa tanggal Excel atau teks seperti `14/08/2000`.

## Catatan keamanan
Jangan masukkan API key ke GitHub. File `.env` sengaja tidak disertakan dalam ZIP; gunakan `.env.example` sebagai template.

Untuk production:
- Set `NODE_ENV=production`, `APP_ORIGIN` ke origin HTTPS yang tepat, dan `SESSION_SECRET` ke secret acak minimal 32 karakter. Buat secret dengan `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Set `DB_SSL=true` dan `DB_SSL_REJECT_UNAUTHORIZED=true` agar koneksi MySQL terenkripsi dan sertifikat server diverifikasi.
- Session memakai MySQL, cookie `httpOnly`, `sameSite`, dan `secure`.
- Login dibatasi rate limit dan hanya menerima password yang sudah disimpan sebagai hash bcrypt. Akun lama dengan password plaintext harus dimigrasikan atau di-reset sebelum production.
- Endpoint API memakai rate limit, security headers, validasi Origin untuk request mutasi, dan batas multipart upload.
- Jalankan `npm audit` sebelum deploy. Audit terakhir masih melaporkan advisori high pada rantai dependency WhatsApp/Puppeteer; jangan menganggap aplikasi bebas risiko dan tinjau ulang sebelum mengaktifkan WhatsApp di server publik.
