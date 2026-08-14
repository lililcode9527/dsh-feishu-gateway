// Deterministic unit tests for the relay: approvals (card+text), questions,
// turn/end delivery, progress, images, files, workspace adoption, and the
// per-chat session pool (/new /switch /list) — with a mock DshClient.
// Run: node test/relay.test.mjs
import { TurnRelay } from "../src/relay.js";
import { SessionStore } from "../src/store.js";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMockDsh() {
  const calls = [];
  const responses = new Map();
  const sequences = new Map();
  const respondCalls = [];
  const frameCbs = [];
  return {
    calls,
    respondCalls,
    call: async (method, payload) => {
      calls.push({ method, payload });
      const seq = sequences.get(method);
      if (seq && seq.length) {
        const v = seq.shift();
        if (v instanceof Error) throw v;
        return v;
      }
      const v = responses.get(method);
      if (v instanceof Error) throw v;
      return v ?? { accepted: true };
    },
    respond: async (rpcId, value) => {
      respondCalls.push({ rpcId, value });
      return { accepted: true };
    },
    onFrame: (cb) => {
      frameCbs.push(cb);
      return () => {};
    },
    push: (frame) => {
      for (const cb of frameCbs) cb(frame);
    },
    __set: (method, value) => responses.set(method, value),
    __setSeq: (method, values) => sequences.set(method, [...values]),
  };
}

const tmpRoot = mkdtempSync(join(os.tmpdir(), "dsh-gw-tests-"));
const store = new SessionStore(join(tmpRoot, "sessions.json"));
const outbox = [];
let botSeq = 0;

function makeRelay({ dsh, config = {}, notifyImage, notifyFile, notifyApproval } = {}) {
  botSeq++;
  return new TurnRelay({
    dsh: dsh ?? makeMockDsh(),
    store,
    config: {
      allowedOpenIds: [],
      maxReplyChars: 4000,
      turnTimeoutMs: 60000,
      sessionCwd: "",
      progressThrottleMs: 100000,
      botName: `t${botSeq}`,
      ...config,
    },
    notify: async (o, c, t) => outbox.push(t),
    notifyImage,
    notifyFile,
    notifyApproval,
  });
}

const openId = "ou_t";
const chatId = "oc_t";

// ---------- approval flow (text) ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh });
  dsh.__set("session.create", { sessionId: "s-approval" });
  dsh.__set("session.prompt", { accepted: true });
  await relay.handleText(openId, chatId, "run a command");
  check(outbox.some((t) => t.includes("🤖 已收到")), "prompt ack sent");
  dsh.push({
    type: "server-request",
    rpcId: "rpc-approval-1",
    method: "approval/requested",
    payload: { sessionId: "s-approval", approvalId: "ap-1", toolName: "pwsh", reason: "need shell" },
  });
  check(outbox.some((t) => t.includes("🔐 需要授权") && t.includes("pwsh")), "approval prompt sent (no card notifier)");
  await relay.handleText(openId, chatId, "允许");
  check(
    dsh.respondCalls.some((r) => r.rpcId === "rpc-approval-1" && r.value.approvalId === "ap-1" && r.value.outcome === "allowed-once"),
    "approval respond payload correct"
  );
}

// ---------- question flow ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh });
  dsh.__set("session.create", { sessionId: "s-question" });
  dsh.__set("session.prompt", { accepted: true });
  await relay.handleText(openId, chatId, "ask me");
  dsh.push({
    type: "server-request",
    rpcId: "rpc-question-1",
    method: "question/requested",
    payload: {
      sessionId: "s-question",
      questions: [{ id: "q1", question: "猫还是狗？", options: [{ label: "猫" }, { label: "狗" }] }],
    },
  });
  check(outbox.some((t) => t.includes("❓") && t.includes("1. 猫")), "question rendered with numbered options");
  await relay.handleText(openId, chatId, "2");
  const qRespond = dsh.respondCalls.find((r) => r.rpcId === "rpc-question-1");
  check(
    qRespond && qRespond.value.answer.answers[0].id === "q1" && qRespond.value.answer.answers[0].selected[0] === "狗",
    "question answer maps index -> label"
  );
}

// ---------- turn/end delivers text ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh });
  dsh.__set("session.create", { sessionId: "s-final" });
  dsh.__set("session.prompt", { accepted: true });
  const before = outbox.length;
  await relay.handleText(openId, chatId, "hi");
  dsh.push({
    type: "server-request",
    rpcId: "rpc-x",
    method: "session/event",
    payload: {
      sessionId: "s-final",
      event: { type: "assistant/chunk", seq: 1, time: 0, data: { turn: 1, step: 1, chunk: { type: "block-end", index: 0, block: { type: "text", text: "你好" } } } },
    },
  });
  dsh.push({
    type: "server-request",
    rpcId: "rpc-y",
    method: "session/event",
    payload: { sessionId: "s-final", event: { type: "turn/end", seq: 2, time: 0, data: { turn: 1, reason: { kind: "completed" } } } },
  });
  await sleep(50);
  check(outbox.slice(before).some((t) => t.includes("你好")), "turn/end delivers accumulated text");
}

// ---------- progress notification ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, config: { progressThrottleMs: 1 } });
  dsh.__set("session.create", { sessionId: "s-prog" });
  dsh.__set("session.prompt", { accepted: true });
  await relay.handleText(openId, chatId, "do stuff");
  const before3 = outbox.length;
  dsh.push({
    type: "server-request",
    rpcId: "rpc-p1",
    method: "session/event",
    payload: { sessionId: "s-prog", event: { type: "tool/call", seq: 1, time: 0, data: { turn: 1, step: 1, name: "pwsh", arguments: "{}", callId: "c1" } } },
  });
  await sleep(20);
  check(outbox.slice(before3).some((t) => t.includes("⏳ 进行中") && t.includes("pwsh")), "progress ping lists current tool");
  dsh.push({
    type: "server-request",
    rpcId: "rpc-p2",
    method: "session/event",
    payload: { sessionId: "s-prog", event: { type: "step/start", seq: 2, time: 0, data: { turn: 1, step: 1 } } },
  });
  await sleep(20);
  check(outbox.slice(before3).some((t) => t.includes("已执行 1 步")), "progress ping sent with step count");
}

// ---------- deliverables note ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh });
  dsh.__set("session.create", { sessionId: "s-files" });
  dsh.__set("session.prompt", { accepted: true });
  await relay.handleText(openId, chatId, "create a file");
  const before4 = outbox.length;
  dsh.push({
    type: "server-request",
    rpcId: "rpc-f1",
    method: "session/event",
    payload: { sessionId: "s-files", event: { type: "tool/call", seq: 1, time: 0, data: { turn: 1, step: 1, name: "write", arguments: "{}", callId: "c1" } } },
  });
  dsh.push({
    type: "server-request",
    rpcId: "rpc-f2",
    method: "session/event",
    payload: { sessionId: "s-files", event: { type: "assistant/chunk", seq: 2, time: 0, data: { turn: 1, step: 1, chunk: { type: "block-end", index: 0, block: { type: "text", text: "已创建文件" } } } } },
  });
  dsh.push({
    type: "server-request",
    rpcId: "rpc-f3",
    method: "session/event",
    payload: { sessionId: "s-files", event: { type: "turn/end", seq: 3, time: 0, data: { turn: 1, reason: { kind: "completed" } } } },
  });
  await sleep(50);
  check(outbox.slice(before4).some((t) => t.includes("已创建文件") && t.includes("📁")), "final reply notes deliverables location");
}

// ---------- image push ----------
{
  const pushedImages = [];
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, notifyImage: async (o, c, img) => pushedImages.push({ o, c, img }) });
  dsh.__set("session.create", { sessionId: "s-img" });
  dsh.__set("session.prompt", { accepted: true });
  dsh.__set("session.attachment", { attachment: { attachmentId: "att-1", mediaType: "image/png" }, data: "QUJD" });
  await relay.handleText(openId, chatId, "show me a picture");
  dsh.push({
    type: "server-request",
    rpcId: "rpc-i1",
    method: "session/event",
    payload: {
      sessionId: "s-img",
      event: {
        type: "assistant/message",
        seq: 1,
        time: 0,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "看图：" },
              { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png" } },
            ],
          },
        },
      },
    },
  });
  await sleep(50);
  check(
    dsh.calls.some((c) => c.method === "session.attachment" && c.payload.attachmentId === "att-1"),
    "image attachment fetched via session.attachment"
  );
  check(pushedImages.some((p) => p.img.data === "QUJD" && p.img.mediaType === "image/png"), "image pushed to notifier");
  dsh.push({
    type: "server-request",
    rpcId: "rpc-i2",
    method: "session/event",
    payload: {
      sessionId: "s-img",
      event: {
        type: "tool/result",
        seq: 2,
        time: 0,
        data: { message: { role: "tool", content: [{ type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png" } }] } },
      },
    },
  });
  await sleep(50);
  check(pushedImages.filter((p) => p.img.data === "QUJD").length === 1, "duplicate image attachment not re-pushed");
}

// ---------- approval card ----------
{
  const approvalCards = [];
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, notifyApproval: async (o, c, a) => approvalCards.push({ o, c, a }) });
  dsh.__set("session.create", { sessionId: "s-card" });
  dsh.__set("session.prompt", { accepted: true });
  await relay.handleText(openId, chatId, "run something");
  dsh.push({
    type: "server-request",
    rpcId: "rpc-card-1",
    method: "approval/requested",
    payload: { sessionId: "s-card", approvalId: "ap-9", toolName: "pwsh", reason: "needs shell" },
  });
  await sleep(20);
  check(
    approvalCards.some((c) => c.a.rpcId === "rpc-card-1" && c.a.approvalId === "ap-9" && c.a.toolName === "pwsh"),
    "approval card sent on approval/requested"
  );
  await relay.handleApprovalCard(openId, chatId, { kind: "approval", rpcId: "rpc-card-1", approvalId: "ap-9", sessionId: "s-card", outcome: "allowed-once" });
  check(
    dsh.respondCalls.some((r) => r.rpcId === "rpc-card-1" && r.value.outcome === "allowed-once"),
    "card button press responds with correct payload"
  );
  check(outbox.some((t) => t.includes("✅ 已允许")), "card approval ack sent");
}

// ---------- file push ----------
{
  const tmpDir = mkdtempSync(join(os.tmpdir(), "dsh-gw-files-"));
  const realFile = join(tmpDir, "hello.txt");
  writeFileSync(realFile, "hi-from-gateway");
  const pushedFiles = [];
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, config: { sessionCwd: tmpDir }, notifyFile: async (o, c, f) => pushedFiles.push(f) });
  dsh.__set("session.create", { sessionId: "s-file" });
  dsh.__set("session.prompt", { accepted: true });
  await relay.handleText(openId, chatId, "create a file");
  dsh.push({
    type: "server-request",
    rpcId: "rpc-file-1",
    method: "session/event",
    payload: {
      sessionId: "s-file",
      event: {
        type: "tool/result",
        seq: 1,
        time: 0,
        data: {
          message: { role: "tool", content: [] },
          meta: { diffs: [{ path: realFile, oldText: null, newText: "hi-from-gateway" }, { path: "missing.txt", oldText: null, newText: "x" }] },
        },
      },
    },
  });
  dsh.push({
    type: "server-request",
    rpcId: "rpc-file-2",
    method: "session/event",
    payload: { sessionId: "s-file", event: { type: "turn/end", seq: 2, time: 0, data: { turn: 1, reason: { kind: "completed" } } } },
  });
  await sleep(80);
  check(pushedFiles.some((f) => f.fileName === "hello.txt" && f.buffer.toString() === "hi-from-gateway"), "file pushed from tool-result meta.diffs");
  check(!pushedFiles.some((f) => f.fileName === "missing.txt"), "missing file skipped");
  rmSync(tmpDir, { recursive: true, force: true });
}

// ---------- workspace adoption (会话隔离) ----------
{
  const dsh = makeMockDsh();
  const wsPath = join(tmpRoot, "bot-workspace");
  const relay = makeRelay({ dsh, config: { workspace: wsPath } });
  dsh.__set("workspace.list", { items: [] });
  dsh.__set("workspace.create", { created: true, workspace: { workspaceId: "ws-1", path: wsPath, title: "bot-workspace", sessionIds: [], createdAt: "", updatedAt: "" } });
  dsh.__set("workspace.rename", { workspace: { workspaceId: "ws-1", path: wsPath, title: "飞书-t" } });
  dsh.__set("session.create", { sessionId: "s-ws" });
  dsh.__set("session.prompt", { accepted: true });
  await relay.handleText(openId, chatId, "hi");
  check(
    dsh.calls.some((c) => c.method === "workspace.list"),
    "workspace.list consulted when workspace configured"
  );
  check(
    dsh.calls.some((c) => c.method === "workspace.create" && c.payload.path === wsPath),
    "workspace.create adopts configured directory"
  );
  check(
    dsh.calls.some((c) => c.method === "session.create" && c.payload.workspaceId === "ws-1"),
    "session.create uses workspaceId (isolation from GUI workspace)"
  );
  // second chat prompt must reuse cached workspace (no duplicate create)
  dsh.calls.length = 0;
  await relay.handleText(openId, chatId, "again");
  check(
    !dsh.calls.some((c) => c.method === "workspace.create"),
    "workspace resolved once and cached"
  );
}

// ---------- session pool: /new /switch /list ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh });
  dsh.__setSeq("session.create", [{ sessionId: "s-pool-a" }, { sessionId: "s-pool-b" }]);
  dsh.__set("session.prompt", { accepted: true });
  dsh.__set("session.list", { items: [] });
  await relay.handleText(openId, chatId, "first");
  check(store.currentSessionId(relay.botName, openId) === "s-pool-a", "first prompt creates and uses session #1");
  await relay.handleCommand(openId, chatId, "/new");
  check(store.currentSessionId(relay.botName, openId) === "s-pool-b", "/new adds session #2 and makes it current");
  await relay.handleCommand(openId, chatId, "/switch 1");
  check(store.currentSessionId(relay.botName, openId) === "s-pool-a", "/switch 1 returns to session #1");
  await relay.handleCommand(openId, chatId, "/list");
  check(outbox.some((t) => t.includes("1.") && t.includes("2.") && t.includes("▶️")), "/list shows numbered sessions with current marker");
  await relay.handleCommand(openId, chatId, "/switch 9");
  check(outbox.some((t) => t.includes("没有第 9 个会话")), "/switch out of range handled");
}

// ---------- /workspace switch + /list annotation ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, config: { workspace: "C:\\ws-default" } });
  const wsItems = [
    { workspaceId: "ws-harness", path: "C:\\ws-default", title: "harness", sessionIds: ["s-ws1"] },
    { workspaceId: "ws-fly", path: "C:\\ws2", title: "飞书-默认", sessionIds: ["s-ws2"] },
  ];
  dsh.__set("workspace.list", { items: wsItems });
  dsh.__setSeq("session.create", [{ sessionId: "s-ws1" }, { sessionId: "s-ws2" }]);
  dsh.__set("session.prompt", { accepted: true });
  dsh.__set("session.list", { items: [] });
  await relay.handleText(openId, chatId, "first");
  check(
    dsh.calls.some((c) => c.method === "session.create" && c.payload.workspaceId === "ws-harness"),
    "default workspace used for first session"
  );
  await relay.handleCommand(openId, chatId, "/workspace");
  check(
    outbox.some((t) => t.includes("harness") && t.includes("飞书-默认") && t.includes("▶️")),
    "/workspace lists workspaces with current marker"
  );
  await relay.handleCommand(openId, chatId, "/workspace 2");
  await relay.handleCommand(openId, chatId, "/new");
  check(
    dsh.calls.some((c) => c.method === "session.create" && c.payload.workspaceId === "ws-fly"),
    "/workspace <n> switches active workspace for new sessions"
  );
  await relay.handleCommand(openId, chatId, "/list");
  check(
    outbox.some((t) => t.includes("[harness]") && t.includes("[飞书-默认]")),
    "/list annotates sessions with workspace titles"
  );
}

// ---------- /workspace <path> adopts a new workspace ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, config: { workspace: "" } });
  const adoptedPath = join(tmpRoot, "adopted-ws");
  dsh.__set("workspace.list", { items: [] });
  dsh.__set("workspace.create", { created: true, workspace: { workspaceId: "ws-adopted", path: adoptedPath, title: "adopted-ws", sessionIds: [] } });
  dsh.__set("workspace.rename", { workspace: {} });
  await relay.handleCommand(openId, chatId, `/workspace ${adoptedPath}`);
  check(relay.activeWorkspaceId === "ws-adopted", "/workspace <path> adopts a new workspace");
  check(
    dsh.calls.some((c) => c.method === "workspace.create" && c.payload.path === adoptedPath),
    "workspace.create called with given path"
  );
}

// ---------- /list attaches orphan sessions ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, config: { workspace: "C:\\ws-default" } });
  dsh.__set("workspace.list", { items: [{ workspaceId: "ws-harness", path: "C:\\ws-default", title: "harness", sessionIds: ["s-known"] }] });
  dsh.__set("workspace.insertSessionBefore", { workspace: {} });
  store.addSession(relay.botName, openId, "s-known");
  store.addSession(relay.botName, openId, "s-orphan");
  await relay.handleCommand(openId, chatId, "/list");
  check(
    dsh.calls.some((c) => c.method === "workspace.insertSessionBefore" && c.payload.workspaceId === "ws-harness" && c.payload.sessionId === "s-orphan"),
    "/list attaches orphan pool session to active workspace"
  );
}

// ---------- /list shows session titles ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, config: { workspace: "C:\\ws-default" } });
  dsh.__set("workspace.list", { items: [{ workspaceId: "ws-1", path: "C:\\ws-default", title: "harness", sessionIds: ["s-titled"] }] });
  dsh.__set("session.history", { projections: { values: { title: "写文件测试" } } });
  store.addSession(relay.botName, openId, "s-titled");
  await relay.handleCommand(openId, chatId, "/list");
  check(outbox.some((t) => t.includes("写文件测试") && t.includes("s-titled")), "/list shows session titles");
}

// ---------- /switch can target any session (global numbering) ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, config: { workspace: "C:\\ws-default" } });
  dsh.__set("workspace.list", { items: [{ workspaceId: "ws-1", path: "C:\\ws-default", title: "harness", sessionIds: ["s-pool1", "s-other"] }] });
  dsh.__set("session.history", { projections: { values: { title: "x" } } });
  store.addSession(relay.botName, openId, "s-pool1");
  await relay.handleCommand(openId, chatId, "/switch 2");
  check(store.currentSessionId(relay.botName, openId) === "s-other", "/switch <n> targets any listed session (incl. non-pool)");
  check(store.listSessions(relay.botName, openId).includes("s-other"), "switched session recorded in pool");
}

// ---------- /list filters out archived sessions ----------
{
  const dsh = makeMockDsh();
  const relay = makeRelay({ dsh, config: { workspace: "C:\\ws-default" } });
  dsh.__set("workspace.list", {
    items: [{ workspaceId: "ws-1", path: "C:\\ws-default", title: "harness", sessionIds: ["s-live", "s-arch"] }],
    archivedSessionIds: ["s-arch"],
  });
  dsh.__set("session.history", { projections: { values: { title: "t" } } });
  await relay.handleCommand(openId, chatId, "/list");
  const listLines = (outbox[outbox.length - 1] ?? "").split("\n");
  check(listLines.some((l) => l.includes("s-live")), "/list keeps live sessions");
  check(!listLines.some((l) => l.includes("s-arch")), "/list filters out archived sessions");
}

// ---------- legacy store migration ----------
{
  const legacyStore = new SessionStore(join(tmpRoot, "legacy.json"));
  legacyStore.data[openId] = "s-old-session";
  legacyStore.save();
  check(legacyStore.currentSessionId("default", openId) === "s-old-session", "legacy string mapping migrated to pool");
  check(legacyStore.listSessions("default", openId).length === 1, "legacy pool has one session");
}

rmSync(tmpRoot, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
