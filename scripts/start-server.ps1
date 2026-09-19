$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 8094
if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { exit 0 }
& (Join-Path $PSScriptRoot 'setup.ps1')
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$node = 'C:\Program Files\nodejs\node.exe'
Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log') -WindowStyle Hidden
