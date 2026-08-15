# dsh-feishu-gateway-plugin

DSH **深度集成插件**：手机飞书直连电脑上 DeepSeek Harness 的**桌面当前会话**——手机发消息直接进入你电脑端正在打开的会话，桌面与手机完全同频。

- **会话模型**：手机消息进入**电脑端当前打开的会话**（bot 工作区内最近活动、非归档），不建专用会话；可用 `/switch` 在手机端固定/恢复目标会话
- **feishu_send 原生工具**：Agent 可主动给手机发 Markdown 卡片（无需独立进程/收件口）
- **提问/审批卡片**：经 api-proxy mux 转发到飞书，手机回复编号/点按钮即可
- **进度/图片/文件**：回合内轮询 events 推送进度；产物图片/文件自动送达手机；手机发的图片/文件也能交给 Agent 处理
- **/model 切换模型**：手机端查看/切换当前会话模型（`session.selectModel`）
- **掉线告警**：飞书连接断开/恢复/异常时主动私聊通知归属人
- **管理路由**：`/feishu/admin/*`（状态/配置/测试发送/删除/扫码建机器人）
- **多机器人/多工作区**：`~/.dsh-feishu/config.json` 的 `bots` 数组

## 安装（推荐：dsh plugin，需 pnpm）

```bash
cd 你的 dsh 主目录（不要在本仓库目录跑）
dsh plugin --profile web add "file:<本仓库绝对路径>/dsh-feishu-gateway-plugin"
# 首次需 pnpm：npm install -g pnpm
# 若提示 protobufjs 构建被忽略：编辑 ~/.dsh/profiles/web/pnpm-workspace.yaml，
#   把 allowBuilds.protobufjs 设为 true，重跑 add
```

> 手动安装（免 pnpm）备选：把本目录复制到 `~/.dsh/profiles/web/node_modules/dsh-feishu-gateway-plugin/`，
> 并在 `~/.dsh/profiles/web/cordis.patch.yml` 加：
> ```yaml
> - insert:
>     - id: feishu-gateway-plugin
>       name: dsh-feishu-gateway-plugin
> ```

## 配置

`~/.dsh-feishu/config.json`（首次启动无文件则创建空 `{ "bots": [] }`）：

```json
{
  "bots": [
    {
      "name": "ds-hs",
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "workspace": "C:\\Users\\you\\Desktop\\harness",
      "allowedOpenIds": ["ou_xxx"],
      "ownerOpenId": "ou_xxx"
    }
  ]
}
```

- `workspace`：该机器人要用的工作区目录（手机消息进入此工作区内电脑端当前打开的会话）；留空=沙箱根目录
- `allowedOpenIds`：白名单；留空=不限制
- `ownerOpenId`：归属人 open_id（扫码创建自动回填；掉线告警/通知发往此用户）
- `targetSessionId`：（可选，一般由 `/switch` 写入）手机消息的固定目标会话，不配置则自动跟随电脑端当前会话
- 配置**热加载**（每 5 秒检查），改动无需重启；也可用设置页（`/feishu/admin/*`）或直接编辑文件

## 手机端命令

- `/list` — 查看所有工作区及会话（同电脑端侧边栏，▶️ 标当前消息目标）
- `/switch` — 切换消息目标会话；`/switch <编号>` 固定，`/switch` 恢复自动跟随
- `/model` — 查看当前模型与可用列表；`/model <编号>` 切换模型
- `/timer <分钟> <内容>` — 定时提醒（如：`/timer 10 提醒我喝水`）
- `/cancel` — 取消定时提醒并中断当前回合
- `/help` — 帮助

## 测试

```bash
npm test          # 需本地测试桩 node_modules/@deepseek-ai/dsh-tools（仅测试用）
```

## 说明

- 依赖 DSH 的 `agents` 服务与 api-proxy 的 mux（web profile 均含）
- 提问/审批走 api-proxy 的 pending 表 + `/api/respond`
- 掉线告警依赖 `ownerOpenId` 或 `allowedOpenIds[0]`（私聊推送）
- 与独立版 feishu-gateway **二选一**（都会连同一个飞书机器人，避免双实例）
