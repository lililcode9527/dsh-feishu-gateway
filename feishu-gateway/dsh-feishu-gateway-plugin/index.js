// dsh-feishu-gateway-plugin — DSH deep-integration host plugin.
// Bridges Feishu (Lark) chats with dedicated agent sessions created through
// ctx.agents (per-chat session pools, workspace-bound, model-injected), with
// native feishu_send tool, approval/question cards (via the api-proxy mux +
// /api/respond), progress pings, image/file delivery, and admin routes for a
// settings-page client.
//
// Config: ~/.dsh-feishu/config.json  { bots: [{ name, appId, appSecret, workspace, allowedOpenIds?, ownerOpenId? }] }
// State:  ~/.dsh-feishu/state-<appId>.json  (per-chat session pools)

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, isAbsolute, resolve, basename } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { FeishuBot } from "./lib/feishu.js";
import { DshClient } from "./lib/dsh.js";

export const name = "feishu-gateway-plugin";
export const inject = ["agents", "timer", "webServer", "tools"];

const baseConfigDir = () => process.env.DSH_FEISHU_CONFIG_DIR || join(homedir(), ".dsh-feishu");
const configPath = () => join(baseConfigDir(), "config.json");
const statePath = (appId) => join(baseConfigDir(), `state-${String(appId).replace(/[^a-zA-Z0-9]/g, "")}.json`);

const norm = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : "");

function readJson(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  return fallback;
}
function writeJson(file, value) {
  try {
    mkdirSync(join(homedir(), ".dsh-feishu"), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (err) {
    console.log(`[feishu-gw] state save failed: ${err.message}`);
  }
}

export function apply(ctx) {
  // ---- shared services ----
  const agents = ctx.get("agents");
  const sandboxPolicy = ctx.get("sandboxPolicy");
  const workspaceRoot = () => (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === "string" ? sandboxPolicy.workspaceRoot : undefined);
  const dshBase = `http://127.0.0.1:${ctx.webServer?.port ?? 3080}`;
  const dsh = new DshClient(dshBase);

  // ---- process-local state ----
  const bots = new Map(); // appId -> Bot runtime
  const sessionOwner = new Map(); // dedicated sessionId -> { botName, chatId, openId }
  const pendingQuestion = new Map(); // openId -> { rpcId, sessionId, questions }
  const pendingApproval = new Map(); // openId -> { rpcId, sessionId, approvalId }
  const seen = new Map(); // `${appId}:${messageId}` -> expiry
  const MAX_SEEN = 2000;
  let lastConfigCheck = 0;

  // ---- config ----
  function normalizeConfig(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    let list = Array.isArray(value.bots) ? value.bots : [];
    if (list.length === 0 && value.appId) list = [value];
    const out = [];
    for (const b of list) {
      if (!b || typeof b.appId !== "string" || !b.appId) continue;
      out.push({
        name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : b.appId,
        workspace: typeof b.workspace === "string" ? b.workspace : "",
        appId: b.appId.trim(),
        appSecret: typeof b.appSecret === "string" ? b.appSecret : "",
        allowedOpenIds: Array.isArray(b.allowedOpenIds) ? b.allowedOpenIds : [],
        ownerOpenId: typeof b.ownerOpenId === "string" ? b.ownerOpenId : "",
      });
    }
    return out;
  }
  const readConfig = () => normalizeConfig(readJson(configPath(), {}));

  // ---- agent session helpers (dedicated, workspace-bound, model-injected) ----
  const defaultAgentOptions = () => {
    const sel = ctx.get("agentDefaultModel");
    const cur = sel && typeof sel.currentSelection === "function" ? sel.currentSelection() : undefined;
    return cur && cur.provider && cur.model ? { provider: cur.provider, model: cur.model } : undefined;
  };
  async function createDedicated(bot, sessionId, mainAgent) {
    const cfg = bot.cfg;
    const opts = defaultAgentOptions();
    return agents.create({
      sessionId,
      meta: {
        cwd: (cfg.workspace && String(cfg.workspace).trim()) || workspaceRoot() || undefined,
        ...mainAgent && mainAgent.session?.header?.agentPreset ? { agentPreset: mainAgent.session.header.agentPreset } : {},
      },
      ...opts ? { agentOptions: opts } : {},
      setup: async (agentCtx) => {
        const presets = agentCtx.get("agentPresets");
        if (!presets) return;
        try {
          if (mainAgent) presets.composeFrom(agentCtx, mainAgent.ctx);
          else await presets.mount(agentCtx);
        } catch (err) {
          console.log(`[feishu-gw] preset setup failed: ${err.message}`);
        }
      },
    });
  }
  async function resumeDedicated(bot, sessionId, mainAgent) {
    const opts = defaultAgentOptions();
    return agents.resume({
      resumeSessionId: sessionId,
      ...opts ? { agentOptions: opts } : {},
      setup: async (agentCtx) => {
        if (!mainAgent) return;
        const presets = agentCtx.get("agentPresets");
        if (!presets) return;
        try {
          presets.composeFrom(agentCtx, mainAgent.ctx);
        } catch (err) {
          console.log(`[feishu-gw] resume composeFrom failed: ${err.message}`);
        }
      },
    });
  }
  const chatSessionId = (chatId, n) => `feishu-${String(chatId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}-${n}-${Date.now().toString(36)}`;

  // ---- per-bot runtime ----
  function makeBot(cfg) {
    const bot = {
      cfg,
      feishu: null,
      status: "",
      chain: Promise.resolve(),
      lastChatId: "",
      chats: new Map(),
      stateCache: undefined,
    };
    bot.ensureChat = async (chatId) => {
      const hit = bot.chats.get(chatId);
      if (hit) return hit;
      const state = bot.loadState();
      const record = state.chats?.[chatId];
      const chat = { sessions: [], activeIndex: 0 };
      if (record && Array.isArray(record.sessions) && record.sessions.length > 0) {
        for (const s of record.sessions) {
          chat.sessions.push({ id: String(s.id), label: typeof s.label === "string" && s.label ? s.label : "会话" });
        }
        const ai = record.sessions.findIndex((s) => s && s.id === record.active);
        chat.activeIndex = ai >= 0 ? ai : 0;
      }
      bot.chats.set(chatId, chat);
      return chat;
    };
    bot.loadState = () => {
      if (bot.stateCache !== undefined) return bot.stateCache;
      bot.stateCache = readJson(statePath(cfg.appId), { chats: {} });
      return bot.stateCache;
    };
    bot.saveState = () => writeJson(statePath(cfg.appId), bot.loadState());
    bot.persistChat = async (chatId, chat) => {
      const state = bot.loadState();
      if (!state.chats) state.chats = {};
      state.chats[chatId] = {
        sessions: chat.sessions.map((s) => ({ id: s.id, label: s.label })),
        active: chat.sessions[chat.activeIndex] ? chat.sessions[chat.activeIndex].id : (chat.sessions[0]?.id ?? ""),
      };
      bot.saveState();
    };
    bot.resolveActiveAgent = async (chat, mainAgent) => {
      const entry = chat.sessions[chat.activeIndex];
      if (!entry) return undefined;
      if (entry.handle) return entry.handle.agent;
      try {
        const handle = await resumeDedicated(bot, entry.id, mainAgent);
        entry.handle = handle;
        const sid = entry.id;
        sessionOwner.set(sid, { botName: cfg.name, chatId: chatIdOf(bot, chat), openId: "" });
        return handle.agent;
      } catch (err) {
        console.log(`[feishu-gw] resume failed ${entry.id}: ${err.message}`);
        return undefined;
      }
    };
    return bot;
  }
  // reverse chat lookup for sessionOwner (chatId is the key in bot.chats)
  function chatIdOf(bot, chat) {
    for (const [k, v] of bot.chats) if (v === chat) return k;
    return "";
  }

  // ---- Feishu message flow ----
  function extractReply(events, fromIdx) {
    let reply = "";
    for (let i = fromIdx; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type !== "assistant/message") continue;
      const blocks = ev.data?.message?.content ?? [];
      let text = "";
      for (const b of blocks) if (b?.type === "text" && typeof b.text === "string") text += b.text;
      if (text.trim()) reply = text;
    }
    return reply.trim();
  }
  function collectFiles(events, fromIdx) {
    const paths = [];
    for (let i = fromIdx; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type !== "tool/result") continue;
      const diffs = ev.data?.meta?.diffs;
      if (Array.isArray(diffs)) for (const d of diffs) if (typeof d?.path === "string" && d.path) paths.push(d.path);
    }
    return paths;
  }
  function collectImages(events, fromIdx) {
    const refs = [];
    for (let i = fromIdx; i < events.length; i++) {
      const ev = events[i];
      if (!ev || (ev.type !== "assistant/message" && ev.type !== "tool/result")) continue;
      const blocks = ev.data?.message?.content ?? ev.data?.content ?? [];
      const walk = (list) => {
        for (const b of list ?? []) {
          if (b?.type === "image" && b.attachment?.attachmentId) refs.push(b.attachment);
          if (Array.isArray(b?.content)) walk(b.content);
        }
      };
      walk(blocks);
    }
    return refs;
  }

  async function pushFiles(bot, chatId, paths) {
    const cfg = bot.cfg;
    const base = cfg.workspace || workspaceRoot() || process.cwd();
    let sent = 0;
    for (const raw of paths.slice(0, 3)) {
      const abs = isAbsolute(raw) ? raw : resolve(base, raw);
      try {
        const st = statSync(abs, { throwIfNoEntry: false });
        if (!st || !st.isFile() || st.size === 0 || st.size > 20 * 1024 * 1024) continue;
        const buffer = readFile(abs);
        await bot.feishu.sendFile(chatId, chatId, { fileName: basename(abs), buffer });
        sent++;
      } catch (err) {
        console.log(`[feishu-gw] file push failed ${abs}: ${err.message}`);
      }
    }
    return sent;
  }
  async function pushImages(bot, chatId, refs, sessionId) {
    for (const ref of refs.slice(0, 5)) {
      try {
        const { attachment, data } = await dsh.call("session.attachment", { sessionId, attachmentId: ref.attachmentId });
        await bot.feishu.sendImage(chatId, chatId, { data, mediaType: attachment?.mediaType ?? ref.mediaType });
      } catch (err) {
        console.log(`[feishu-gw] image push failed: ${err.message}`);
      }
    }
  }

  const COMMANDS = ["help", "new", "switch", "list", "workspace"];
  function resolveCommand(raw) {
    if (!raw) return undefined;
    const exact = COMMANDS.find((c) => c === raw);
    if (exact) return exact;
    const prefix = COMMANDS.filter((c) => c.startsWith(raw));
    return prefix.length === 1 ? prefix[0] : undefined;
  }
  const HELP = [
    "**飞书网关命令**",
    "",
    "/new [名称] — 新建独立会话并切换",
    "/switch <序号> — 切换会话（/list 查看）",
    "/list — 列出本聊天的全部会话",
    "/workspace [序号|名称|路径] — 查看/切换工作区",
    "/help — 帮助",
  ].join("\n");

  async function handleCommand(bot, chatId, line) {
    const parts = String(line).trim().split(/\s+/);
    const cmd = resolveCommand((parts[0] || "").toLowerCase().replace(/^\//, ""));
    if (!cmd) {
      await bot.feishu.sendMarkdown(chatId, chatId, `未知命令 \`${parts[0]}\`，发送 /help 查看。`);
      return;
    }
    const chat = await bot.ensureChat(chatId);
    const mainAgent = pickMainAgent(bot.cfg);
    if (cmd === "help") return bot.feishu.sendMarkdown(chatId, chatId, HELP);
    if (cmd === "list") {
      const lines = ["**会话列表**", ""];
      chat.sessions.forEach((s, i) => lines.push(`${i + 1}. ${s.label}${i === chat.activeIndex ? "（当前）" : ""}`));
      lines.push("", "发送 /switch <序号> 切换");
      return bot.feishu.sendMarkdown(chatId, chatId, lines.join("\n"));
    }
    if (cmd === "new") {
      const label = parts.slice(1).join(" ").trim() || `会话 ${chat.sessions.length + 1}`;
      try {
        const sessionId = chatSessionId(chatId, chat.sessions.length);
        const handle = await createDedicated(bot, sessionId, mainAgent);
        chat.sessions.push({ id: sessionId, label, handle });
        chat.activeIndex = chat.sessions.length - 1;
        sessionOwner.set(sessionId, { botName: bot.cfg.name, chatId, openId: "" });
        await bot.persistChat(chatId, chat);
        return bot.feishu.sendMarkdown(chatId, chatId, `已创建独立会话 **${label}** 并切换。`);
      } catch (err) {
        return bot.feishu.sendMarkdown(chatId, chatId, `创建会话失败：${err.message}`);
      }
    }
    if (cmd === "switch") {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < 1 || n > chat.sessions.length) {
        return bot.feishu.sendMarkdown(chatId, chatId, `无效序号，发送 /list 查看。`);
      }
      chat.activeIndex = n - 1;
      await bot.persistChat(chatId, chat);
      return bot.feishu.sendMarkdown(chatId, chatId, `已切换到 **${chat.sessions[n - 1].label}**。`);
    }
    if (cmd === "workspace") {
      const arg = parts.slice(1).join(" ").trim();
      return bot.feishu.sendMarkdown(chatId, chatId, `工作区由各机器人配置（config.json 的 workspace）决定；切换请编辑配置后重启。当前：\`${bot.cfg.workspace || workspaceRoot() || "未配置"}\``);
    }
  }

  function pickMainAgent(cfg) {
    const target = norm(cfg.workspace || workspaceRoot() || "");
    if (!target) return undefined;
    const matches = (a) => norm(a?.session?.header?.cwd) === target;
    return agents.roots().find(matches) || agents.list().find(matches);
  }

  async function handleFeishuMessage(bot, { openId, chatId, text, messageId }) {
    if (!messageId || !text) return;
    const key = `${bot.cfg.appId}:${messageId}`;
    const now = Date.now();
    if (seen.size > MAX_SEEN) for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (seen.has(key)) return;
    seen.set(key, now + 120000);
    if (chatId) bot.lastChatId = chatId;

    // whitelist
    const allowed = bot.cfg.allowedOpenIds || [];
    if (allowed.length && openId && !allowed.includes(openId)) {
      await bot.feishu.sendMarkdown(chatId, chatId, "⚠️ 未授权的用户。");
      return;
    }

    // pending approval/question reply
    if (pendingApproval.has(openId)) {
      const p = pendingApproval.get(openId);
      const t = text.toLowerCase();
      const outcome = ["允许", "同意", "是", "ok", "yes", "allow", "1"].includes(t) ? "allowed-once" : ["拒绝", "否", "no", "deny", "reject", "0"].includes(t) ? "rejected" : null;
      if (!outcome) return bot.feishu.sendMarkdown(chatId, chatId, "请回复：允许 或 拒绝");
      try {
        const res = await dsh.respond(p.rpcId, { sessionId: p.sessionId, approvalId: p.approvalId, outcome });
        pendingApproval.delete(openId);
        await bot.feishu.sendMarkdown(chatId, chatId, res.accepted ? (outcome === "allowed-once" ? "✅ 已允许，任务继续。" : "🚫 已拒绝。") : "⚠️ 审批未生效（可能已超时）。");
      } catch (err) {
        await bot.feishu.sendMarkdown(chatId, chatId, `❌ 审批失败：${err.message}`);
      }
      return;
    }
    if (pendingQuestion.has(openId)) {
      const p = pendingQuestion.get(openId);
      const q = p.questions[0];
      const opts = q.options ?? [];
      let selected = [text];
      if (opts.length) {
        const idx = Number(text);
        if (Number.isInteger(idx) && idx >= 1 && idx <= opts.length) selected = [opts[idx - 1].label];
        else {
          const hit = opts.find((o) => o.label === text);
          if (hit) selected = [hit.label];
        }
      }
      try {
        const res = await dsh.respond(p.rpcId, { sessionId: p.sessionId, answer: { answers: [{ id: q.id, selected }] } });
        pendingQuestion.delete(openId);
        await bot.feishu.sendMarkdown(chatId, chatId, res.accepted ? `✅ 已回复：${selected.join("、")}` : "⚠️ 回复未生效（可能已超时）。");
      } catch (err) {
        await bot.feishu.sendMarkdown(chatId, chatId, `❌ 回复失败：${err.message}`);
      }
      return;
    }

    // commands
    if (text.startsWith("/")) return handleCommand(bot, chatId, text);

    // bridge to a dedicated session
    const chat = await bot.ensureChat(chatId);
    let agent = await bot.resolveActiveAgent(chat, pickMainAgent(bot.cfg));
    if (!agent) {
      try {
        const sessionId = chatSessionId(chatId, chat.sessions.length);
        const handle = await createDedicated(bot, sessionId, pickMainAgent(bot.cfg));
        agent = handle.agent;
        chat.sessions = [{ id: sessionId, label: "主会话", handle }];
        chat.activeIndex = 0;
        sessionOwner.set(sessionId, { botName: bot.cfg.name, chatId, openId });
        await bot.persistChat(chatId, chat);
      } catch (err) {
        console.log(`[feishu-gw] auto-create failed: ${err.stack ?? err.message}`);
        return bot.feishu.sendMarkdown(chatId, chatId, `创建 Agent 会话失败：${err.message}`);
      }
    }
    const sid = agent.id || chat.sessions[chat.activeIndex].id;
    sessionOwner.set(sid, { botName: bot.cfg.name, chatId, openId });

    await bot.feishu.sendMarkdown(chatId, chatId, "🤖 已收到，开始处理…");
    const seqBefore = agent.session.events.length;
    const message = { id: `feishu-${messageId}`, role: "user", content: [{ type: "text", text: `[飞书 ${openId}] ${text}` }], source: { kind: "user" } };
    agent.send(message, "next-turn", true);

    // progress polling while the turn runs
    const progress = { lastAt: 0, steps: 0, tools: new Set() };
    const poll = ctx.interval(() => {
      const events = agent.session.events;
      for (let i = seqBefore; i < events.length; i++) {
        const ev = events[i];
        if (ev.type === "tool/call") progress.tools.add(ev.data?.name ?? "?");
        if (ev.type === "turn/start") progress.steps++;
      }
      const nowMs = Date.now();
      if ((progress.tools.size || progress.steps) && nowMs - progress.lastAt >= 10000) {
        progress.lastAt = nowMs;
        const parts = [`⏳ 进行中：已执行 ${progress.steps} 步`];
        if (progress.tools.size) parts.push(`正在调用：${[...progress.tools].join("、")}`);
        void bot.feishu.sendMarkdown(chatId, chatId, parts.join("，")).catch(() => {});
        progress.tools = new Set();
      }
    }, 3000);

    try {
      await agent.whenIdle();
    } catch (err) {
      console.log(`[feishu-gw] turn wait failed: ${err.message}`);
      return;
    } finally {
      poll();
    }

    const events = agent.session.events;
    const reply = extractReply(events, seqBefore) || "（Agent 未产生文字回复）";
    const files = collectFiles(events, seqBefore);
    const images = collectImages(events, seqBefore);
    const toolsUsed = new Set();
    for (let i = seqBefore; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === "tool/call" && ev.data?.name) toolsUsed.add(ev.data.name);
    }
    const parts = [reply];
    if (toolsUsed.size) parts.push(`🔧 使用工具：${[...toolsUsed].join("、")}`);
    await bot.feishu.sendMarkdown(chatId, chatId, parts.join("\n\n"));
    if (images.length) await pushImages(bot, chatId, images, sid);
    if (files.length) await pushFiles(bot, chatId, files);
  }

  // ---- mux: route questions/approvals to the owning chat ----
  dsh.onFrame((frame) => {
    const p = frame.payload ?? {};
    if (frame.method === "question/requested" && p.sessionId) {
      const owner = sessionOwner.get(p.sessionId);
      if (!owner) return;
      const bot = bots.get(owner.botName);
      if (!bot) return;
      pendingQuestion.set(owner.openId, { rpcId: frame.rpcId, sessionId: p.sessionId, questions: p.questions ?? [] });
      const lines = [];
      for (const q of p.questions ?? []) {
        lines.push(`❓ ${q.header ? `【${q.header}】` : ""}${q.question}`);
        (q.options ?? []).forEach((o, i) => lines.push(`   ${i + 1}. ${o.label}`));
      }
      lines.push("（回复编号选择，如 1；或直接输入答案）");
      void bot.feishu.sendMarkdown(owner.chatId, owner.chatId, lines.join("\n")).catch(() => {});
      return;
    }
    if (frame.method === "approval/requested" && p.sessionId) {
      const owner = sessionOwner.get(p.sessionId);
      if (!owner) return;
      const bot = bots.get(owner.botName);
      if (!bot) return;
      pendingApproval.set(owner.openId, { rpcId: frame.rpcId, sessionId: p.sessionId, approvalId: p.approvalId });
      void bot.feishu
        .sendApprovalCard(owner.chatId, owner.chatId, {
          toolName: p.toolName,
          reason: p.reason,
          rpcId: frame.rpcId,
          approvalId: p.approvalId,
          sessionId: p.sessionId,
        })
        .catch(() => {});
    }
  });

  // ---- lifecycle: one FeishuBot per configured bot, hot-read config ----
  async function ensureBots() {
    const now = Date.now();
    if (now - lastConfigCheck < 10000) return;
    lastConfigCheck = now;
    const list = readConfig();
    for (const [appId, bot] of bots) {
      if (!list.some((c) => c.appId === appId)) {
        try {
          bot.feishu?.stop();
        } catch {}
        bots.delete(appId);
      }
    }
    for (const cfg of list) {
      let bot = bots.get(cfg.appId);
      if (!bot) {
        bot = makeBot(cfg);
        bots.set(cfg.appId, bot);
      } else {
        bot.cfg = cfg;
      }
      if (!bot.feishu) {
        bot.feishu = new FeishuBot({ appId: cfg.appId, appSecret: cfg.appSecret });
        bot.feishu.onMessage(async (msg) => {
          bot.chain = bot.chain.then(() => handleFeishuMessage(bot, msg)).catch((err) => {
            console.log(`[feishu-gw] handler error: ${err.stack ?? err.message}`);
          });
        });
        bot.feishu.onCardAction(async ({ openId, chatId, value }) => {
          if (value?.kind !== "approval" || !value.rpcId || !value.approvalId || !value.sessionId) return;
          try {
            const res = await dsh.respond(value.rpcId, { sessionId: value.sessionId, approvalId: value.approvalId, outcome: value.outcome });
            pendingApproval.delete(openId);
            await bot.feishu.sendMarkdown(chatId ?? openId, chatId, res.accepted ? (value.outcome === "allowed-once" ? "✅ 已允许，任务继续。" : "🚫 已拒绝。") : "⚠️ 审批未生效（可能已超时）。");
          } catch (err) {
            await bot.feishu.sendMarkdown(chatId ?? openId, chatId, `❌ 审批失败：${err.message}`);
          }
        });
        try {
          await bot.feishu.start();
          bot.status = "connected";
          console.log(`[feishu-gw] bot "${cfg.name}" long connection ready`);
        } catch (err) {
          bot.status = `error: ${err.message}`;
          console.log(`[feishu-gw] bot "${cfg.name}" start failed: ${err.message}`);
        }
      }
    }
  }

  // ---- feishu_send tool (native) ----
  const tool = defineTool({
    name: "feishu_send",
    description: "Proactively send a message (markdown supported) to the user's Feishu chat through a configured bot. chatId optional (defaults to the most recent chat that messaged the bot); appId optional (defaults to the bot that last received a message).",
    parameters: {
      text: { type: "string", required: true, description: "Message text (markdown: **bold**, `code`, lists, links)." },
      chatId: { type: "string", description: "Target Feishu chat id (oc_...). Omit to send to the most recent chat." },
      appId: { type: "string", description: "Bot app id (cli_...) to send through. Omit for the most recently active bot." },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true }, detail: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: `feishu_send -> ${JSON.stringify(value)}` }],
    },
    async execute(args) {
      const list = readConfig();
      let bot;
      if (args.appId) {
        bot = bots.get(args.appId) || makeBot(list.find((c) => c.appId === args.appId) || {});
        if (!bot.cfg.appId) return { ok: false, detail: `未找到 appId=${args.appId} 的机器人` };
      } else {
        bot = [...bots.values()].sort((a, b) => String(b.lastChatId).localeCompare(String(a.lastChatId)))[0];
        if (!bot) return { ok: false, detail: "没有已配置的机器人" };
      }
      const target = args.chatId || bot.lastChatId;
      if (!target) return { ok: false, detail: "没有可用的 chat_id：先给机器人发条消息，或指定 chatId" };
      try {
        await bot.feishu.sendMarkdown(target, target, String(args.text));
        return { ok: true, detail: "sent" };
      } catch (err) {
        return { ok: false, detail: String(err.message) };
      }
    },
  });

  // ---- admin routes (settings-page client) ----
  const respondJson = (res, status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req, max) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > max) return req.destroy(new Error("too large"));
        chunks.push(c.toString("utf8"));
      });
      req.on("end", () => resolve(chunks.join("")));
      req.on("error", reject);
    });

  function route(path, method, handler) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => {
          if (req.method !== method) return respondJson(res, 405, { ok: false, message: "method not allowed" });
          void handler(req, res);
        },
      })
    );
  }

  route("/feishu/admin/status", "GET", async (req, res) => {
    respondJson(res, 200, {
      bots: readConfig().map((cfg) => {
        const bot = bots.get(cfg.appId);
        return { name: cfg.name, workspace: cfg.workspace, appId: cfg.appId, hasSecret: !!cfg.appSecret, connection: bot?.status || "idle", lastChatId: bot?.lastChatId || "" };
      }),
    });
  });
  route("/feishu/admin/config", "POST", async (req, res) => {
    let body;
    try {
      body = JSON.parse(await readBody(req, 65536));
    } catch {
      return respondJson(res, 400, { ok: false, message: "invalid json" });
    }
    const current = readConfig();
    const incoming = Array.isArray(body.bots) ? body.bots : [];
    const next = incoming
      .filter((b) => b && b.appId)
      .map((b) => {
        const prev = current.find((c) => c.appId === String(b.appId).trim());
        return {
          name: String(b.name || "").trim() || String(b.appId).trim(),
          workspace: String(b.workspace || "").trim(),
          appId: String(b.appId).trim(),
          appSecret: String(b.appSecret || "").trim() || (prev ? prev.appSecret : ""),
          allowedOpenIds: Array.isArray(b.allowedOpenIds) ? b.allowedOpenIds : [],
          ownerOpenId: String(b.ownerOpenId || "").trim() || (prev ? prev.ownerOpenId : ""),
        };
      });
    writeJson(configPath(), { bots: next });
    lastConfigCheck = 0;
    void ensureBots();
    respondJson(res, 200, { ok: true, message: `已保存到 ${configPath()}` });
  });
  route("/feishu/admin/delete-bot", "POST", async (req, res) => {
    let body;
    try {
      body = JSON.parse(await readBody(req, 65536)) || {};
    } catch {
      return respondJson(res, 400, { ok: false, message: "invalid json" });
    }
    const list = readConfig();
    const next = list.filter((c) => c.appId !== body.appId);
    if (next.length === list.length) return respondJson(res, 404, { ok: false, message: "bot not found" });
    writeJson(configPath(), { bots: next });
    const bot = bots.get(body.appId);
    if (bot) {
      try {
        bot.feishu?.stop();
      } catch {}
      bots.delete(body.appId);
    }
    respondJson(res, 200, { ok: true, message: "已删除" });
  });
  route("/feishu/admin/send-test", "POST", async (req, res) => {
    let body;
    try {
      body = JSON.parse(await readBody(req, 65536)) || {};
    } catch {
      return respondJson(res, 400, { ok: false, message: "invalid json" });
    }
    const bot = bots.get(body.appId);
    if (!bot) return respondJson(res, 200, { ok: false, detail: "未找到该机器人" });
    try {
      await bot.feishu.sendMarkdown(body.chatId || bot.lastChatId, body.chatId || bot.lastChatId, String(body.text || "测试消息"));
      respondJson(res, 200, { ok: true, detail: "sent" });
    } catch (err) {
      respondJson(res, 200, { ok: false, detail: String(err.message) });
    }
  });

  // ---- lifecycle ----
  dsh.connect();
  ctx.effect(() => {
    const timer = ctx.interval(() => void ensureBots(), 5000);
    return () => {
      timer();
      dsh.close();
      for (const bot of bots.values()) {
        try {
          bot.feishu?.stop();
        } catch {}
      }
      bots.clear();
    };
  });

  ctx.effect(() => ctx.tools.register(tool));

  console.log(`[feishu-gw] plugin active (config: ${configPath()}, dsh: ${dshBase})`);
  void ensureBots();
}
