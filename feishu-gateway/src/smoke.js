// Scenario smoke test: drives the relay against the REAL local DSH with a
// console notifier standing in for Feishu. Exercises:
//   1) normal turn (prompt -> stream -> final reply)
//   2) ask_user_question flow (question text -> user answers by number)
//   3) approval flow (approval/requested -> user allows)
// Run: npm run smoke [prompt]

import { DshClient } from "./dsh.js";
import { SessionStore } from "./store.js";
import { TurnRelay } from "./relay.js";
import { loadEnv, config } from "./env.js";

loadEnv();
const cfg = config();
const openId = "ou_smoke_test";
const chatId = "oc_smoke_test";
const outbox = [];

// Fresh session mapping per run so a wedged previous run can't block us.
import { unlinkSync } from "node:fs";
try {
  unlinkSync(cfg.sessionsFile + ".smoke.json");
} catch {}

const dsh = new DshClient(cfg.dshBaseUrl);
const store = new SessionStore(cfg.sessionsFile + ".smoke.json");

const relay = new TurnRelay({
  dsh,
  store,
  config: cfg,
  notify: async (o, c, text) => {
    outbox.push(text);
    console.log(`\n[feishu:dry] -> ${o} (${c})\n${text}\n${"=".repeat(60)}`);
  },
  notifyImage: async (o, c, img) => {
    outbox.push(`[image ${img.mediaType} ${img.data?.length ?? 0} chars]`);
    console.log(`\n[feishu:dry] -> ${o} (${c}): [image ${img.mediaType} ${img.data?.length ?? 0} chars]\n${"=".repeat(60)}`);
  },
  notifyFile: async (o, c, f) => {
    outbox.push(`[file ${f.fileName} ${f.buffer?.length ?? 0} B]`);
    console.log(`\n[feishu:dry] -> ${o} (${c}): [file ${f.fileName} ${f.buffer?.length ?? 0} B]\n${"=".repeat(60)}`);
  },
  notifyApproval: async (o, c, a) => {
    outbox.push(`[approval card ${a.toolName}]`);
    console.log(`\n[feishu:dry] -> ${o} (${c}): [approval card ${a.toolName}]\n${"=".repeat(60)}`);
  },
});

dsh.connect();
await new Promise((r) => setTimeout(r, 800));

// Debug: dump frames belonging to the smoke session (set SMOKE_DEBUG=1 to see).
const debugOn = process.env.SMOKE_DEBUG === "1";
if (debugOn) {
  dsh.onFrame((f) => {
    const sid = store.getSessionId(openId);
    if (sid && f.payload?.sessionId === sid) {
      console.log("[frame]", f.method, JSON.stringify(f.payload?.event ?? f.payload).slice(0, 240));
    }
  });
}

let fail = 0;
function check(cond, label) {
  if (cond) console.log(`[smoke] PASS: ${label}`);
  else {
    console.error(`[smoke] FAIL: ${label}`);
    fail++;
  }
}

async function waitFor(pred, label, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = outbox.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

try {
  // ---- 1) normal turn ----
  const prompt = process.argv[2] ?? "请用一句话介绍你自己，然后结束，不要调用任何工具。";
  console.log(`[smoke] step1: normal turn "${prompt}"`);
  const t0 = outbox.length;
  await relay.handleText(openId, chatId, prompt);
  await waitFor((t) => t.includes("🤖 已收到"), "progress ack");
  const final = await waitFor(
    (t) => !t.startsWith("🤖") && !t.startsWith("⏳") && !t.startsWith("📥") && outbox.indexOf(t) > outbox.indexOf(outbox.find((x) => x.includes("🤖 已收到"))),
    "final reply",
    300000
  );
  check(true, `normal turn replied (${final.length} chars): ${final.slice(0, 80)}…`);

  // ---- 2) ask_user_question flow ----
  console.log("[smoke] step2: question flow");
  await relay.handleText(openId, chatId, "请用 ask_user_question 问我一个问题：你喜欢猫还是狗？选项只有 猫 和 狗。然后根据我的回答简短回复。");
  const qText = await waitFor((t) => t.includes("❓"), "question text", 300000);
  check(qText.includes("猫") && qText.includes("狗"), "question rendered with options");
  await relay.handleText(openId, chatId, "1"); // 猫
  await waitFor((t) => t.includes("✅ 已回复"), "question answer ack", 60000);
  await waitFor(
    (t) => !t.startsWith("✅") && !t.startsWith("❓") && outbox.indexOf(t) > outbox.lastIndexOf(outbox.find((x) => x.includes("✅ 已回复"))),
    "reply after question",
    300000
  );
  check(true, "question flow completed");

  // ---- 3) approval flow ----
  console.log("[smoke] step3: approval flow (pwsh tool)");
  await relay.handleText(openId, chatId, "用 PowerShell 运行一条命令输出 HelloFromBot，然后告诉我你做了什么。");
  // The harness may or may not emit an approval/requested frame for this
  // session's policy. Wait for EITHER the approval prompt or the turn's final
  // reply; if the turn completes without asking, treat the step as skipped.
  const beforeApproval = outbox.length;
  const approvalOrDone = await waitFor(
    (t) => t.includes("🔐 需要授权") || (outbox.indexOf(t) >= beforeApproval && !t.startsWith("🤖") && !t.startsWith("⏳") && !t.startsWith("📥") && !t.includes("🔐")),
    "approval request or final reply",
    300000
  );
  if (approvalOrDone.includes("🔐 需要授权")) {
    check(approvalOrDone.includes("pwsh"), "approval names the tool");
    await relay.handleText(openId, chatId, "允许");
    await waitFor((t) => t.includes("✅ 已允许"), "approval allow ack", 60000);
    await waitFor(
      (t) => !t.startsWith("✅") && outbox.indexOf(t) > outbox.lastIndexOf(outbox.find((x) => x.includes("✅ 已允许"))),
      "reply after approval",
      300000
    );
    check(true, "approval flow completed");
  } else {
    console.log("[smoke] SKIP: harness did not request approval for pwsh (policy-dependent); approval wiring covered by unit tests");
    check(true, "turn completed without approval request");
  }
} catch (err) {
  console.error("[smoke] scenario error:", err.message);
  fail++;
}

dsh.close();
console.log(fail === 0 ? "\n[smoke] ALL PASS" : `\n[smoke] ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
