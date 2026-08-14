# Phase 2 深度集成插件设计（dsh-feishu-gateway-plugin）

> 目标：把 feishu-gateway 从独立进程转换为 DSH 深度集成插件（ctx.agents 会话隔离 + 原生 feishu_send + 管理路由 + client 设置页 UI），保留全部现有能力（审批卡片/提问/进度/图片/文件/Markdown 卡片/多机器人/白名单）。
>
> **进度（round 1）**：✅ 插件 v1 已实现（专用会话池/工作区绑定/模型注入、agent.send+whenIdle 驱动、进度轮询、mux 提问/审批、feishu_send 原生、管理路由、自托管设置面板 UI + 扫码建机器人设备流），13/13 单测通过，已推送 GitHub。⏳ 待安装到 web profile 并端到端实测（需 pnpm + 重启 dsh web）。

## 1. 关键研究结论（源码实证）

### 1.1 可用内部服务（参考 dsh-feishu-connect@1.2.4 源码 + dsh 包源码）
| 服务 | 用途 | 关键 API |
|---|---|---|
| `agents` | 建/恢复专用会话 | `agents.create({sessionId, meta:{cwd, agentPreset}, agentOptions:{provider,model}, setup})` → `{agent}`；`agents.resume({resumeSessionId, agentOptions, setup})`；`agents.roots()/list()` |
| `agentDefaultModel` | 注入默认模型 | `{currentSelection: () => ({provider, model})}` |
| `agentPresets`（agentCtx 内） | 预设组合 | `presets.composeFrom(agentCtx, mainAgent.ctx)` / `presets.mount(agentCtx)` |
| `sandboxPolicy` | 沙箱工作区根 | `{workspaceRoot}` |
| `shell`/`timer` | 子进程/定时器 | `ctx.shell.resolve/start`、`ctx.interval` |
| `webServer` | 管理路由 | `ctx.webServer.register({kind:'exact', path, handler})` |
| `tools` | 注册 feishu_send | `ctx.tools.register(defineTool(...))` |
| `userQuestions` | 提问 provider | **api-proxy 已注册**（见下） |

### 1.2 提问/审批如何到达手机（无需抢 provider）
- `dsh-host-apiproxy` 已在宿主侧注册 userQuestions provider：任何 agent 的 `ask_user_question` → 生成 rpcId + `question/requested` 帧 → **推入 mux 流**；`POST /api/respond` 应答（pending 表 + matchesQuestions 校验）。
- `ctx.approval`：api-proxy 监听每个 agent 的 `approval/request` → `approval/requested` 帧入 mux；`POST /api/respond` 应答。
- **结论**：专用会话（ctx.agents 建）的提问/审批仍走 mux + /api/respond——**我们现有的中继逻辑（审批卡片/提问编号）可直接复用**，只需保留一个轻量 mux 监听 + DshClient.respond。

### 1.3 会话与事件
- 专用会话：`agents.create/resume`，`meta.cwd = bot.workspace`，每飞书聊天一个会话池（`feishu-<chat>-<n>-<ts>` 命名），与 GUI 会话隔离。
- 回合驱动：`agent.send(message, 'next-turn', true)` → `await agent.whenIdle()` → 读 `agent.session.events`（assistant/message 取回复；tool/call 做进度；tool/result 的 meta.diffs 取产物文件；assistant/message 的 image 块取图片）。
- 进度：whenIdle 期间用 `ctx.interval` 轮询 events（节流推送 ⏳）。
- 图片/文件：与独立版相同（/api session.attachment 取图；meta.diffs 路径 stat+readFile 推送）。

## 2. 插件架构

```
DSH web profile（宿主进程）
└── dsh-feishu-gateway-plugin（host 插件）
    ├── FeishuBot（进程内 lark WSClient，每 bot 一个，复用 feishu.js）
    ├── Bridge（消息→专用 agent 会话：per-chat 会话池 /new /switch /list）
    ├── Reply 提取（agent.session.events → Markdown 卡片回复）
    ├── 提问/审批：DshClient mux 监听 + /api/respond（复用 relay 的 pending 逻辑）
    ├── feishu_send 工具（ctx.tools 原生注册）
    ├── 管理路由 /feishu/admin/*（状态/配置/测试发送/扫码建机器人）
    └── client 插件（设置页 UI：机器人列表/扫码/测试发送）
配置：~/.dsh-feishu/config.json（bots 数组，热读 10s）
状态：~/.dsh-feishu/state-<appId>.json（每聊天会话池）
```

## 3. 流程

### 3.1 手机消息 → 任务 → 回复
1. WS 收到 `im.message.receive_v1` → 去重 → 记录 lastChatId
2. `/` 命令 → 插件内处理（/new /switch /list /help /workspace）
3. 普通消息 → `ensureChat`（会话池持久化）→ 取当前会话 → 无则 `agents.create`（专用）→ 有则 `agents.resume`
4. `agent.send({id, role:'user', content:[{type:'text',text}], source:{kind:'user'}}, 'next-turn', true)`
5. 期间轮询 events 发进度；`await agent.whenIdle()` 后提取回复 → 飞书 Markdown 卡片
6. 提取图片/文件 → 推送；审批/提问经 mux → 卡片/编号交互 → /api/respond

### 3.2 feishu_send（原生）
工具 execute → 从当前插件 bots 选 bot → `sendFeishuText`（chatId 缺省=最近会话，或 ownerOpenId）。

### 3.3 设置页（client 插件 + 管理路由）
- `/feishu/admin/status`（GET）、`/config`（GET/POST）、`/delete-bot`、`/send-test`、`/onboard`、`/onboard/poll`
- client.js 注册设置槽位，UI 增删 bot/扫码创建/测试发送

## 4. 复用与新增
| 模块 | 处理 |
|---|---|
| feishu.js（sendMarkdown/Image/File/ApprovalCard、WSClient） | **复制进插件**（进程内运行） |
| relay 的提问/审批 pending 逻辑 + /api/respond | **改写为 mux 监听 + 卡片/编号交互** |
| 进度/文件/图片提取 | 改为轮询 agent.session.events + meta.diffs |
| dsh.js（respond + mux） | 复制（仅用于提问/审批） |
| 独立进程的 index.js / send-server / CLI / bat | 不再需要（随 dsh web 启动） |

## 5. 安装
```bash
# 手动（免 pnpm）：复制到 ~/.dsh/profiles/node_modules/dsh-feishu-gateway-plugin/
# cordis.patch.yml 加：
#   - insert:
#       - id: feishu-gateway-plugin
#         name: dsh-feishu-gateway-plugin
# 重启 dsh web
```

## 6. 测试计划
1. 单测：会话池/命令/回复提取/进度/文件提取（mock agents）
2. 真实安装后：手机发消息→专用会话→回复；/new /switch /list；提问/审批卡片；feishu_send；设置页
3. 验收：对照 docs/mobile-acceptance-checklist.md

## 7. 限制与取舍
- 提问/审批依赖 api-proxy 的 provider（web profile 必有）；若在无 api-proxy 的自定义 profile 运行则失效（可接受）。
- 专用会话在 GUI 侧边栏可见（工作区视图内），但绝不进入 GUI 的当前会话流。
- 插件在 DSH 进程内运行：异常需 try/catch 兜底（沿用 dsh-feishu-connect 的 ctx.effect 清理模式）。
