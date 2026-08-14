// Setup preflight: verify DSH reachability + Feishu credentials before going live.
// Run: npm run check
import { loadEnv, config } from "./env.js";

loadEnv();
const cfg = config();

let exit = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label) => {
  console.error(`  ✗ ${label}`);
  exit = 1;
};

console.log("[check] 1/3 DSH 可达性");
try {
  const res = await fetch(`${cfg.dshBaseUrl}/api/session.list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "check-1", method: "session.list", payload: {} }),
  });
  if (res.status === 403) bad(`DSH /api 拒绝访问（${res.status}）：请确认在 127.0.0.1 本机运行`);
  else if (res.status === 404) bad(`DSH /api 不存在（${res.status}）：DSH 可能未启动，先运行 dsh --profile web`);
  else if (!res.ok) bad(`DSH 返回 HTTP ${res.status}`);
  else {
    const body = await res.json();
    if (body.result?.ok) ok(`DSH 正常（${cfg.dshBaseUrl}，会话数：${body.result.value?.items?.length ?? 0}）`);
    else bad(`DSH 业务错误：${body.result?.error?.message}`);
  }
} catch (err) {
  bad(`无法连接 DSH（${cfg.dshBaseUrl}）：${err.cause?.message ?? err.message}`);
}

console.log("[check] 2/3 飞书凭据");
if (!cfg.feishuAppId || !cfg.feishuAppSecret) {
  bad("FEISHU_APP_ID / FEISHU_APP_SECRET 未填写（当前为 dry-run 模式）");
  console.log("\n  请到飞书开放平台完成以下步骤后填入 .env：");
  console.log("  1. https://open.feishu.cn → 开发者后台 → 创建企业自建应用");
  console.log("  2. 应用能力 → 添加「机器人」");
  console.log("  3. 权限管理 → 开通 im:message 与 im:message:send_as_bot");
  console.log("  4. 事件与回调 → 订阅方式选「使用长连接接收事件」，订阅 im.message.receive_v1");
  console.log("  5. 版本管理与发布 → 创建版本并发布");
  console.log("  6. 凭证与基础信息 → 复制 App ID / App Secret 到 .env\n");
} else {
  try {
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: cfg.feishuAppId, app_secret: cfg.feishuAppSecret }),
    });
    const body = await res.json();
    if (body.code === 0 && body.tenant_access_token) {
      ok("App ID / App Secret 有效（已获取 tenant_access_token）");
    } else {
      bad(`飞书返回错误 code=${body.code} msg=${body.msg ?? ""}`);
      console.log("  常见原因：App Secret 错误（10003）、应用不存在（10012）、应用未启用（20001）。");
    }
  } catch (err) {
    bad(`无法访问 open.feishu.cn：${err.cause?.message ?? err.message}`);
    console.log("  请检查电脑网络（飞书国内域名 open.feishu.cn 应可直连）。");
  }
}

console.log("[check] 3/3 长连接就绪提示");
console.log("  长连接（WebSocket）无需公网回调地址；应用「事件与回调」须选择『使用长连接接收事件』并发布版本后生效。");

console.log(exit === 0 ? "\n[check] 全部通过，可以 npm start" : "\n[check] 存在问题，请按提示修复后重试");
process.exit(exit);
