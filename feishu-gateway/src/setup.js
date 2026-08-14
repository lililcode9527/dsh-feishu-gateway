// Cross-platform setup guide (the CLI `setup` command).
// Prints the one-time Feishu app checklist and opens open.feishu.cn if possible.
import { execSync } from "node:child_process";
import { loadEnv, config, configDir } from "./env.js";

loadEnv();
const cfg = config();

if (cfg.feishuAppId && cfg.feishuAppSecret) {
  console.log("[setup] .env 已包含 FEISHU_APP_ID / FEISHU_APP_SECRET");
  console.log(`[setup] 下一步：cd ${configDir()} ; dsh-feishu-gateway check ; dsh-feishu-gateway verify ; dsh-feishu-gateway start`);
  process.exit(0);
}

console.log("");
console.log("===== 飞书后台配置清单（一次性，约 10 分钟）=====");
console.log("1. 打开 https://open.feishu.cn 并登录（将尝试自动打开浏览器）");
console.log("2. 开发者后台 -> 创建企业自建应用（名称随意，如 DSH机器人）");
console.log("3. 应用能力 -> 添加「机器人」");
console.log("4. 权限管理 -> 开通 im:message 和 im:message:send_as_bot");
console.log("5. 事件与回调 -> 订阅方式选「使用长连接接收事件」");
console.log("   事件 -> 添加 im.message.receive_v1");
console.log("6. 版本管理与发布 -> 创建版本并发布");
console.log("7. 凭证与基础信息 -> 复制 App ID 和 App Secret");
console.log("");
console.log(`拿到后：把两个值填进 ${configDir()} 下的 .env（参照 .env.example）`);
console.log("然后：dsh-feishu-gateway check ; dsh-feishu-gateway verify ; dsh-feishu-gateway start");
console.log("=================================================");
console.log("");

try {
  const url = "https://open.feishu.cn";
  if (process.platform === "win32") execSync(`start "" "${url}"`, { shell: "cmd.exe", stdio: "ignore" });
  else if (process.platform === "darwin") execSync(`open "${url}"`, { stdio: "ignore" });
  else execSync(`xdg-open "${url}"`, { stdio: "ignore" });
  console.log("[setup] 已在浏览器打开飞书开放平台，按上面步骤操作即可。");
} catch {
  console.log("[setup] 请手动打开 https://open.feishu.cn");
}
