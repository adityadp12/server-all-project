# Panduan Operasional

## Prasyarat dan menjalankan

- Windows host dengan Node.js dan PowerShell.
- Caddy meneruskan `server.ruangiman.my.id` ke `127.0.0.1:8094`.
- `config.json`, path project, dan Codex CLI tersedia bila fitur tersebut dipakai.

```powershell
cd D:\server
npm run check
.\scripts\start-server.ps1
```

Startup normal memakai shortcut `RuangServerDashboard.cmd` pada Startup akun Windows
`admin`. Health check: `Invoke-RestMethod http://127.0.0.1:8094/health`.

## Verifikasi setelah deploy

```powershell
node scripts\smoke-test.js
Get-Content logs\server-error.log -Tail 50
```

Login sebagai admin, cek status project, metrik, lifecycle project non-protected,
terminal, dan history Codex sesuai permission. Jangan menguji Stop pada `server`.

## User dan secret

Password disimpan sebagai hash scrypt. Capability tersedia: `status`, `metrics`,
`service`, `terminal`, `codex-project-write`, `codex-full-access`, dan
`user-management`. `projects: "*"` berarti semua project.

API key OpenAI disimpan terenkripsi AES-256-GCM dengan turunan `sessionSecret`.
Jangan commit `config.json`, `initial-password.txt`, atau `mifta-credentials.txt`
ke repository publik. Jika credential terekspos, rotate password, session secret,
dan key.

## Troubleshooting

| Gejala | Pemeriksaan |
|---|---|
| Dashboard tidak terbuka | `/health`, port 8094, `server-error.log`, Caddy |
| Project offline setelah Start | folder/path startup, `logs/<id>.log`, port dan host |
| Stop gagal | port masih listen, process tree, hak akun `admin` |
| Login ditolak | hash config, lockout 5 kali selama 5 menit |
| Codex gagal | path CLI, `D:\CodexData`, credential/account, history |
| User tidak melihat project | `projects` dan `capabilities`; login ulang |

## Backup dan rollback

Backup minimal: `server.js`, `public/`, `scripts/`, `config.json` secara terenkripsi,
serta konfigurasi Caddy. Jangan backup credential ke lokasi publik. Sebelum rollback,
simpan log, jalankan `npm run check`, restart, lalu verifikasi `/health` dan status.
