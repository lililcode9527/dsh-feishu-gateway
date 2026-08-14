#!/usr/bin/env node
// dsh-feishu-gateway CLI: setup | check | verify | start
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const HELP = `dsh-feishu-gateway ${manifest.version}

Bridge Feishu (Lark) chats with your local DeepSeek Harness.

Usage:
  dsh-feishu-gateway setup    show the one-time Feishu app setup checklist
  dsh-feishu-gateway check    preflight: DSH reachable + credentials valid
  dsh-feishu-gateway verify   live check: actually establish the Feishu long connection
  dsh-feishu-gateway start    run the gateway (blocks; Ctrl+C to stop)
  dsh-feishu-gateway -V|--version
  dsh-feishu-gateway -h|--help

Config: reads .env from the current directory (or $DSH_FEISHU_CONFIG_DIR).
See .env.example for FEISHU_APP_ID / FEISHU_APP_SECRET and options.`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
if (args.includes("-V") || args.includes("--version")) {
  console.log(manifest.version);
  process.exit(0);
}

const cmd = args.find((a) => !a.startsWith("-")) ?? "start";
const targets = {
  start: join(root, "src", "index.js"),
  check: join(root, "src", "check.js"),
  verify: join(root, "src", "verify.js"),
  setup: join(root, "src", "setup.js"),
};
const target = targets[cmd];
if (!target) {
  console.error(`unknown command: ${cmd}`);
  console.log(HELP);
  process.exit(1);
}

// stdio: inherit so logs stream through and the long-running start stays attached.
const child = spawn(process.execPath, [target], { stdio: "inherit", cwd: process.cwd() });
child.on("exit", (code) => process.exit(code ?? 0));
