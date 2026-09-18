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
- Data aplikasi disimpan di `data/*.json` agar bisa langsung jalan tanpa database tambahan.
- AI punya fallback jika `GEMINI_API_KEY` belum diisi.

## Jalankan di VS Code

1. Buka folder project.
2. Jalankan:
   ```bash
   npm install
   ```
3. Salin `.env.example` menjadi `.env`.
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
- Set `NODE_ENV=production`, `APP_ORIGIN` ke origin HTTPS yang tepat, dan `SESSION_SECRET` ke secret acak yang panjang.
- Session memakai PostgreSQL, cookie `httpOnly`, `sameSite`, dan `secure`.
- Login dibatasi rate limit dan hanya menerima password yang sudah disimpan sebagai hash bcrypt. Akun lama dengan password plaintext harus dimigrasikan atau di-reset sebelum production.
- Endpoint API memakai rate limit, security headers, validasi Origin untuk request mutasi, dan batas multipart upload.
- Jalankan `npm audit` sebelum deploy. Saat ini `xlsx` masih memiliki advisory tanpa fix upstream, dan dependency WhatsApp/Puppeteer memiliki advisory yang perlu dievaluasi sebelum dipakai di internet publik.
