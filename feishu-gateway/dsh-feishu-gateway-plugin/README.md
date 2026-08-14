# dsh-feishu-gateway-plugin

DSH **深度集成插件**：手机飞书直连 DeepSeek Harness 的专用 Agent 会话。

- **专用会话**：每飞书聊天一个会话池（`ctx.agents` 创建，工作区绑定、模型注入），绝不进入 GUI 当前会话流
- **feishu_send 原生工具**：Agent 可主动给手机发 Markdown 卡片（无需独立进程/收件口）
- **提问/审批卡片**：经 api-proxy mux 转发到飞书，手机回复编号/点按钮即可
- **进度/图片/文件**：回合内轮询 events 推送进度；产物图片/文件自动送达手机
- **管理路由**：`/feishu/admin/*`（状态/配置/测试发送/删除）
- **多机器人/多工作区**：`~/.dsh-feishu/config.json` 的 `bots` 数组

## 安装（手动，免 pnpm）

```bash
# 1) 复制插件到 DSH profile
#    把 index.js + lib/ + package.json 复制到 ~/.dsh/profiles/node_modules/dsh-feishu-gateway-plugin/

# 2) 在 ~/.dsh/profiles/web/cordis.patch.yml 追加：
#   - insert:
#       - id: feishu-gateway-plugin
#         name: dsh-feishu-gateway-plugin

# 3) 重启 dsh web
```

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
      "allowedOpenIds": ["ou_xxx"]
    }
  ]
}
```

- `workspace`：该机器人的工作区目录（专用会话的 cwd）
- `allowedOpenIds`：白名单；留空=不限制
- 配置**热加载**（每 5 秒检查），改动无需重启；也可用设置页（`/feishu/admin/*`）或直接编辑文件

## 手机端命令

`/new [名称]`、`/switch <序号>`、`/list`、`/workspace`、`/help`

## 测试

```bash
npm test          # 需本地测试桩 node_modules/@deepseek-ai/dsh-tools（仅测试用）
```

## 说明

- 依赖 DSH 的 `agents` 服务与 api-proxy 的 mux（web profile 均含）
- 提问/审批走 api-proxy 的 pending 表 + `/api/respond`（与独立版网关一致）
- 与独立版 feishu-gateway **二选一**（都会连同一个飞书机器人，避免双实例）
