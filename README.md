# DSH-Feishu-Gateway（插件版）

手机**飞书**直连电脑上 DeepSeek Harness 的**桌面当前会话**：手机发消息直接进入你电脑端正在打开的会话，桌面与手机完全同频；Agent 可用 `feishu_send` 主动推送，支持审批卡片、提问、进度、图片/文件、多机器人、扫码建机器人。

```
手机飞书 ──长连接(WS)──▶ dsh-feishu-gateway-plugin（DSH 内）──▶ 桌面当前 Agent 会话
                              ▲                                    │
                              └──────────── 回复/审批/推送 ─────────┘
```

- **DSH 深度集成插件**（Cordis，装进 web profile），随 dsh web 启动，无需独立进程
- **会话模型**：手机消息进入**电脑端当前打开的会话**（工作区最近活动），不建专用会话
- **免公网**：长连接出站，不开放任何端口

## 快速开始

1. **飞书后台建应用**（一次性）：见 `docs/feishu-setup-checklist.md`（机器人能力 + `im:message`/`im:message:send_as_bot` + 长连接订阅 `im.message.receive_v1` + 发布）
2. **安装插件**：
```bash
cd 你的 dsh 工作目录
dsh plugin --profile web add "file:<本仓库绝对路径>/dsh-feishu-gateway-plugin"
# 需要 pnpm：npm install -g pnpm（首次）
# 若提示 protobufjs 构建被忽略：编辑 ~/.dsh/profiles/web/pnpm-workspace.yaml，allowBuilds.protobufjs = true，重跑
```
3. **配置** `~/.dsh-feishu/config.json`：
```json
{ "bots": [{ "name": "ds-hs", "appId": "cli_xxx", "appSecret": "xxx", "workspace": "C:\\Users\\you\\Desktop\\harness", "allowedOpenIds": [] }] }
```
4. **重启 dsh web** → 日志出现 `[feishu-gw] plugin active` 与 `long connection ready` 即生效
5. 手机飞书给机器人发消息 → 桌面当前会话收到（带 `[飞书 ou_...]` 前缀）→ 回复推回手机

## 手机命令
- `/list` — 查看工作区会话（同电脑端侧边栏）
- `/help` — 帮助

## 设置面板
浏览器打开 `http://127.0.0.1:3080/feishu/admin/panel`（机器人增删改/测试发送/扫码建机器人）。

## 测试
```bash
cd dsh-feishu-gateway-plugin
npm test   # 需测试桩 node_modules/@deepseek-ai/dsh-tools（仅本地测试用）
```

## 文档
- `使用文档.md` — 完整使用说明
- `docs/feishu-setup-checklist.md` — 飞书后台配置
- `docs/plugin-开发指南.md`、`docs/plugin-深度集成设计.md` — 插件机制与设计

MIT License
