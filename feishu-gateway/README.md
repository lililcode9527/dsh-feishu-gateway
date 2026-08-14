# DSH 飞书网关（手机直连 DeepSeek Harness）

手机在**飞书**里直接和电脑上的 DeepSeek Harness 对话、下达任务、处理授权审批，与电脑端共用同一套会话与能力。

```
手机飞书 App ──发消息──▶ 飞书服务器 ──长连接(WS)──▶ 本机网关 ──HTTP/WS──▶ DSH (127.0.0.1:3080)
                              ▲                          │
                              └──────────回复/审批────────┘
```

- 网关跑在电脑上，**主动出站连接**飞书服务器（长连接 WebSocket），**不需要开放任何端口**，手机与电脑不在同一网络也能用。
- 会话持久化在 `~/.dsh/sessions`，重启 DSH 或网关都不丢历史。
- 独立进程：只调用 DSH 公开本地 API，**零侵入**，DSH 出问题不影响网关，网关出问题也不影响 DSH。

## 安装（npm 全局，推荐）

```bash
npm install -g dsh-feishu-gateway     # 发布后可用
dsh-feishu-gateway setup              # 一次性：打印飞书后台清单并打开 open.feishu.cn
# 在工作目录放一个 .env（参照包内 .env.example），填入 FEISHU_APP_ID / FEISHU_APP_SECRET
dsh-feishu-gateway check              # 快速自检
dsh-feishu-gateway verify             # 真正建立飞书长连接
dsh-feishu-gateway start              # 启动网关（Ctrl+C 停止）
```

> 配置目录：默认读**当前目录**的 `.env`；也可用环境变量 `DSH_FEISHU_CONFIG_DIR` 指定配置目录。会话状态写在配置目录 `data/sessions.json`。

### 多机器人 / 多工作区（可选）

单机器人用 `.env` 即可。要跑多个机器人（每个绑定自己的工作区、各自独立长连接与会话池），在配置目录放一个 `bots.json`（参照 `bots.example.json`）：

```json
[
  {
    "name": "home-bot",
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "workspace": "C:\\Users\\you\\Desktop\\harness",
    "allowedOpenIds": []
  },
  {
    "name": "work-bot",
    "appId": "cli_yyy",
    "appSecret": "yyy",
    "workspace": "C:\\Users\\you\\Desktop\\work",
    "allowedOpenIds": ["ou_xxx"]
  }
]
```

存在 `bots.json` 时忽略 `.env` 的 `FEISHU_APP_ID / FEISHU_APP_SECRET`。每个机器人的会话进入其 `workspace` 对应的 **DSH 工作区**（独立标签页，与 GUI 默认工作区的会话隔离）；每个飞书聊天拥有自己的**会话池**（`/new` 建新、`/switch` 切换）。

## 源码方式运行（本仓库）

```bash
cd feishu-gateway
npm install                # 国内网络慢可先: npm config set registry https://registry.npmmirror.com
npm run setup              # 配置向导
cp .env.example .env       # 编辑 .env，填入 FEISHU_APP_ID / FEISHU_APP_SECRET
npm run check              # 配置预检
npm run verify             # 上线验收：真正建立飞书长连接
npm start                  # 或双击 start-gateway.bat（自动先自检再启动）
```

## 飞书后台一次性配置（需你的飞书账号）

1. 打开 [飞书开放平台](https://open.feishu.cn) → 开发者后台 → **创建企业自建应用**（个人可免费创建企业）。
2. 进入应用 → **添加应用能力 → 机器人**。
3. **权限管理**中开通权限（点击"开通"，需发布版本后生效）：
   - `im:message`（获取与发送单聊、群组消息）
   - `im:message:send_as_bot`（以应用身份发消息）
4. **事件与回调 → 订阅方式**：选 **「使用长连接接收事件」**；
   **事件**中订阅：`im.message.receive_v1`（接收消息）。
5. **版本管理与发布**：创建版本并发布（自建应用发布后即时生效；如需审核可自行通过）。
6. **凭证与基础信息**：复制 **App ID** 和 **App Secret**。
7. 在企业管理后台（或飞书 App 里）把该应用设为可用；在飞书里搜索机器人名字，进入会话即可测试。

> 拿到的 App ID / App Secret 填到下面的 `.env`。**请勿泄露 App Secret**——拥有它就能完全控制你电脑上的 DSH。

## 运行与运维

前置：电脑已运行 DSH Web（`http://127.0.0.1:3080`）、已安装 Node.js ≥ 20。看到 `[feishu] long-connection started (WS)` 即成功；没填凭据时进入 **dry-run 模式**（回复打印到控制台，方便本地验证）。

> ⚠️ **不要在 feishu-gateway 目录里运行 dsh 命令**：该目录的 `.env` 含 `DSH_BASE_URL`，会被 dsh 当作保留变量拒绝启动。请从其他目录（如你的主目录）运行 `dsh` 相关命令（`npx @deepseek-ai/dsh ...`）。

### 开机自启（已启用）
网关需要在电脑开机后运行，手机才能随时连上。启动器已安装到**启动文件夹**（无需管理员）：
```powershell
# 注册（登录时自动启动 + 崩溃自动重启 + 日志 data\gateway.log）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
# 卸载
powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
```
手动启动也可双击 `start-gateway.bat`（前台窗口，可看日志）。注意：自启任务和手动启动**二选一**，避免两个实例同时连飞书。

### feishu_send（Agent 主动推送，可选）
让 DSH 里的 Agent 能**主动**给手机发消息（不必等用户发话）。两步：
1. 网关已内置收件口（启动日志显示 `feishu_send receiver on http://127.0.0.1:3180`，无需额外配置；令牌见 `data/gateway-send.json`）；
2. 安装伴生插件到 DSH web profile（需重启 `dsh web` 生效）：
```bash
cd feishu-gateway
dsh plugin --profile web add "file:./dsh-feishu-send"
# 重启 dsh web 后生效
```
插件自动从 `~/.dsh-feishu-gateway.json`（网关启动时写入）或环境变量 `DSH_FEISHU_SEND_URL` / `DSH_FEISHU_SEND_TOKEN` 读取收件口信息。装好后，Agent 会话可直接调用工具 `feishu_send`（参数 `text`，可选 `appName` / `openId`），消息以 Markdown 卡片推送到你最近聊天的手机会话。

> 安全：收件口只监听 127.0.0.1 且需令牌校验。

### 用户白名单（已启用）
`.env` 的 `ALLOWED_OPEN_IDS` 已填入你的 open_id，非该用户的消息会被拒绝。

### 上线验收
凭据填好后，按顺序跑：
1. `npm run check`（快速自检）
2. `npm run verify`（真正建立飞书长连接，看到「✓ 飞书长连接已建立」）
3. `npm start` 后按 `docs/mobile-acceptance-checklist.md` 用手机逐项实测

## 三、使用说明

| 操作 | 说明 |
|---|---|
| 直接发消息 | 交给电脑上的 DSH 执行，完成后自动回复 |
| 查看进度 | 任务进行中会收到「⏳ 进行中：已执行 N 步，正在调用：工具…」（默认 10 秒一条，可调 `PROGRESS_THROTTLE_MS`） |
| 审批/授权 | 需要权限时收到**授权卡片**，点「✅ 允许 / 🚫 拒绝」按钮即可（也可直接回复 允许/拒绝） |
| 提问 | 模型问你问题时机器人会发「❓」，回复编号（如 `1`）或直接输入答案 |
| 产物提示 | 任务用了写文件/命令类工具时，最终回复会提示「📁 产物已保存在电脑工作区」 |
| 图片推送 | 任务产出的图片（如 `read_image`、图表）会自动推送到飞书（JPG/PNG/WEBP/GIF，≤10MB） |
| **文件推送** | 任务用 write/edit 创建或修改的文件会自动作为**文件消息**推送到飞书（默认每轮最多 3 个、单个 ≤20MB，可调 `MAX_FILE_PUSH`/`MAX_FILE_BYTES`） |
| 命令 | 说明 |
|---|---|
| `/new` | 开启新会话（加入你的会话池，建在当前工作区） |
| `/list` | 查看本聊天的所有会话（**标注所在工作区** + 当前标记 + 运行状态） |
| `/switch <序号>` | 切换会话（如 `/switch 1`） |
| `/workspace` | 查看所有工作区（▶️ 为当前） |
| `/workspace <序号\|名称>` | 切换工作区（新会话将建在其中） |
| `/workspace <目录路径>` | 收养一个新目录为工作区并切换 |
| `/stop` | 停止当前任务 |
| `/help` | 帮助 |

限制（当前版本）：
- 单机器人（一个应用）；如需多机器人/多工作区可关注后续版本。
- 回复为文本 + 图片/文件消息（未用 Markdown 交互卡片作为主回复形式）。
- 长时间任务每轮完成会汇总通知；超时（默认 30 分钟）会先发进度，完成后再发最终结果。

## 四、常见问题

- **`[gw] DSH_BASE_URL=...` 后没有 `long-connection started`**：检查 `.env` 里 App ID/Secret 是否填写。
- **DSH 未启动**：先运行 `dsh --profile web`，确认浏览器能打开 127.0.0.1:3080。
- **机器人不回复**：检查飞书后台事件订阅是否为"长连接"模式、`im.message.receive_v1` 是否订阅、应用是否已发布。
- **回复"回复未生效（not-pending）"**：该审批/提问已超时或已被处理（例如你在电脑端 UI 里点了）。
- **并发**：同一会话同一时间只执行一个任务，多余消息自动排队。

## 五、后续可扩展（路线图）

- 多机器人/多工作区（参照 dsh-feishu-connect 的多 bot 模型）
- Agent 主动发消息（`feishu_send` 类工具，需 DSH 插件配合）
- 扫码创建机器人（飞书官方应用注册流程，免手动建应用）
- Markdown 卡片作为主回复形式、`/switch` 多会话
- 对比分析与发布计划：见 `docs/compare-dsh-feishu-connect.md`、`docs/publish-plan.md`
- 多用户会话隔离、按群组分发
