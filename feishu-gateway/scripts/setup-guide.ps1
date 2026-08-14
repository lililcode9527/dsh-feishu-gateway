# Setup guide for the Feishu app (the only user-side step).
# - If credentials already exist in .env: tells you to run the check.
# - Otherwise: prints the checklist and opens the Feishu open platform in your browser.
# Run: powershell -ExecutionPolicy Bypass -File scripts\setup-guide.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $dir ".env"

function Get-EnvValue($key) {
  $line = Select-String -Path $envFile -Pattern "^$key=" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $line) { return "" }
  return ($line.Line -replace "^$key=", "").Trim().Trim('"').Trim("'")
}

$appId = Get-EnvValue "FEISHU_APP_ID"
$appSecret = Get-EnvValue "FEISHU_APP_SECRET"

if ($appId -and $appSecret) {
  Write-Host "[setup] .env 已包含 FEISHU_APP_ID / FEISHU_APP_SECRET" -ForegroundColor Green
  Write-Host "[setup] 下一步：cd $dir ; npm run check ; npm start"
  exit 0
}

Write-Host ""
Write-Host "===== 飞书后台配置清单（一次性，约 10 分钟）=====" -ForegroundColor Cyan
Write-Host "1. 打开 https://open.feishu.cn 并登录（即将自动打开浏览器）"
Write-Host "2. 开发者后台 -> 创建企业自建应用（名称随意，如 DSH机器人）"
Write-Host "3. 应用能力 -> 添加「机器人」"
Write-Host "4. 权限管理 -> 开通 im:message 和 im:message:send_as_bot"
Write-Host "5. 事件与回调 -> 订阅方式选「使用长连接接收事件」"
Write-Host "   事件 -> 添加 im.message.receive_v1"
Write-Host "6. 版本管理与发布 -> 创建版本并发布"
Write-Host "7. 凭证与基础信息 -> 复制 App ID 和 App Secret"
Write-Host ""
Write-Host "拿到后：把两个值填进 $envFile（替换 FEISHU_APP_ID= 和 FEISHU_APP_SECRET= 后面）"
Write-Host "然后：cd $dir ; npm run check ; npm start"
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ""

try {
  Start-Process "https://open.feishu.cn"
  Write-Host "[setup] 已在浏览器打开飞书开放平台，按上面步骤操作即可。" -ForegroundColor Green
} catch {
  Write-Host "[setup] 请手动打开 https://open.feishu.cn" -ForegroundColor Yellow
}
