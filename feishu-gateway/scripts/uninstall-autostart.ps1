# Removes the gateway autostart launcher from the user Startup folder.
# Run: powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
$ErrorActionPreference = "Stop"
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startup "DSH-Feishu-Gateway.cmd"
if (Test-Path $launcher) {
  Remove-Item $launcher -Force
  Write-Host "Removed autostart launcher: $launcher"
} else {
  Write-Host "No autostart launcher found."
}
