// dsh-feishu-gateway-plugin — DSH deep-integration host plugin.
// Bridges Feishu (Lark) chats with the DESKTOP's current agent session in the
// configured workspace: phone messages go straight into the session the user
// is looking at (most recently active in the bot's workspace), with native
// feishu_send tool, approval/question cards (via the api-proxy mux +
// /api/respond), progress pings, image/file delivery, and admin routes for a
// settings-page panel.
//
// Config: ~/.dsh-feishu/config.json  { bots: [{ name, appId, appSecret, workspace, allowedOpenIds?, ownerOpenId? }] }

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, isAbsolute, resolve, basename } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { FeishuBot } from "./lib/feishu.js";
import { DshClient } from "./lib/dsh.js";
import { adminPanelHtml } from "./lib/admin-panel.js";

export const name = "feishu-gateway-plugin";
export const inject = ["agents", "timer", "webServer", "tools"];

const baseConfigDir = () => process.env.DSH_FEISHU_CONFIG_DIR || join(homedir(), ".dsh-feishu");
const configPath = () => join(baseConfigDir(), "config.json");

const norm = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : "");

function readJson(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); // strip UTF-8 BOM
  } catch {}
  return fallback;
}
function writeJson(file, value) {
  try {
    mkdirSync(baseConfigDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (err) {
    console.log(`[feishu-gw] save failed: ${err.message}`);
  }
}

export function apply(ctx) {
  // ---- shared services ----
  const agents = ctx.get("agents");
  const sandboxPolicy = ctx.get("sandboxPolicy");
  const workspaceRoot = () => (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === "string" ? sandboxPolicy.workspaceRoot : undefined);
  const dshPort = ctx.webServer?.config?.port ?? ctx.webServer?.port ?? 3080;
  const dshBase = `http://127.0.0.1:${dshPort}`;
  const dsh = new DshClient(dshBase);

  // ---- process-local state ----
  const bots = new Map(); // appId -> Bot runtime
  const sessionOwner = new Map(); // sessionId -> { botName, chatId, openId }
  const pendingQuestion = new Map(); // openId -> { rpcId, sessionId, questions }
  const pendingApproval = new Map(); // openId -> { rpcId, sessionId, approvalId }
  const seen = new Map(); // `${appId}:${messageId}` -> expiry
  const MAX_SEEN = 2000;
  const timers = new Map(); // `${botName}:${chatId}` -> [{ id, at, text, handle }]
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

  // ---- resolve the DESKTOP current session in the bot's workspace ----
  const defaultAgentOptions = () => {
    const sel = ctx.get("agentDefaultModel");
    const cur = sel && typeof sel.currentSelection === "function" ? sel.currentSelection() : undefined;
    return cur && cur.provider && cur.model ? { provider: cur.provider, model: cur.model } : undefined;
  };

  /** sessionId of the most recently active session in the bot's workspace. */
  async function currentSessionId(cfg) {
    const path = cfg.workspace || workspaceRoot() || "";
    const target = norm(path);
    if (!target) return undefined;
    try {
      const { items: wsList } = await dsh.call("workspace.list", {});
      const ws = wsList.find((w) => norm(w.path) === target);
      if (!ws) return undefined;
      const { items: sessions } = await dsh.call("session.list", {});
      const ids = new Set(ws.sessionIds ?? []);
      const inWs = sessions.filter((s) => ids.has(s.sessionId));
      if (!inWs.length) return undefined;
      inWs.sort((a, b) => b.updatedAt - a.updatedAt);
      return inWs[0].sessionId;
    } catch (err) {
      console.log(`[feishu-gw] currentSessionId failed: ${err.message}`);
      return undefined;
    }
  }

  /** The live agent for that session (resume if not live). */
  async function resolveAgent(sessionId) {
    const live = agents.roots().find((a) => a.id === sessionId) || agents.list().find((a) => a.id === sessionId);
    if (live) return live;
    const opts = defaultAgentOptions();
    try {
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        ...opts ? { agentOptions: opts } : {},
      });
      return handle.agent;
    } catch (err) {
      console.log(`[feishu-gw] resume failed ${sessionId}: ${err.message}`);
      return undefined;
    }
  }

  /** Create a session in the bot's workspace (when the workspace has none yet). */
  async function createWorkspaceSession(cfg) {
    const path = cfg.workspace || workspaceRoot() || undefined;
    const opts = defaultAgentOptions();
    try {
      const handle = await agents.create({
        sessionId: `feishu-${Date.now().toString(36)}`,
        meta: { ...(path ? { cwd: path } : {}) },
        ...opts ? { agentOptions: opts } : {},
      });
      return handle.agent;
    } catch (err) {
      console.log(`[feishu-gw] create failed: ${err.message}`);
      return undefined;
    }
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
    const base = bot.cfg.workspace || workspaceRoot() || process.cwd();
    let sent = 0;
    for (const raw of paths.slice(0, 3)) {
      const abs = isAbsolute(raw) ? raw : resolve(base, raw);
      try {
        const st = statSync(abs, { throwIfNoEntry: false });
        if (!st || !st.isFile() || st.size === 0 || st.size > 20 * 1024 * 1024) continue;
        const buffer = readFileSync(abs);
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

  const HELP = [
    "**飞书网关**",
    "",
    "直接发消息/图片 = 进入电脑端**当前打开的会话**（手机与桌面同一对话）。",
    "/list — 查看工作区会话（同电脑端侧边栏）",
    "/timer <分钟> <内容> — 定时提醒（如：/timer 10 提醒我喝水）",
    "/cancel — 取消本聊天的定时提醒并中断当前回合",
    "需要授权时点卡片按钮，提问回复编号即可。",
    "/help — 帮助",
  ].join("\n");

  function registerTimer(bot, chatId, minutes, text) {
    const key = `${bot.cfg.name}:${chatId}`;
    const list = timers.get(key) ?? [];
    const id = `t${Date.now().toString(36)}`;
    const handle = setTimeout(() => {
      timers.set(key, (timers.get(key) ?? []).filter((x) => x.id !== id));
      void bot.feishu.sendMarkdown(chatId, chatId, `⏰ **定时提醒**：${text}`).catch(() => {});
    }, Math.max(1, minutes) * 60000);
    list.push({ id, at: Date.now() + minutes * 60000, text, handle });
    timers.set(key, list);
    return id;
  }
  function cancelTimers(bot, chatId) {
    const key = `${bot.cfg.name}:${chatId}`;
    const list = timers.get(key) ?? [];
    for (const t of list) clearTimeout(t.handle);
    timers.delete(key);
    return list.length;
  }

  /** List the workspace's sessions the way the desktop sidebar does. */
  async function listWorkspaceSessions(bot, chatId) {
    const path = bot.cfg.workspace || workspaceRoot() || "";
    const target = norm(path);
    try {
      const { items: wsList } = await dsh.call("workspace.list", {});
      const ws = wsList.find((w) => norm(w.path) === target);
      if (!ws) {
        return bot.feishu.sendMarkdown(chatId, chatId, `未找到工作区：${path || "（未配置）"}`);
      }
      const { items: sessions } = await dsh.call("session.list", {});
      const ids = new Set(ws.sessionIds ?? []);
      const rows = sessions.filter((s) => ids.has(s.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 15);
      const current = await currentSessionId(bot.cfg);
      const lines = [`**工作区「${ws.title}」的会话**（▶️ = 当前，手机消息将进入）：`, ""];
      for (const s of rows) {
        let title = "";
        try {
          const h = await dsh.call("session.history", { sessionId: s.sessionId });
          title = h.projections?.values?.title ?? "";
        } catch {}
        const mark = s.sessionId === current ? "▶️" : "⏸️";
        lines.push(`${mark} ${title || "（无标题）"}（${s.sessionId.slice(-8)}）`);
      }
      lines.push("", "在电脑端打开某个会话，手机发消息就会进入它。");
      return bot.feishu.sendMarkdown(chatId, chatId, lines.join("\n"));
    } catch (err) {
      return bot.feishu.sendMarkdown(chatId, chatId, `❌ 查询失败：${err.message}`);
    }
  }

  async function handleFeishuMessage(bot, { openId, chatId, text, messageId, messageType = "text", contentRaw = "" }) {
    if (!messageId) return;
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
    if (text.startsWith("/")) {
      const cmdLine = text.trim();
      const cmd = cmdLine.toLowerCase().split(/\s+/)[0];
      if (cmd === "/help") return bot.feishu.sendMarkdown(chatId, chatId, HELP);
      if (cmd === "/list") return listWorkspaceSessions(bot, chatId);
      if (cmd === "/timer") {
        const m = cmdLine.match(/^\/timer\s+(\d+(?:\.\d+)?)\s+(.+)$/s);
        if (!m) return bot.feishu.sendMarkdown(chatId, chatId, "用法：/timer <分钟> <内容>，如：/timer 10 提醒我喝水");
        const minutes = Number(m[1]);
        const body = m[2].trim();
        registerTimer(bot, chatId, minutes, body);
        return bot.feishu.sendMarkdown(chatId, chatId, `⏰ 已设定 ${minutes} 分钟后的提醒：「${body}」`);
      }
      if (cmd === "/cancel") {
        const n = cancelTimers(bot, chatId);
        // also interrupt the current agent turn if any
        const sid = await currentSessionId(bot.cfg);
        if (sid) {
          try {
            await dsh.call("session.cancel", { sessionId: sid });
          } catch {}
        }
        return bot.feishu.sendMarkdown(chatId, chatId, n > 0 ? `🛑 已取消 ${n} 个定时提醒，并中断当前回合。` : "🛑 已中断当前回合。");
      }
      return bot.feishu.sendMarkdown(chatId, chatId, "未知命令，发送 /help 查看。");
    }

    // non-text handling: images are downloaded and handed to the agent (看图)
    let contentBlocks = [];
    if (messageType === "image") {
      let imageKey = "";
      try {
        imageKey = JSON.parse(contentRaw || "{}").image_key || "";
      } catch {}
      if (!imageKey) return bot.feishu.sendMarkdown(chatId, chatId, "收到图片但无法解析（image_key 缺失）。");
      try {
        const img = await bot.feishu.downloadImage(messageId, imageKey);
        contentBlocks.push({ type: "image", mediaType: img.mediaType, data: img.data });
      } catch (err) {
        console.log(`[feishu-gw] image download failed: ${err.message}`);
        return bot.feishu.sendMarkdown(chatId, chatId, `❌ 图片下载失败：${err.message}`);
      }
    } else if (messageType !== "text") {
      // audio/file/other: ignore for now
      return;
    }
    if (messageType === "text") {
      contentBlocks.push({ type: "text", text: `[飞书 ${openId}] ${text}` });
    } else if (text) {
      contentBlocks.push({ type: "text", text: `[飞书 ${openId}] ${text}` });
    }

    // bridge to the desktop's CURRENT session in the bot's workspace
    let sessionId = await currentSessionId(bot.cfg);
    let agent = sessionId ? await resolveAgent(sessionId) : undefined;
    if (!agent) {
      agent = await createWorkspaceSession(bot.cfg);
      if (!agent) return bot.feishu.sendMarkdown(chatId, chatId, "无法获取当前会话：请先在电脑端打开一个会话，或检查工作区配置。");
      sessionId = agent.id;
    }
    sessionOwner.set(sessionId, { botName: bot.cfg.name, chatId, openId });

    await bot.feishu.sendMarkdown(chatId, chatId, "🤖 已收到，开始处理…");
    const seqBefore = agent.session.events.length;
    const message = { id: `feishu-${messageId}`, role: "user", content: contentBlocks, source: { kind: "user" } };
    agent.send(message, "next-turn", true);

    // progress: one card, updated in place (no spam)
    const progress = { lastAt: 0, steps: 0, tools: new Set(), cardId: null, sent: false };
    const progressText = () => {
      const parts = [`⏳ 进行中：已执行 ${progress.steps} 步`];
      if (progress.tools.size) parts.push(`正在调用：${[...progress.tools].join("、")}`);
      return parts.join("，");
    };
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
        if (!progress.sent) {
          progress.sent = true;
          void bot.feishu.sendCard(chatId, progressText()).then((r) => {
            progress.cardId = r.messageId;
          }).catch(() => {});
        } else if (progress.cardId) {
          void bot.feishu.updateCard(chatId, progress.cardId, progressText()).catch(() => {});
        }
        progress.tools = new Set();
      }
    }, 3000);

    const hadImage = messageType === "image";
    try {
      await agent.whenIdle();
    } catch (err) {
      console.log(`[feishu-gw] turn wait failed: ${err.message}`);
      if (hadImage) {
        await bot.feishu.sendMarkdown(chatId, chatId, "📷 收到图片，但当前模型不支持看图（或图片处理失败）。");
      } else {
        await bot.feishu.sendMarkdown(chatId, chatId, `❌ 任务执行失败：${err.message}`);
      }
      return;
    } finally {
      poll();
    }

    const events = agent.session.events;
    const rawReply = extractReply(events, seqBefore);
    const reply = rawReply || (hadImage ? "📷 收到图片（当前模型未输出看图结果，可能不支持多模态）。" : "（Agent 未产生文字回复）");
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
    if (images.length) await pushImages(bot, chatId, images, sessionId);
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
        bot = { cfg, feishu: null, status: "", chain: Promise.resolve(), lastChatId: "" };
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
        bot = bots.get(args.appId) || { cfg: list.find((c) => c.appId === args.appId) || {}, feishu: null, lastChatId: "" };
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

  // ---- admin routes (settings-page panel) ----
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

  // ---- scan-to-create onboarding (Feishu official device flow) ----
  const onboardingBase = "https://accounts.feishu.cn/oauth/v1/app/registration";
  const onboardingForm = (params) => {
    const parts = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return { body: parts.join("&"), headers: { "Content-Type": "application/x-www-form-urlencoded" } };
  };
  route("/feishu/admin/onboard", "POST", async (req, res) => {
    try {
      const init = onboardingForm({ action: "init" });
      const initRes = await fetch(onboardingBase, { method: "POST", headers: init.headers, body: init.body });
      const initData = await initRes.json();
      if (!Array.isArray(initData.supported_auth_methods) || !initData.supported_auth_methods.some((m) => String(m).toLowerCase() === "client_secret")) {
        return respondJson(res, 200, { ok: false, message: "当前环境不支持 client_secret 认证方式" });
      }
      const begin = onboardingForm({ action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id" });
      const beginRes = await fetch(onboardingBase, { method: "POST", headers: begin.headers, body: begin.body });
      const beginData = await beginRes.json();
      if (beginData.error) return respondJson(res, 200, { ok: false, message: String(beginData.error) + ": " + String(beginData.error_description || "") });
      if (!beginData.device_code || !beginData.verification_uri_complete) return respondJson(res, 200, { ok: false, message: "onboarding 响应不完整" });
      respondJson(res, 200, {
        ok: true,
        deviceCode: beginData.device_code,
        qrContent: beginData.verification_uri_complete,
        userCode: String(beginData.user_code || ""),
        expiresIn: Number(beginData.expires_in) || 3600,
        interval: Number(beginData.interval) || 5,
      });
    } catch (err) {
      respondJson(res, 500, { ok: false, message: String(err.message) });
    }
  });
  route("/feishu/admin/onboard/poll", "POST", async (req, res) => {
    let body;
    try {
      body = JSON.parse(await readBody(req, 65536)) || {};
    } catch {
      return respondJson(res, 400, { ok: false, message: "invalid json" });
    }
    try {
      const form = onboardingForm({ action: "poll", device_code: body.deviceCode });
      const r = await fetch(onboardingBase, { method: "POST", headers: form.headers, body: form.body });
      const data = await r.json();
      if (data.error && data.error !== "authorization_pending") {
        return respondJson(res, 200, { ok: false, error: String(data.error), message: String(data.error_description || data.error) });
      }
      if (typeof data.client_id === "string" && typeof data.client_secret === "string" && data.client_id && data.client_secret) {
        return respondJson(res, 200, { ok: true, done: true, appId: data.client_id, appSecret: data.client_secret, ownerOpenId: data.user_info?.open_id || "" });
      }
      respondJson(res, 200, { ok: true, done: false, pending: true });
    } catch (err) {
      respondJson(res, 500, { ok: false, message: String(err.message) });
    }
  });

  // ---- self-contained settings panel ----
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/feishu/admin/panel",
      handler: (req, res) => {
        if (req.method !== "GET") return respondJson(res, 405, { ok: false, message: "method not allowed" });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(adminPanelHtml());
      },
    })
  );

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
