# Ruang Server Dashboard

Dokumentasi lengkap ada di:

- [Panduan operasional](docs/OPERATIONS.md)
- [Arsitektur dan flow sistem](docs/ARCHITECTURE.md)
- [Kontrak API](docs/API.md)

Dokumen tersebut adalah sumber acuan perubahan fitur. Setiap perubahan project, port,
permission, endpoint, atau cara deployment harus memperbarui dokumentasi terkait.

Dashboard monitoring dan management untuk domain yang dilayani oleh Caddy pada RDP ini.

## Alamat

- Publik: `https://server.ruangiman.my.id`

## AI providers untuk Codex

Dashboard mendukung pemilihan provider dan model sebelum menjalankan Codex. Buka bagian **User management → AI providers** untuk menambahkan credential OpenAI atau ZyRouter. API key disimpan terenkripsi menggunakan `sessionSecret`, dan hanya petunjuk empat karakter terakhir yang ditampilkan.

Setiap provider dapat memiliki beberapa model (dipisahkan koma). Provider dan model yang dipilih di terminal Codex dikirim ke Codex melalui konfigurasi provider Responses API; API key tidak pernah dikirim ke browser atau dicatat di log.

Untuk provider ZyRouter, daftar model pada terminal diambil langsung dari endpoint `/v1/models` menggunakan credential server, sehingga pilihan model tetap mengikuti katalog terbaru. Terminal juga memiliki layout responsif khusus untuk layar ponsel.

Bagian **Prompt history** dapat dibuka dan ditutup. Pilihan tampilan disimpan di browser agar dashboard tetap ringkas saat dibuka kembali.

Endpoint pengelolaan: `GET/POST /api/ai-providers` dan `DELETE /api/ai-providers/:id`. Semua perubahan membutuhkan sesi login, CSRF token, dan capability `user-management`.
- Lokal: `http://127.0.0.1:8094`

## Operasional

- Startup: `scripts/start-server.ps1`
- Autostart: shortcut `RuangServerDashboard.cmd` pada Startup akun Windows `admin`
- Log aplikasi: `logs/server.log` dan `logs/server-error.log`
- Audit aksi: `logs/audit.log`
- History prompt dan output Codex: `logs/codex-history/` (retensi otomatis 24 jam)
- Status maintenance: file `state/<project>.disabled`

Tombol Stop mengaktifkan halaman maintenance lalu menghentikan proses backend jika proyek memiliki proses. Tombol Start menjalankan backend yang telah diizinkan dan baru membuka domain setelah port siap. Proyek statis hanya memakai mode maintenance. Dashboard sendiri dibuat read-only agar tidak bisa mematikan akses kontrol dari dalam aplikasi.

FMT memiliki startup timeout 45 detik. Dashboard menjalankan `server.mjs` langsung dari folder Jira Codex Dashboard agar proses tidak bergantung pada wrapper PowerShell foreground.

Tombol Terminal membuka PowerShell pada folder proyek terkait. Eksekusi dibatasi 60 detik dan output 1 MB per perintah. Aktivitas terminal dicatat sebagai hash perintah, bukan isi perintah, agar data sensitif tidak masuk audit log. Terminal memiliki hak akses yang sama dengan proses dashboard, sehingga hanya boleh diberikan kepada administrator tepercaya.

Mode **Codex Full Access** untuk administrator menjalankan `codex exec` tanpa sandbox. Akun terbatas memakai `--sandbox workspace-write`, sehingga akses tulis Codex dibatasi ke workspace proyek yang diizinkan. Prompt Codex tidak memiliki batas waktu, panjang instruksi, atau ukuran output; proses dapat dihentikan kapan saja dengan tombol **Cancel**.

Setiap eksekusi Codex menyimpan prompt, status, waktu, exit code, dan output lengkap ke panel **Prompt history**. User hanya dapat membaca history miliknya pada project yang masih diizinkan; user dengan capability `user-management` dapat membaca history user lain selama project tersebut juga masuk permission-nya. File history dan audit yang berumur lebih dari 24 jam dibersihkan setiap jam.

Konfigurasi mendukung beberapa user dengan daftar project dan capability per akun. Akun `mifta` hanya dapat melihat project `remote-codex`, dapat melihat metrik sistem, dan hanya dapat menjalankan Codex project-scoped; endpoint terminal, kontrol service, dan seluruh project lain tetap ditolak di server.

Eksekusi Codex berjalan sebagai background job. Browser melakukan polling output setiap detik sehingga koneksi seluler tidak perlu terbuka sampai pekerjaan selesai. Tombol Cancel menghentikan seluruh process tree job yang sedang berjalan.

Saat mode Codex aktif, pengguna dapat memilih sumber autentikasi: login Codex server (subscription ChatGPT yang sudah login), OpenAI API key, atau ZyRouter API key. API key ditambahkan oleh user dengan capability `user-management`, dienkripsi AES-256-GCM memakai secret server, dan tidak pernah dikirim kembali ke browser. Akun ZyRouter memerlukan base URL HTTPS dan nama model sesuai dashboard/panduan ZyRouter. Subscription ChatGPT dan billing OpenAI API tetap merupakan layanan terpisah.

Panel telemetry memperbarui grafik CPU dan RAM setiap 5 detik serta menampilkan storage semua fixed drive dan uptime Windows. Endpoint metrik hanya dapat diakses setelah login.

## Keamanan

Konfigurasi autentikasi disimpan di `config.json` dalam bentuk scrypt hash; password asli tidak disimpan oleh aplikasi. Login dibatasi setelah lima kegagalan, sesi berlaku delapan jam, cookie memakai Secure/HttpOnly/SameSite, dan setiap aksi memakai token CSRF.
