# Kontrak API

Semua response API adalah JSON. Selain `/health`, `/api/login`, dan static UI, endpoint
memerlukan session cookie. POST/PATCH/DELETE memerlukan `x-csrf-token`.

| Method | Path | Capability | Fungsi |
|---|---|---|---|
| GET | `/health` | publik | health check |
| POST | `/api/login` | publik | login; mengembalikan CSRF |
| POST | `/api/logout` | login | hapus session |
| GET | `/api/session` | publik/login | status session |
| GET | `/api/status` | `status` | status project yang diizinkan |
| GET | `/api/metrics` | `metrics` | CPU, RAM, disk, uptime |
| POST | `/api/projects/:id/start` | `service` | start project |
| POST | `/api/projects/:id/stop` | `service` | maintenance + stop |
| POST | `/api/projects/:id/restart` | `service` | stop lalu start |
| POST | `/api/projects/:id/terminal` | `terminal` | PowerShell terbatas |
| POST | `/api/projects/:id/codex` | Codex capability | buat background job |
| GET | `/api/codex-jobs/:id` | pemilik job | polling output |
| POST | `/api/codex-jobs/:id` | pemilik job | cancel job |
| GET | `/api/codex-history` | Codex/user-management | daftar history |
| GET | `/api/codex-history/:id` | project + ownership | detail history |
| GET/POST | `/api/users` | `user-management` | daftar/buat user |
| PATCH/DELETE | `/api/users/:username` | `user-management` | ubah/hapus user |
| GET/POST/DELETE | `/api/openai-accounts...` | Codex/user-management | akun API terenkripsi |

ID project berasal dari registry; ID history/job berupa 36 karakter hexadecimal.
Error authorization memakai 401/403, resource 404, validasi 400, dan error lifecycle
umumnya 500. Detail implementasi harus tetap mengikuti route di `server.js`.
# AI providers

`GET /api/ai-providers` mengembalikan daftar provider yang tersedia tanpa API key. `POST /api/ai-providers` menerima `provider` (`openai` atau `zyrouter`), `name`, `apiKey`, `models` (array atau koma), dan optional `baseUrl`. `DELETE /api/ai-providers/:id` menghapus credential. Endpoint mutasi membutuhkan CSRF token dan capability `user-management`.

Saat menjalankan Codex, request dapat menyertakan `providerId` dan `model` pada endpoint project Codex. Credential didekripsi hanya di server process.
