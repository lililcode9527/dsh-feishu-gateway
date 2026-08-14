// Bot configuration loading: multi-bot via bots.json in the config dir, or a
// single legacy bot from .env (FEISHU_APP_ID / FEISHU_APP_SECRET).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./env.js";

/**
 * Resolve the bot list.
 * @returns [{ name, appId, appSecret, workspace, allowedOpenIds }]
 */
export function loadBots(cfg) {
  const botsFile = join(configDir(), "bots.json");
  if (existsSync(botsFile)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(botsFile, "utf8"));
    } catch (err) {
      console.error(`[bots] failed to parse ${botsFile}: ${err.message}`);
      parsed = [];
    }
    const bots = (Array.isArray(parsed) ? parsed : []).filter((b) => b && b.appId && b.appSecret);
    if (bots.length === 0) {
      console.error(`[bots] ${botsFile} 存在但没有任何有效 bot（需要 appId + appSecret）`);
    }
    return bots.map((b, i) => ({
      name: String(b.name ?? `bot-${i + 1}`),
      appId: b.appId,
      appSecret: b.appSecret,
      workspace: b.workspace ?? "",
      allowedOpenIds: Array.isArray(b.allowedOpenIds) ? b.allowedOpenIds : [],
    }));
  }

  // Legacy single-bot from .env
  const bot = {
    name: process.env.DSH_BOT_NAME ?? "default",
    appId: cfg.feishuAppId,
    appSecret: cfg.feishuAppSecret,
    workspace: process.env.DSH_SESSION_CWD ?? "",
    allowedOpenIds: cfg.allowedOpenIds,
  };
  return bot.appId && bot.appSecret ? [bot] : [];
}
