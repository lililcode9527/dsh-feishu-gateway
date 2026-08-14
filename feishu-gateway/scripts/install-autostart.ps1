# Registers the gateway to auto-start at every Windows logon by placing a
# launcher in the user Startup folder (no admin rights needed).
# Run: powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startup "DSH-Feishu-Gateway.cmd"
$ps1 = Join-Path $dir "scripts\run-gateway.ps1"

$content = "@echo off`r`nstart `"`" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1`""
[System.IO.File]::WriteAllText($launcher, $content)
Write-Host "Installed autostart: $launcher"
Write-Host "Gateway will start automatically at every logon (supervisor loop, logs at data\gateway.log)."
Write-Host "Uninstall: powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1"
