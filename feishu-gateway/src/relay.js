// Turn relay: routes Feishu messages into DSH sessions, streams replies back,
// and handles approvals (授权, card or text) and questions (ask_user_question).
import { statSync, readFileSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve, basename } from "node:path";

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n…（已截断，详情请到电脑端查看）";
}

/** Tools that typically produce deliverable files (used for the 产物 note). */
const FILE_PRODUCING_TOOLS = new Set([
  "write",
  "edit",
  "fs-write",
  "str-replace-editor",
  "bash",
  "bash-persistent",
  "pwsh",
  "pwsh-persistent",
]);

function formatQuestions(questions) {
  if (!questions.length) return "❓（空问题）";
  const lines = [];
  questions.forEach((q, qi) => {
    const prefix = questions.length > 1 ? `Q${qi + 1}. ` : "";
    lines.push(`❓ ${prefix}${q.header ? `【${q.header}】` : ""}${q.question}`);
    if (q.detail) lines.push(`   ${q.detail}`);
    if (q.options?.length) {
      q.options.forEach((opt, i) => {
        lines.push(`   ${i + 1}. ${opt.label}${opt.description ? `（${opt.description}）` : ""}`);
      });
      lines.push(q.multiSelect ? "（可多选，回复如 1,3）" : "（回复编号选择，如 1）");
    }
  });
  lines.push("（也可直接输入答案文字）");
  return lines.join("\n");
}

function normalizeApproval(text) {
  const t = text.trim().toLowerCase();
  if (["允许", "同意", "是", "ok", "yes", "allow", "1"].includes(t)) return "allowed-once";
  if (["拒绝", "否", "no", "deny", "reject", "0"].includes(t)) return "rejected";
  return null;
}

export class TurnRelay {
  constructor({ dsh, store, notify, notifyImage, notifyFile, notifyApproval, config }) {
    this.dsh = dsh;
    this.store = store;
    this.notify = notify; // async (openId, chatId, text) => Promise
    this.notifyImage = notifyImage; // optional async (openId, chatId, {data, mediaType}) => Promise
    this.notifyFile = notifyFile; // optional async (openId, chatId, {fileName, buffer}) => Promise
    this.notifyApproval = notifyApproval; // optional async (openId, chatId, {toolName, reason, rpcId, approvalId, sessionId}) => Promise (card)
    this.config = config;
    this.botName = config.botName ?? "default";
    this.activeWorkspaceId = null;
    this.workspaceChecked = false;
    this.workspaces = []; // cache of workspace.list items
    this.archivedSessionIds = []; // cache of workspace.list archivedSessionIds
    this.titleCache = null; // { sessionId, title, at }
    this.turns = new Map(); // sessionId -> ctx
    this.sessionOwners = new Map(); // sessionId -> { openId, chatId } (survives ctx gaps)
    this.pendingQuestion = new Map(); // openId -> { rpcId, sessionId, questions }
    this.pendingApproval = new Map(); // openId -> { rpcId, sessionId, approvalId, toolName, reason }
    dsh.onFrame((frame) => this.onFrame(frame));
  }

  // ---- workspace isolation ----
  /**
   * Resolve (and lazily adopt) the bot's DEFAULT workspace so sessions start
   * out isolated from the GUI's workspace. Returns workspaceId, or null when
   * no workspace is configured. An existing workspace at the same path is
   * reused as-is (never renamed); a newly adopted directory gets a friendly
   * title. `/workspace` can switch the active workspace afterwards.
   */
  async ensureWorkspace() {
    if (this.workspaceChecked) return this.activeWorkspaceId;
    this.workspaceChecked = true;
    const path = this.config.workspace;
    if (!path) return null;
    const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
    try {
      await this.refreshWorkspaces();
      const hit = this.workspaces.find((w) => norm(w.path).toLowerCase() === norm(path).toLowerCase());
      if (hit) {
        this.activeWorkspaceId = hit.workspaceId;
        return this.activeWorkspaceId;
      }
      const created = await this.dsh.call("workspace.create", { path });
      this.activeWorkspaceId = created.workspace.workspaceId;
      try {
        await this.dsh.call("workspace.rename", { workspaceId: this.activeWorkspaceId, title: `飞书-${this.botName}` });
      } catch {}
      await this.refreshWorkspaces();
      console.log(`[relay:${this.botName}] adopted workspace ${path} -> ${this.activeWorkspaceId}`);
      return this.activeWorkspaceId;
    } catch (err) {
      console.error(`[relay:${this.botName}] workspace setup failed:`, err.message);
      return null;
    }
  }

  async refreshWorkspaces() {
    try {
      const result = await this.dsh.call("workspace.list", {});
      this.workspaces = result.items ?? [];
      this.archivedSessionIds = result.archivedSessionIds ?? [];
      return this.workspaces;
    } catch (err) {
      console.error(`[relay:${this.botName}] workspace.list failed:`, err.message);
      return this.workspaces ?? [];
    }
  }

  /**
   * Attach this chat's orphan sessions (created before workspace tracking, or
   * in a now-deleted workspace) to the bot's active workspace, so /list shows
   * every session under a proper workspace.
   */
  async attachOrphans(openId) {
    const pool = this.store.listSessions(this.botName, openId);
    if (!pool.length) return;
    const target = this.activeWorkspaceId ?? (await this.ensureWorkspace());
    if (!target) return;
    const wsIds = new Set((this.workspaces ?? []).flatMap((w) => w.sessionIds ?? []));
    const orphans = pool.filter((id) => !wsIds.has(id));
    if (!orphans.length) return;
    for (const sid of orphans) {
      try {
        await this.dsh.call("workspace.insertSessionBefore", { workspaceId: target, sessionId: sid });
      } catch (err) {
        // Legacy cwd-created sessions are "not accounted" and cannot be moved;
        // that is expected, not an error worth logging at error level.
        if (err.code === "workspace-move-invalid") {
          console.log(`[relay:${this.botName}] orphan session ${sid.slice(0, 8)} stays 未归属 (legacy cwd session)`);
        } else {
          console.error(`[relay:${this.botName}] attach orphan session ${sid} failed:`, err.message);
        }
      }
    }
    await this.refreshWorkspaces();
    console.log(`[relay:${this.botName}] attached ${orphans.length} orphan session(s) to workspace`);
  }

  /** Read one session's title from its history projections (cached). */
  async sessionTitle(sessionId) {
    if (this.titleCache && this.titleCache.sessionId === sessionId && Date.now() - this.titleCache.at < 30000) {
      return this.titleCache.title;
    }
    try {
      const h = await this.dsh.call("session.history", { sessionId });
      const title = h.projections?.values?.title ?? null;
      this.titleCache = { sessionId, title, at: Date.now() };
      return title;
    } catch {
      return null;
    }
  }

  /**
   * Flat, numbered enumeration of every session across all workspaces
   * (orphan pool sessions appended last). /list and /switch share this order.
   */
  async enumerateSessions(openId, { fetchTitles = true } = {}) {
    await this.refreshWorkspaces();
    await this.attachOrphans(openId);
    const archived = new Set(this.archivedSessionIds ?? []);
    const entries = [];
    for (const w of this.workspaces ?? []) {
      for (const sid of w.sessionIds ?? []) {
        if (!archived.has(sid)) entries.push({ sessionId: sid, workspaceTitle: w.title });
      }
    }
    const pool = this.store.listSessions(this.botName, openId);
    const wsIds = new Set(entries.map((e) => e.sessionId));
    for (const sid of pool) {
      if (!wsIds.has(sid) && !archived.has(sid)) entries.push({ sessionId: sid, workspaceTitle: "未归属" });
    }
    if (fetchTitles) {
      for (let i = 0; i < entries.length && i < 20; i++) {
        const title = await this.sessionTitle(entries[i].sessionId);
        entries[i].title = title ?? "（无标题）";
      }
    }
    return entries;
  }

  async createSession() {
    if (!this.activeWorkspaceId) await this.ensureWorkspace();
    if (this.activeWorkspaceId) return this.dsh.call("session.create", { workspaceId: this.activeWorkspaceId });
    if (this.config.sessionCwd) return this.dsh.call("session.create", { cwd: this.config.sessionCwd });
    return this.dsh.call("session.create", {});
  }

  // ---- entry ----
  async handleText(openId, chatId, text) {
    const allowed = this.config.allowedOpenIds;
    if (allowed.length && !allowed.includes(openId)) {
      await this.notify(openId, chatId, "⚠️ 未授权的用户，无法使用该机器人。");
      return;
    }
    const t = text.trim();
    if (t.startsWith("/")) {
      await this.handleCommand(openId, chatId, t);
      return;
    }
    const approval = this.pendingApproval.get(openId);
    if (approval) {
      await this.handleApprovalReply(openId, chatId, approval, t);
      return;
    }
    const question = this.pendingQuestion.get(openId);
    if (question) {
      await this.handleQuestionReply(openId, chatId, question, t);
      return;
    }
    await this.relayPrompt(openId, chatId, t);
  }

  // ---- commands ----
  async handleCommand(openId, chatId, text) {
    const [cmd, ...rest] = text.split(/\s+/);
    switch (cmd) {
      case "/help":
        await this.notify(
          openId,
          chatId,
          [
            "🤖 DeepSeek Harness 飞书网关",
            "",
            "直接发消息 = 交给电脑上的 DSH 执行",
            "🔐 需要授权时会有审批卡片/消息，回复 允许 / 拒绝",
            "",
            "命令：",
            "/new   开启新会话",
            "/switch <序号>  切换会话（/list 查看序号）",
            "/workspace [序号|名称|路径]  查看/切换工作区",
            "/list  查看本聊天的所有会话（含工作区）",
            "/stop  停止当前任务",
            "/help  显示本帮助",
          ].join("\n")
        );
        return;
      case "/new": {
        try {
          const created = await this.createSession();
          const idx = this.store.addSession(this.botName, openId, created.sessionId);
          this.pendingQuestion.delete(openId);
          this.pendingApproval.delete(openId);
          await this.notify(openId, chatId, `🆕 已开启新会话 #${idx + 1} ${created.sessionId.slice(-8)}`);
        } catch (err) {
          await this.notify(openId, chatId, `❌ 创建会话失败：${err.message}`);
        }
        return;
      }
      case "/switch": {
        const n = Number(rest[0]);
        if (!Number.isInteger(n) || n < 1) {
          await this.notify(openId, chatId, "用法：/switch <序号>（用 /list 查看序号）");
          return;
        }
        try {
          const entries = await this.enumerateSessions(openId, { fetchTitles: false });
          if (n > entries.length) {
            await this.notify(openId, chatId, `没有第 ${n} 个会话（/list 查看，共 ${entries.length} 个）。`);
            return;
          }
          const target = entries[n - 1];
          this.store.setCurrent(this.botName, openId, target.sessionId);
          const title = await this.sessionTitle(target.sessionId);
          await this.notify(openId, chatId, `🔀 已切换到会话 #${n} [${target.workspaceTitle}] ${title ?? target.sessionId.slice(-8)}`);
        } catch (err) {
          await this.notify(openId, chatId, `❌ 切换失败：${err.message}`);
        }
        return;
      }
      case "/workspace":
      case "/ws": {
        const items = await this.refreshWorkspaces();
        const arg = rest.join(" ").trim();
        if (!arg) {
          const lines = ["📁 工作区（▶️ 为当前，新会话将建在其中）："];
          items.forEach((w, i) => {
            const isCur = w.workspaceId === this.activeWorkspaceId;
            lines.push(`${isCur ? "▶️" : "⏸️"} #${i + 1} ${w.title}（${w.path}）${isCur ? " ← 当前" : ""}`);
          });
          if (!items.length) lines.push("（没有工作区）");
          lines.push("", "用法：/workspace <序号|名称> 切换；/workspace <目录路径> 收养新工作区");
          await this.notify(openId, chatId, lines.join("\n"));
          return;
        }
        // by index
        const idx = Number(arg);
        if (Number.isInteger(idx) && idx >= 1 && idx <= items.length) {
          this.activeWorkspaceId = items[idx - 1].workspaceId;
          await this.notify(openId, chatId, `🔀 已切换工作区：${items[idx - 1].title}（新会话将建在其中）`);
          return;
        }
        // by title
        const hit = items.find((w) => w.title === arg) ?? items.find((w) => w.title.includes(arg));
        if (hit) {
          this.activeWorkspaceId = hit.workspaceId;
          await this.notify(openId, chatId, `🔀 已切换工作区：${hit.title}（新会话将建在其中）`);
          return;
        }
        // by path: adopt a new workspace directory
        if (/^[A-Za-z]:[\\/]|^[\\/]/.test(arg)) {
          try {
            mkdirSync(arg, { recursive: true });
            const created = await this.dsh.call("workspace.create", { path: arg });
            this.activeWorkspaceId = created.workspace.workspaceId;
            try {
              await this.dsh.call("workspace.rename", { workspaceId: this.activeWorkspaceId, title: `飞书-${basename(arg)}` });
            } catch {}
            await this.refreshWorkspaces();
            await this.notify(openId, chatId, `🆕 已创建并切换工作区：${created.workspace.title}`);
          } catch (err) {
            await this.notify(openId, chatId, `❌ 创建工作区失败：${err.message}`);
          }
          return;
        }
        await this.notify(openId, chatId, `未找到工作区「${arg}」（/workspace 查看列表）。`);
        return;
      }
      case "/list": {
        try {
          // Numbered view of non-archived sessions (archived ones are hidden
          // in the GUI sidebar too); every entry is switchable.
          const entries = await this.enumerateSessions(openId, { fetchTitles: true });
          const current = this.store.currentSessionId(this.botName, openId);
          const lines = ["📋 会话（仅未归档，▶️ = 当前，回复 /switch <序号> 切换）："];
          if (entries.length === 0) lines.push("（没有会话，直接发消息即可创建）");
          entries.forEach((e, i) => {
            const mark = e.sessionId === current ? "▶️" : "⏸️";
            const title = e.title ?? "（无标题）";
            lines.push(`${mark} ${i + 1}. [${e.workspaceTitle}] ${title}（${e.sessionId.slice(-8)}）`);
          });
          lines.push("", "/new 开新会话（当前工作区）；/workspace 切换工作区；/switch <序号> 切换会话。");
          await this.notify(openId, chatId, lines.join("\n"));
        } catch (err) {
          await this.notify(openId, chatId, `❌ 查询失败：${err.message}`);
        }
        return;
      }
      case "/stop": {
        const sessionId = this.store.currentSessionId(this.botName, openId);
        this.pendingQuestion.delete(openId);
        this.pendingApproval.delete(openId);
        if (sessionId) {
          const ctx = this.turns.get(sessionId);
          if (ctx) {
            clearTimeout(ctx.timer);
            this.turns.delete(sessionId);
            if (!ctx.finalSent) await this.notify(openId, chatId, "🛑 已请求停止当前任务…");
          }
          try {
            await this.dsh.call("session.cancel", { sessionId });
          } catch (err) {
            await this.notify(openId, chatId, `❌ 停止失败：${err.message}`);
            return;
          }
          await this.notify(openId, chatId, "🛑 已停止。");
        } else {
          await this.notify(openId, chatId, "没有正在运行的会话。");
        }
        return;
      }
      default:
        await this.notify(openId, chatId, `未知命令 ${cmd}，回复 /help 查看帮助。`);
    }
  }

  // ---- prompt ----
  async relayPrompt(openId, chatId, text) {
    let sessionId = this.store.currentSessionId(this.botName, openId);
    if (!sessionId) {
      try {
        const created = await this.createSession();
        sessionId = created.sessionId;
        this.store.addSession(this.botName, openId, sessionId);
      } catch (err) {
        await this.notify(openId, chatId, `❌ 无法创建会话：${err.message}`);
        return;
      }
    }
    const existing = this.turns.get(sessionId);
    if (existing && !existing.finalSent) {
      // Session busy: the message will be queued by the harness automatically.
      try {
        await this.dsh.call("session.prompt", {
          sessionId,
          mode: "queue",
          content: [{ type: "text", text }],
        });
      } catch (err) {
        await this.notify(openId, chatId, `❌ 发送失败：${err.message}`);
        return;
      }
      await this.notify(openId, chatId, "⏳ 上一个任务还在进行，你的消息已排队。回复 /stop 可停止。");
      return;
    }
    try {
      await this.dsh.call("session.prompt", {
        sessionId,
        mode: "queue",
        content: [{ type: "text", text }],
      });
    } catch (err) {
      await this.notify(openId, chatId, `❌ 发送失败：${err.message}`);
      return;
    }
    const ctx = {
      openId,
      chatId,
      sessionId,
      textParts: [],
      toolNames: new Set(),
      steps: 0,
      queuedItems: 0,
      startedAt: Date.now(),
      finalSent: false,
      timer: null,
      progress: { lastAt: 0, tools: [], pendingSteps: 0 },
      pushedImages: new Set(),
      files: [],
      pushedFiles: new Set(),
    };
    this.turns.set(sessionId, ctx);
    this.sessionOwners.set(sessionId, { openId, chatId });
    this.armTimeout(ctx);
    await this.notify(openId, chatId, "🤖 已收到，开始处理…");
  }

  /** Throttled mid-turn progress ping (查看进度). */
  maybeNotifyProgress(ctx) {
    const now = Date.now();
    const throttle = this.config.progressThrottleMs ?? 10000;
    const hasNews = ctx.progress.tools.length > 0 || ctx.progress.pendingSteps > 0;
    if (!hasNews || now - ctx.progress.lastAt < throttle) return;
    const parts = [`⏳ 进行中：已执行 ${ctx.steps} 步`];
    if (ctx.progress.tools.length) parts.push(`正在调用：${ctx.progress.tools.join("、")}`);
    ctx.progress.lastAt = now;
    ctx.progress.tools = [];
    ctx.progress.pendingSteps = 0;
    this.notify(ctx.openId, ctx.chatId, parts.join("，")).catch(() => {});
  }

  /** Collect image blocks (recursively) and push each to the user once. */
  pushImagesFromBlocks(ctx, blocks) {
    if (!this.notifyImage) return;
    const walk = (list) => {
      for (const block of list ?? []) {
        if (block?.type === "image" && block.attachment?.attachmentId) this.pushImage(ctx, block.attachment);
        if (Array.isArray(block?.content)) walk(block.content);
      }
    };
    walk(blocks);
  }

  async pushImage(ctx, ref) {
    if (ctx.pushedImages.has(ref.attachmentId)) return;
    ctx.pushedImages.add(ref.attachmentId);
    try {
      const { attachment, data } = await this.dsh.call("session.attachment", {
        sessionId: ctx.sessionId,
        attachmentId: ref.attachmentId,
      });
      await this.notifyImage(ctx.openId, ctx.chatId, {
        data,
        mediaType: attachment?.mediaType ?? ref.mediaType,
      });
    } catch (err) {
      console.error(`[relay] image push failed for ${ref.attachmentId}:`, err.message);
    }
  }

  armTimeout(ctx) {
    ctx.timer = setTimeout(() => {
      if (ctx.finalSent) return;
      const partial = (ctx.textParts.join("\n\n") || "（尚无文本输出）").trim();
      this.notify(
        ctx.openId,
        ctx.chatId,
        `⏰ 任务运行较久，当前进度：\n\n${truncate(partial, 1500)}\n\n任务仍在继续，完成时会再通知。回复 /stop 可停止。`
      ).catch(() => {});
    }, this.config.turnTimeoutMs);
  }

  // ---- mux frames ----
  onFrame(frame) {
    const method = frame.method;
    const p = frame.payload ?? {};

    if (method === "session/event" && p.sessionId) {
      const ctx = this.turns.get(p.sessionId);
      if (!ctx) return;
      const ev = p.event ?? {};
      switch (ev.type) {
        case "assistant/chunk": {
          const chunk = ev.data?.chunk ?? {};
          if (chunk.type === "block-end" && chunk.block?.type === "text" && chunk.block.text) {
            ctx.textParts.push(chunk.block.text);
          }
          break;
        }
        case "tool/call": {
          const name = ev.data?.name ?? ev.data?.toolName ?? ev.data?.call?.name ?? "?";
          if (name !== "?") {
            ctx.toolNames.add(name);
            ctx.progress.tools.push(name);
            this.maybeNotifyProgress(ctx);
          }
          break;
        }
        case "step/start":
          ctx.steps++;
          ctx.progress.pendingSteps++;
          this.maybeNotifyProgress(ctx);
          break;
        case "assistant/message":
        case "tool/result": {
          // Push any image blocks (查看产物图片) via session.attachment.
          const blocks = ev.data?.message?.content ?? ev.data?.content ?? [];
          this.pushImagesFromBlocks(ctx, blocks);
          // Collect written/edited file paths from structured tool-result meta.
          const meta = ev.data?.meta;
          if (meta?.diffs && Array.isArray(meta.diffs)) {
            for (const diff of meta.diffs) {
              if (typeof diff?.path === "string" && diff.path) ctx.files.push(diff.path);
            }
          }
          break;
        }
        case "turn/end":
          // Real turn completion (finish chunks with reason "tool-calls" only
          // mean the model is waiting on tool results; questions/approvals and
          // further assistant chunks still follow within the same turn).
          this.onTurnFinished(ctx);
          break;
        default:
          break;
      }
      return;
    }

    if (method === "session/queue" && p.sessionId) {
      const ctx = this.turns.get(p.sessionId);
      if (!ctx) return;
      ctx.queuedItems = (p.items ?? []).filter((i) => i.placement === "queued").length;
      return;
    }

    if (method === "question/requested" && p.sessionId) {
      const ctx = this.turns.get(p.sessionId);
      const owner = ctx ?? this.sessionOwners.get(p.sessionId);
      if (!owner) return;
      this.pendingQuestion.set(owner.openId, { rpcId: frame.rpcId, sessionId: p.sessionId, questions: p.questions ?? [] });
      this.notify(owner.openId, owner.chatId, formatQuestions(p.questions ?? [])).catch(() => {});
      return;
    }

    if (method === "approval/requested" && p.sessionId) {
      const ctx = this.turns.get(p.sessionId);
      const owner = ctx ?? this.sessionOwners.get(p.sessionId);
      if (!owner) return;
      const info = {
        rpcId: frame.rpcId,
        sessionId: p.sessionId,
        approvalId: p.approvalId,
        toolName: p.toolName,
        reason: p.reason,
      };
      this.pendingApproval.set(owner.openId, info);
      if (this.notifyApproval) {
        // Interactive card with 允许/拒绝 buttons; text reply remains as fallback.
        this.notifyApproval(owner.openId, owner.chatId, info).catch(() => {
          this.notify(owner.openId, owner.chatId, `🔐 需要授权：调用工具 \`${p.toolName}\`${p.reason ? `\n原因：${p.reason}` : ""}\n\n请回复：允许 / 拒绝`).catch(() => {});
        });
      } else {
        this.notify(
          owner.openId,
          owner.chatId,
          `🔐 需要授权：调用工具 \`${p.toolName}\`${p.reason ? `\n原因：${p.reason}` : ""}\n\n请回复：允许 / 拒绝`
        ).catch(() => {});
      }
    }
  }

  onTurnFinished(ctx) {
    if (ctx.finalSent) return;
    // If more user messages are queued, report progress and keep the ctx alive.
    if (ctx.queuedItems > 0) {
      ctx.queuedItems = 0;
      ctx.textParts = [];
      ctx.toolNames = new Set();
      ctx.steps = 0;
      ctx.progress = { lastAt: 0, tools: [], pendingSteps: 0 };
      ctx.pushedImages = new Set();
      ctx.files = [];
      ctx.pushedFiles = new Set();
      this.notify(ctx.openId, ctx.chatId, "✅ 上一步完成，继续处理下一条消息…").catch(() => {});
      return;
    }
    ctx.finalSent = true;
    clearTimeout(ctx.timer);
    this.turns.delete(ctx.sessionId);
    this.sessionOwners.delete(ctx.sessionId);
    this.pendingQuestion.delete(ctx.openId);
    this.pendingApproval.delete(ctx.openId);
    const text = ctx.textParts.join("\n\n").trim();
    const parts = [];
    if (text) parts.push(text);
    else parts.push("（完成，但没有文本输出）");
    if (ctx.toolNames.size) parts.push(`🔧 使用工具：${[...ctx.toolNames].join("、")}`);
    const madeFiles = [...ctx.toolNames].some((name) => FILE_PRODUCING_TOOLS.has(name));
    if (madeFiles) parts.push("📁 若任务创建了文件/产物，已保存在电脑工作区（可在电脑端 DSH 查看）。");
    this.notify(ctx.openId, ctx.chatId, truncate(parts.join("\n\n"), this.config.maxReplyChars))
      .catch(() => {})
      .finally(() => this.pushTurnFiles(ctx));
  }

  /** Push written/edited files (from tool-result meta.diffs) as Feishu file messages. */
  async pushTurnFiles(ctx) {
    if (!this.notifyFile) return;
    const max = this.config.maxFilePush ?? 3;
    const maxBytes = this.config.maxFileBytes ?? 20 * 1024 * 1024;
    const wsPath = this.workspaces?.find((w) => w.workspaceId === this.activeWorkspaceId)?.path;
    const base = this.config.sessionCwd || wsPath || process.cwd();
    let sent = 0;
    for (const raw of ctx.files) {
      if (sent >= max) break;
      const abs = isAbsolute(raw) ? raw : resolve(base, raw);
      if (ctx.pushedFiles.has(abs)) continue;
      ctx.pushedFiles.add(abs);
      try {
        const st = statSync(abs, { throwIfNoEntry: false });
        if (!st || !st.isFile()) continue;
        if (st.size > maxBytes || st.size === 0) continue;
        const buffer = readFileSync(abs);
        const fileName = abs.split(/[\\/]/).pop() || "file";
        await this.notifyFile(ctx.openId, ctx.chatId, { fileName, buffer });
        sent++;
      } catch (err) {
        console.error(`[relay] file push failed ${abs}:`, err.message);
      }
    }
  }

  // ---- approvals ----
  /** Handle a card button press (value from card.action.trigger). */
  async handleApprovalCard(openId, chatId, value) {
    if (value?.kind !== "approval") return;
    const { rpcId, approvalId, sessionId, outcome } = value;
    if (!rpcId || !approvalId || !sessionId || !["allowed-once", "rejected"].includes(outcome)) {
      await this.notify(openId, chatId, "⚠️ 无效的审批请求。");
      return;
    }
    try {
      const res = await this.dsh.respond(rpcId, { sessionId, approvalId, outcome });
      this.pendingApproval.delete(openId);
      if (res.accepted) {
        await this.notify(openId, chatId, outcome === "allowed-once" ? "✅ 已允许，任务继续。" : "🚫 已拒绝。");
      } else {
        await this.notify(openId, chatId, `⚠️ 审批未生效（${res.reason ?? "unknown"}），可能已超时或已处理。`);
      }
    } catch (err) {
      await this.notify(openId, chatId, `❌ 审批失败：${err.message}`);
    }
  }

  async handleApprovalReply(openId, chatId, pending, text) {
    const outcome = normalizeApproval(text);
    if (!outcome) {
      await this.notify(openId, chatId, "请回复：允许 或 拒绝");
      return;
    }
    try {
      const res = await this.dsh.respond(pending.rpcId, {
        sessionId: pending.sessionId,
        approvalId: pending.approvalId,
        outcome,
      });
      if (res.accepted) {
        this.pendingApproval.delete(openId);
        await this.notify(openId, chatId, outcome === "allowed-once" ? "✅ 已允许，任务继续。" : "🚫 已拒绝。");
      } else {
        await this.notify(openId, chatId, `⚠️ 回复未生效（${res.reason ?? "unknown"}），可能已超时或已处理。`);
      }
    } catch (err) {
      await this.notify(openId, chatId, `❌ 回复失败：${err.message}`);
    }
  }

  // ---- questions ----
  async handleQuestionReply(openId, chatId, pending, text) {
    const questions = pending.questions;
    const first = questions[0];
    if (!first) {
      this.pendingQuestion.delete(openId);
      return;
    }
    const selected = this.resolveSelection(first, text);
    const answers = [{ id: first.id, selected }];
    try {
      const res = await this.dsh.respond(pending.rpcId, {
        sessionId: pending.sessionId,
        answer: { answers },
      });
      if (res.accepted) {
        this.pendingQuestion.delete(openId);
        await this.notify(openId, chatId, `✅ 已回复：${selected.join("、") || text}`);
        if (questions.length > 1) {
          const rest = questions.slice(1);
          this.pendingQuestion.set(openId, { ...pending, questions: rest });
          await this.notify(openId, chatId, formatQuestions(rest));
        }
      } else {
        await this.notify(openId, chatId, `⚠️ 回复未生效（${res.reason ?? "unknown"}），可能已超时。`);
        this.pendingQuestion.delete(openId);
      }
    } catch (err) {
      await this.notify(openId, chatId, `❌ 回复失败：${err.message}`);
    }
  }

  resolveSelection(question, raw) {
    const options = question.options ?? [];
    if (!options.length) return [raw];
    const t = raw.trim();
    // "1" or "1,3"
    if (/^[\d,\s]+$/.test(t)) {
      const idxs = t.split(/[,，\s]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length);
      if (idxs.length) return idxs.map((i) => options[i - 1].label);
    }
    // exact label match
    const hit = options.find((o) => o.label === t);
    if (hit) return [hit.label];
    // plain text: pass through as selected (model interprets) and custom
    return [t];
  }
}
