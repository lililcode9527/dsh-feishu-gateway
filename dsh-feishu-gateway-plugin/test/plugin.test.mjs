// Plugin unit tests: module shape, feishu_send tool registration/execution,
// admin route registration, and config-dir override.
// Uses a mock ctx (no real agents / Feishu / DSH).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { apply, inject, name } from "../index.js";

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

// isolated config dir
const cfgDir = mkdtempSync(join(os.tmpdir(), "dsh-gw-plugin-"));
process.env.DSH_FEISHU_CONFIG_DIR = cfgDir;

// mock ctx
const tools = [];
const routes = [];
const agents = {
  create: async () => {
    throw new Error("not used");
  },
  resume: async () => {
    throw new Error("not used");
  },
  roots: () => [],
  list: () => [],
};
const ctx = {
  get: (k) => {
    if (k === "agents") return agents;
    if (k === "sandboxPolicy") return { workspaceRoot: join(cfgDir, "ws") };
    return undefined;
  },
  interval: () => () => {},
  effect: (fn) => fn(),
  webServer: {
    port: 3080,
    register: (route) => routes.push(route),
  },
  tools: { register: (tool) => tools.push(tool) },
};

apply(ctx);

check(name === "feishu-gateway-plugin", "plugin name correct");
check(inject.includes("agents") && inject.includes("tools") && inject.includes("webServer"), "inject lists required services");
check(tools.some((t) => t.name === "feishu_send"), "feishu_send tool registered");
check(routes.some((r) => r.path === "/feishu/admin/status"), "admin status route registered");
check(routes.some((r) => r.path === "/feishu/admin/config"), "admin config route registered");
check(routes.some((r) => r.path === "/feishu/admin/send-test"), "admin send-test route registered");
check(routes.some((r) => r.path === "/feishu/admin/delete-bot"), "admin delete-bot route registered");
check(routes.some((r) => r.path === "/feishu/admin/onboard"), "admin onboard route registered");
check(routes.some((r) => r.path === "/feishu/admin/onboard/poll"), "admin onboard/poll route registered");
check(routes.some((r) => r.path === "/feishu/admin/panel"), "admin panel route registered");

// panel serves the settings HTML
{
  const panel = routes.find((r) => r.path === "/feishu/admin/panel");
  const res = { statusCode: 0, headers: {}, body: "", writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(b) { this.body = b; } };
  await panel.handler({ method: "GET" }, res);
  check(res.statusCode === 200 && res.body.includes("飞书网关设置") && res.body.includes("startOnboard"), "panel serves settings HTML with scan-to-create UI");
}

// feishu_send with no configured bot -> clear error
{
  const tool = tools.find((t) => t.name === "feishu_send");
  const res = await tool.execute({ text: "hi" });
  check(res.ok === false && String(res.detail).includes("没有已配置"), "feishu_send errors clearly when no bot configured");
}

// feishu_send with a bot in config but not started -> no chat target error
{
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ bots: [{ name: "b1", appId: "cli_0000000000000000", appSecret: "s", workspace: cfgDir }] }));
  // re-apply in a fresh context to pick up config? ensureBots runs on a 5s timer which the mock never fires,
  // so the bots map stays empty; feishu_send falls back to readConfig list -> makeBot with empty cfg.
  const tool = tools.find((t) => t.name === "feishu_send");
  const res = await tool.execute({ text: "hi", appId: "cli_0000000000000000" });
  check(res.ok === false, "feishu_send with unknown/unstarted bot returns a controlled error");
}

rmSync(cfgDir, { recursive: true, force: true });
delete process.env.DSH_FEISHU_CONFIG_DIR;
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
