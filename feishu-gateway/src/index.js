import { DshClient } from "./dsh.js";
import { SessionStore } from "./store.js";
import { TurnRelay } from "./relay.js";
import { loadBots } from "./bots.js";
import { startSendServer } from "./send-server.js";
import { loadEnv, config, configDir } from "./env.js";
import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

loadEnv();

const cfg = config();
console.log(`[gw] DSH_BASE_URL=${cfg.dshBaseUrl}`);
console.log(`[gw] config dir: ${process.env.DSH_FEISHU_CONFIG_DIR || process.cwd()}`);

const dsh = new DshClient(cfg.dshBaseUrl);
const store = new SessionStore(cfg.sessionsFile);

const { FeishuBot } = await import("./feishu.js");

const bots = loadBots(cfg);
if (bots.length === 0) {
  console.error("[gw] 没有可用机器人：请配置 bots.json 或 .env 的 FEISHU_APP_ID / FEISHU_APP_SECRET");
  process.exit(1);
}
console.log(`[gw] bots: ${bots.map((b) => b.name).join(", ")}`);

// Dedupe incoming messages: long-connection events that aren't ACKed in time
// are re-delivered by Feishu, which would otherwise run the same task twice.
const seenMessages = new Map(); // `${botName}:${messageId}` -> expiry
const DEDUPE_TTL_MS = 120000;
const MAX_SEEN = 2000;
const isDuplicate = (botName, messageId) => {
  if (!messageId) return false;
  const key = `${botName}:${messageId}`;
  const now = Date.now();
  if (seenMessages.size > MAX_SEEN) {
    for (const [id, expiry] of seenMessages) {
      if (expiry < now) seenMessages.delete(id);
    }
  }
  if (seenMessages.has(key)) return true;
  seenMessages.set(key, now + DEDUPE_TTL_MS);
  return false;
};

// Connect to the DSH event stream first, then start each bot.
dsh.connect();

try {
  const { items } = await dsh.call("session.list", {}, { timeoutMs: 8000 });
  console.log(`[gw] DSH connected (${items.length} session(s) on host)`);
} catch (err) {
  console.warn(`[gw] WARNING: cannot reach DSH at ${cfg.dshBaseUrl}: ${err.message}`);
  console.warn("[gw] 先运行 `dsh --profile web`（浏览器能打开 http://127.0.0.1:3080 即可），网关仍会持续重连。");
}

const relays = [];
for (const b of bots) {
  const bot = new FeishuBot({ appId: b.appId, appSecret: b.appSecret });
  const botCfg = {
    ...cfg,
    botName: b.name,
    workspace: b.workspace,
    sessionCwd: b.workspace || cfg.sessionCwd,
    allowedOpenIds: b.allowedOpenIds.length ? b.allowedOpenIds : cfg.allowedOpenIds,
  };
  const relay = new TurnRelay({
    dsh,
    store,
    config: botCfg,
    notify: (openId, chatId, text) => bot.sendMarkdown(openId, chatId, text),
    notifyImage: (openId, chatId, img) => bot.sendImage(openId, chatId, img),
    notifyFile: (openId, chatId, f) => bot.sendFile(openId, chatId, f),
    notifyApproval: (openId, chatId, a) => bot.sendApprovalCard(openId, chatId, a),
  });

  bot.onMessage(async ({ openId, chatId, text, messageId }) => {
    if (isDuplicate(b.name, messageId)) {
      console.log(`[gw:${b.name}] duplicate message skipped (${messageId})`);
      return;
    }
    lastChat.set(b.name, { openId, chatId });
    console.log(`[gw:${b.name}] message from open_id=${openId} chat=${chatId}: ${text.slice(0, 80)}`);
    try {
      await relay.handleText(openId, chatId, text);
    } catch (err) {
      console.error(`[gw:${b.name}] handleText error:`, err);
      try {
        await bot.sendText(openId, chatId, `❌ 网关内部错误：${err.message}`);
      } catch {}
    }
  });

  bot.onCardAction(async ({ openId, chatId, value }) => {
    try {
      await relay.handleApprovalCard(openId, chatId, value);
    } catch (err) {
      console.error(`[gw:${b.name}] card action error:`, err);
    }
  });

  setInterval(() => {
    const st = bot.connectionStatus();
    console.log(`[gw:${b.name}] feishu ws state: ${st?.state ?? "unknown"}${st?.reconnectAttempts ? ` (reconnects: ${st.reconnectAttempts})` : ""}`);
  }, 60000);

  await bot.start();
  console.log(`[gw] bot "${b.name}" ready (${b.workspace ? `workspace: ${b.workspace}` : "workspace: 未配置"})`);
  relays.push([bot, relay]);
}

console.log("[gw] gateway is running. Press Ctrl+C to stop.");

// ---- feishu_send receiver (for the dsh-feishu-send plugin) ----
// Stable token persisted in the config dir; a copy goes to the user home so
// the plugin can find it without configuration.
const sendPort = cfg.feishuSendPort;
const sendConfigFile = join(configDir(), "data", "gateway-send.json");
const homeConfigFile = join(os.homedir(), ".dsh-feishu-gateway.json");
let sendToken = process.env.FEISHU_SEND_TOKEN ?? "";
if (!sendToken) {
  try {
    if (existsSync(sendConfigFile)) sendToken = JSON.parse(readFileSync(sendConfigFile, "utf8")).token ?? "";
  } catch {}
}
if (!sendToken) sendToken = randomBytes(24).toString("hex");
const sendMeta = { url: `http://127.0.0.1:${sendPort}`, token: sendToken, port: sendPort };
try {
  mkdirSync(join(configDir(), "data"), { recursive: true });
  writeFileSync(sendConfigFile, JSON.stringify(sendMeta, null, 2));
} catch (err) {
  console.warn(`[gw] cannot write ${sendConfigFile}: ${err.message}`);
}
try {
  writeFileSync(homeConfigFile, JSON.stringify(sendMeta, null, 2));
} catch (err) {
  console.warn(`[gw] cannot write ${homeConfigFile}: ${err.message}（插件需配置环境变量 DSH_FEISHU_SEND_URL/TOKEN）`);
}

const lastChat = new Map(); // botName -> { openId, chatId }
const botByName = new Map();
for (const [bot, relay] of relays) botByName.set(bot.name, bot);

startSendServer({
  port: sendPort,
  token: sendToken,
  resolveBot: (appName) => {
    const bot = appName ? botByName.get(appName) : relays[0]?.[0];
    if (!bot) return undefined;
    return {
      name: bot.name,
      send: (openId, chatId, text) => bot.sendMarkdown(openId, chatId, text),
    };
  },
  lastChatFor: (botName) => lastChat.get(botName),
})
  .then(() => console.log(`[gw] feishu_send receiver on ${sendMeta.url} (token in ${sendConfigFile})`))
  .catch((err) => console.error(`[gw] feishu_send receiver failed: ${err.message}`));

const shutdown = async () => {
  console.log("\n[gw] shutting down…");
  dsh.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
