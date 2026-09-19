$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
if (Test-Path -LiteralPath $configPath) { exit 0 }
$alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
$password = -join (1..20 | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] })
$salt = -join ([byte[]](1..16 | ForEach-Object { Get-Random -Maximum 256 }) | ForEach-Object { $_.ToString('x2') })
$nodeScript = "const c=require('crypto');process.stdout.write(c.scryptSync(process.argv[1],Buffer.from(process.argv[2],'hex'),64).toString('hex'))"
$hash = & 'C:\Program Files\nodejs\node.exe' -e $nodeScript $password $salt
$secret = -join ([byte[]](1..32 | ForEach-Object { Get-Random -Maximum 256 }) | ForEach-Object { $_.ToString('x2') })
@{ username = 'admin'; passwordSalt = $salt.ToLower(); passwordHash = $hash; sessionSecret = $secret.ToLower() } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
Set-Content -LiteralPath (Join-Path $root 'initial-password.txt') -Value "Username: admin`r`nPassword: $password" -Encoding UTF8
Write-Output "Dashboard credential dibuat di $root\initial-password.txt"
