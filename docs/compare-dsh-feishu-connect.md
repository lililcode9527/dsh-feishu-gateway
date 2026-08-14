# 对比：dsh-feishu-connect（社区插件） vs 本项目 feishu-gateway

> 分析对象：[dsh-feishu-connect@1.2.4](https://www.npmjs.com/package/dsh-feishu-connect)（npm 元数据 + README）
> 分析日期：2026-08

## 一、根本差异：架构路线不同

| 维度 | **dsh-feishu-connect** | **本项目 feishu-gateway** |
|---|---|---|
| 形态 | **DSH 插件**（Cordis 插件，peerDep `@deepseek-ai/dsh-tools`，装进 DSH 进程） | **独立进程**（旁路程序，只调 DSH 公开 /api） |
| 安装 | `dsh plugin --profile web add dsh-feishu-connect` 一条命令 + 设置页 UI 配置 | 拷贝目录 → 改 `.env` → `npm start`（或自启） |
| 与 DSH 耦合 | 深：直接用内部 `ctx.agents / ctx.fs / ctx.shell`，需匹配 DSH 插件 API 版本 | 浅：只用公开 HTTP/WS /api，DSH 版本兼容性好 |
| 崩溃隔离 | 插件跑在 DSH 主进程，异常可能影响 DSH | 独立进程，挂了不影响 DSH，DSH 挂了网关会重连 |
| 部署 | 随 DSH 启动，无需单独运维 | 需独立运行（已做自启/守护/日志） |
| 测试 | README 未见测试 | 20/20 单元测试 + 真实 DSH 冒烟 |

## 二、功能对比

| 能力 | 他们 | 我们 |
|---|---|---|
| 长连接（免公网） | ✅ 官方 SDK WSClient（helper 子进程） | ✅ 官方 SDK WSClient（同进程） |
| 多机器人/多工作区 | ✅ 一个实例多个机器人，各自绑定 workspace | ❌ 单机器人（白名单控制使用者） |
| 会话模型 | 每飞书聊天一个**专属会话池，绝不串 GUI 会话**；首条消息自动建会话并绑定工作区；重启恢复 | open_id→DSH sessionId 映射（**会话会出现在 GUI 侧边栏**，可桌面/手机接力）；持久化 |
| 命令 | `/new [名称] /switch <n> /list /help`（前缀匹配） | `/new /list /stop /help` |
| 回复形式 | Markdown **交互卡片** | 文本（+图片/文件消息推送） |
| 授权/审批 | README 未提及（可能有内部处理，未证实） | ✅ **审批卡片按钮**（允许/拒绝）+ 文字兜底 |
| 提问回填（ask_user_question） | README 未提及 | ✅ 问题转飞书文本+编号回复 |
| 进度推送 | ❌ 未见 | ✅ ⏳ 进行中（节流） |
| 图片推送 | ❌ 未见 | ✅ session.attachment 取图推飞书 |
| **文件推送** | ❌ 未见 | ✅ write/edit 产物文件推飞书 |
| Agent 主动发消息（feishu_send 工具） | ✅ 注册了 `feishu_send` 工具 | ❌（独立进程无法注册工具，见路线图） |
| 处理中表情（OnIt） | ✅ 可配置 | ❌ |
| 设置体验 | ✅ 设置页 UI + **扫码创建机器人**（免手动建应用）+ 测试发送 | 手动建应用（有向导 + check/verify 脚本） |
| 配置位置 | `~/.cc-connect/feishu.config.json`（热读，与仓库解耦） | `.env`（cwd，计划发布版支持 `--config`） |
| 安全白名单 | 未见 | ✅ ALLOWED_OPEN_IDS |

## 三、各自优势总结
- **他们强在**：安装/配置体验（一条命令+设置页+扫码）、多机器人、会话隔离（不串 GUI）、Markdown 卡片、feishu_send、表情反馈。
- **我们强在**：审批卡片/提问/进度/图片/文件等**任务闭环能力**、独立进程的稳定性与解耦、可测试性（单测+冒烟）、白名单。

## 四、结论与建议
1. **不换型**：保持独立进程路线（稳定性、解耦、审批/进度/文件是差异化优势）；发布为 npm CLI 包弥补"安装体验"短板。
2. **已借鉴落地**（本仓库当前版本）：
   - ✅ **多机器人/多工作区**：`bots.json` 配置多个机器人，各自独立长连接、工作区、会话池、白名单（`src/bots.js` + 多 bot 布线）。
   - ✅ **会话隔离**：机器人会话进入各自 **DSH 工作区**（`workspace.create` 收养目录 + `session.create(workspaceId)`），与 GUI 默认工作区隔离；每个飞书聊天拥有**会话池** + `/new /list /switch`（`src/store.js` 池化 + `src/relay.js`）。
   - ✅ 单测 28/28（含工作区收养、会话池、旧格式迁移），真实 DSH 探针验证工作区链路。
3. **仍可借鉴**（低成本项）：Markdown 卡片回复、OnIt 表情（需 `im:message.reaction` 权限）。
4. **需插件化才能做**（高成本，列为路线图）：`feishu_send` 工具、扫码创建机器人、设置页 UI。若未来要这些，可在独立进程旁再提供**可选 DSH 插件包**（复用现有 /api 逻辑）。
5. **发布包装**：见 `docs/publish-plan.md`（包名 `dsh-feishu-gateway`，npm 可用；CLI/配置目录/多机器人已就绪）。
