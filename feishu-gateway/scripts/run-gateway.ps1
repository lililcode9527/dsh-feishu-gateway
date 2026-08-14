# Runs the DSH Feishu gateway as a supervisor loop: auto-restarts on crash,
# logs all output to data\gateway.log. Used by autostart and manual start.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $PSScriptRoot
$log = Join-Path $dir "data\gateway.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Set-Location $dir
while ($true) {
  "===== gateway start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =====" | Out-File -FilePath $log -Append -Encoding utf8
  & node src/index.js *>> $log
  $code = $LASTEXITCODE
  "===== gateway exited ($code) at $(Get-Date -Format 'HH:mm:ss'), restarting in 5s =====" | Out-File -FilePath $log -Append -Encoding utf8
  Start-Sleep -Seconds 5
}
