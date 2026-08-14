// Tiny .env loader: reads KEY=VALUE lines from the config dir (cwd or
// $DSH_FEISHU_CONFIG_DIR), does not override existing process.env values.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Config directory: explicit override, else the current working directory. */
export function configDir() {
  return process.env.DSH_FEISHU_CONFIG_DIR || process.cwd();
}

export function loadEnv(file = join(configDir(), ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function config() {
  const dir = configDir();
  return {
    dshBaseUrl: process.env.DSH_BASE_URL ?? "http://127.0.0.1:3080",
    feishuAppId: process.env.FEISHU_APP_ID ?? "",
    feishuAppSecret: process.env.FEISHU_APP_SECRET ?? "",
    allowedOpenIds: (process.env.ALLOWED_OPEN_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sessionsFile: process.env.SESSIONS_FILE ?? join(dir, "data", "sessions.json"),
    sessionCwd: process.env.DSH_SESSION_CWD ?? "",
    maxReplyChars: Number(process.env.MAX_REPLY_CHARS ?? 4000),
    progressThrottleMs: Number(process.env.PROGRESS_THROTTLE_MS ?? 10000),
    maxFilePush: Number(process.env.MAX_FILE_PUSH ?? 3),
    maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 20 * 1024 * 1024),
    turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS ?? 1800000),
    feishuSendPort: Number(process.env.FEISHU_SEND_PORT ?? 3180),
  };
}
