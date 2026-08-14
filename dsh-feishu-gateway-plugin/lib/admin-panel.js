// Self-contained settings panel for dsh-feishu-gateway-plugin.
// Served at http://127.0.0.1:3080/feishu/admin/panel (no build step).
export const adminPanelHtml = () => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>飞书网关设置</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px auto; max-width: 900px; padding: 0 16px; color: #1f2329; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #e5e6eb; padding: 6px 8px; text-align: left; word-break: break-all; }
  th { background: #f5f6f7; }
  input { width: 100%; box-sizing: border-box; padding: 5px 8px; margin: 2px 0; border: 1px solid #c9cdd4; border-radius: 4px; }
  button { padding: 6px 12px; border: 0; border-radius: 4px; cursor: pointer; background: #3370ff; color: #fff; margin: 2px; }
  button.danger { background: #f53f3f; } button.ghost { background: #e5e6eb; color: #1f2329; }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .card { border: 1px solid #e5e6eb; border-radius: 8px; padding: 16px; margin-top: 12px; }
  .muted { color: #8f959e; font-size: 12px; }
  #log { background: #f7f8fa; border-radius: 6px; padding: 8px; font-size: 12px; white-space: pre-wrap; max-height: 160px; overflow: auto; }
</style>
</head>
<body>
<h1>🤖 DSH 飞书网关设置</h1>
<div class="row"><button onclick="refresh()">刷新状态</button><span class="muted" id="conn"></span></div>
<h2>机器人列表</h2>
<table id="bots"></table>
<h2>添加 / 编辑机器人</h2>
<div class="card">
  <input id="f_name" placeholder="名称（如 ds-hs）" />
  <input id="f_workspace" placeholder="工作区目录（如 C:\\Users\\you\\Desktop\\harness）" />
  <input id="f_appId" placeholder="App ID（cli_...）" />
  <input id="f_appSecret" placeholder="App Secret（留空=保持不变）" type="password" />
  <input id="f_allowed" placeholder="白名单 open_id（逗号分隔，可留空）" />
  <div class="row"><button onclick="saveBot()">保存机器人</button><button class="ghost" onclick="clearForm()">清空</button></div>
</div>
<h2>扫码创建机器人（免手动建应用）</h2>
<div class="card">
  <button onclick="startOnboard()">生成二维码/验证链接</button>
  <div class="muted" id="ob"></div>
  <pre id="qr"></pre>
</div>
<h2>日志</h2>
<div id="log">等待操作…</div>
<script>
const $ = (s) => document.querySelector(s);
const api = (p, body) => fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const log = (t) => { $("#log").textContent = new Date().toLocaleTimeString() + " " + t + "\n" + $("#log").textContent.slice(0, 4000); };

async function refresh() {
  try {
    const r = await fetch("/feishu/admin/status");
    const d = await r.json();
    const rows = d.bots.map((b) => \`<tr>
      <td>\${b.name || ""}</td><td>\${b.workspace || ""}</td><td>\${b.appId}</td>
      <td>\${b.hasSecret ? "✅" : "❌"}</td><td>\${b.connection}</td><td>\${b.lastChatId || ""}</td>
      <td><button onclick="loadBot('\${b.appId}')">编辑</button><button class="danger" onclick="delBot('\${b.appId}')">删除</button>
          <button class="ghost" onclick="testSend('\${b.appId}')">测试发送</button></td>
    </tr>\`);
    $("#bots").innerHTML = "<tr><th>名称</th><th>工作区</th><th>AppID</th><th>密钥</th><th>连接</th><th>最近会话</th><th>操作</th></tr>" + rows.join("");
    $("#conn").textContent = "共 " + d.bots.length + " 个机器人";
  } catch (e) { log("刷新失败: " + e.message); }
}
function clearForm() { ["f_name","f_workspace","f_appId","f_appSecret","f_allowed"].forEach((i) => $("#" + i).value = ""); }
function loadBot(appId) {
  fetch("/feishu/admin/status").then((r) => r.json()).then((d) => {
    const b = d.bots.find((x) => x.appId === appId); if (!b) return;
    $("#f_name").value = b.name; $("#f_workspace").value = b.workspace; $("#f_appId").value = b.appId; $("#f_appSecret").value = ""; $("#f_allowed").value = "";
  });
}
async function saveBot() {
  const body = { bots: [{
    name: $("#f_name").value.trim(), workspace: $("#f_workspace").value.trim(),
    appId: $("#f_appId").value.trim(), appSecret: $("#f_appSecret").value.trim(),
    allowedOpenIds: $("#f_allowed").value.split(",").map((s) => s.trim()).filter(Boolean),
  }] };
  // merge with existing (preserve secrets & other bots)
  const cur = await fetch("/feishu/admin/status").then((r) => r.json());
  const others = cur.bots.filter((b) => b.appId !== body.bots[0].appId);
  const res = await api("/feishu/admin/config", { bots: [...others, body.bots[0]] });
  log(res.message || JSON.stringify(res)); clearForm(); refresh();
}
async function delBot(appId) { if (!confirm("删除机器人 " + appId + "？")) return; const r = await api("/feishu/admin/delete-bot", { appId }); log(r.message || JSON.stringify(r)); refresh(); }
async function testSend(appId) {
  const text = prompt("测试消息内容（发到该机器人最近会话）：", "测试消息");
  if (text === null) return;
  const r = await api("/feishu/admin/send-test", { appId, text });
  log(JSON.stringify(r));
}
let obTimer = null;
async function startOnboard() {
  if (obTimer) { clearInterval(obTimer); obTimer = null; }
  $("#ob").textContent = "正在请求…";
  const r = await api("/feishu/admin/onboard", {});
  if (!r.ok) { $("#ob").textContent = "失败: " + (r.message || ""); return; }
  $("#ob").textContent = "用飞书 App 扫码或打开链接验证（用户码 " + r.userCode + "，有效期约 " + Math.floor(r.expiresIn / 60) + " 分钟）";
  $("#qr").textContent = "验证链接：" + r.qrContent;
  obTimer = setInterval(async () => {
    const p = await api("/feishu/admin/onboard/poll", { deviceCode: r.deviceCode });
    if (p.ok && p.done) {
      clearInterval(obTimer); obTimer = null;
      $("#f_appId").value = p.appId; $("#f_appSecret").value = p.appSecret;
      $("#ob").textContent = "✅ 扫码成功！App ID/Secret 已填入，请填好名称/工作区后点「保存机器人」。";
      log("onboard done: " + p.appId);
    } else if (!p.ok) { clearInterval(obTimer); obTimer = null; $("#ob").textContent = "失败: " + (p.message || p.error || ""); }
  }, (r.interval || 5) * 1000);
}
refresh();
</script>
</body>
</html>`;
