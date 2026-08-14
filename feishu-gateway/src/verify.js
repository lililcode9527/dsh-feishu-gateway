// Live acceptance check: DSH reachable + Feishu credentials valid + long-connection established.
// Run: npm run verify   (fill .env first)
import { loadEnv, config } from "./env.js";

loadEnv();
const cfg = config();

let exit = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label) => {
  console.error(`  ✗ ${label}`);
  exit = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("[verify] 1/3 DSH 可达性");
try {
  const res = await fetch(`${cfg.dshBaseUrl}/api/session.list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "verify-1", method: "session.list", payload: {} }),
  });
  if (!res.ok) bad(`DSH HTTP ${res.status}（先运行 dsh --profile web）`);
  else {
    const body = await res.json();
    if (body.result?.ok) ok(`DSH 正常（${cfg.dshBaseUrl}）`);
    else bad(`DSH 业务错误：${body.result?.error?.message}`);
  }
} catch (err) {
  bad(`无法连接 DSH：${err.cause?.message ?? err.message}`);
}

console.log("[verify] 2/3 飞书凭据");
if (!cfg.feishuAppId || !cfg.feishuAppSecret) {
  bad("FEISHU_APP_ID / FEISHU_APP_SECRET 未填写");
  console.log("  请运行：npm run setup 打开飞书后台并创建应用，然后填入 .env。");
  process.exit(exit || 1);
}
if (!/^cli_[0-9a-fA-F]{16}$/.test(cfg.feishuAppId)) {
  bad(`App ID 格式不对：${cfg.feishuAppId.slice(0, 20)}…（应为 cli_ 开头 + 16 位十六进制，到「凭证与基础信息」复制）`);
  process.exit(1);
}
ok("App ID 格式正确，尝试建立飞书长连接…");

console.log("[verify] 3/3 长连接建立（最多等待 20 秒）");
const lark = await import("@larksuiteoapi/node-sdk");
let fatal = null;
const wsClient = new lark.WSClient({
  appId: cfg.feishuAppId,
  appSecret: cfg.feishuAppSecret,
  loggerLevel: lark.LoggerLevel.error,
  onError: (err) => {
    fatal = String(err?.message ?? err);
  },
});
const dispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async () => {},
});
try {
  await wsClient.start({ eventDispatcher: dispatcher });
} catch (err) {
  fatal = String(err?.message ?? err);
}
// Poll for 'connected' — the SDK retries retryable failures forever, so a
// timeout means credentials/backend config are wrong.
let state = "idle";
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  try {
    state = wsClient.getConnectionStatus?.()?.state ?? state;
  } catch {}
  if (state === "connected") break;
  await sleep(1000);
}
try {
  wsClient.close?.({ force: true });
} catch {}

if (state === "connected") {
  ok("飞书长连接已建立（WebSocket connected）");
  console.log("\n  现在可以：npm start 启动网关，然后用手机飞书给机器人发消息。");
} else {
  bad(`长连接未建立（状态：${state}${fatal ? `；错误：${fatal}` : ""}）`);
  console.log("  常见原因：");
  console.log("  1. App Secret 错误（到「凭证与基础信息」重新复制）");
  console.log("  2. 应用未发布（「版本管理与发布」创建并发布版本）");
  console.log("  3. 后台未开启长连接（「事件与回调」→ 订阅方式选『使用长连接接收事件』）");
  console.log("  请对照 docs/feishu-setup-checklist.md 检查后重试。");
  process.exit(1);
}

console.log(exit === 0 ? "\n[verify] 通过" : "\n[verify] 未通过，请按提示排查");
process.exit(exit);
