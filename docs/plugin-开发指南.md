# DSH 插件开发指南（基于本项目实践 + 源码研读）

> 目标：理解 DSH 的插件机制，为把 feishu-gateway 从"独立进程"转换为"DSH 插件"做准备。

## 1. 插件是什么

DSH 基于 **Cordis** 插件体系。一个插件就是一个 npm 包（或目录），**导出 `{ name, inject, apply }`**：
- `name`：插件唯一 id（如 `feishu-send`）
- `inject`：本插件依赖的服务名数组（如 `["tools"]`）
- `apply(ctx, config)`：加载时执行；`ctx` 提供服务访问（`ctx.tools`、`ctx.provide`、`ctx.inject`、`ctx.plugin`…），`config` 是插件配置（loader 校验后注入）

DSH 启动时，loader 按 **profile 组合**加载插件：
```
~/.dsh/profiles/web/
├── package.json        → dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...]
├── cordis.patch.yml    → 用户补丁层（insert 条目可注册插件）
└── node_modules/       → 已安装的插件包（含我们手动装的 dsh-feishu-send）
```
- **bundle 层**：profile 声明要加载的包；包可自带 `cordis.patch.yml`（package.json 里 `dsh.bundle.patch` 字段声明），loader 自动把它作为补丁层应用（如 `@deepseek-ai/dsh-web-app` 就是这么干的）。
- **patch 层**：`cordis.patch.yml` 里的 insert 条目直接注册插件条目（`- insert: - id: xxx, name: 包名`）。

## 2. 安装插件的两种方式（二选一，别混用）

```bash
# 方式一：dsh plugin（自动写 bundles + pnpm 装依赖）
dsh plugin --profile web add <包名或路径>    # 需要 pnpm；不要在该项目目录跑（.env 冲突）

# 方式二：手动（免 pnpm）
# 1) 把包的 index.js + package.json 复制到 ~/.dsh/profiles/node_modules/<包名>/
# 2) 在 ~/.dsh/profiles/web/cordis.patch.yml 加：
#    - insert:
#        - id: <插件id>
#          name: <包名>
# 3) 重启 dsh web
```

## 3. 插件解剖：feishu_send 工具注册（最小例子）

```js
import { defineTool } from "@deepseek-ai/dsh-tools";
const name = "feishu-send";
const inject = ["tools"];                       // 需要 tools 服务
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "feishu_send",
    description: "...",
    parameters: {
      text: { type: "string", required: true, description: "..." },
      // ...
    },
    output: {                                    // 必填！
      schema: { type: "object", properties: { sent: { type: "boolean", required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args) { ... return { sent: true }; }
  }));
}
export { apply, inject, name };
```
要点：`defineTool` 的 `output.render` 是必填；参数 schema 用 `{ type, required, description }` 描述；`execute` 返回 JSON 值。

## 4. 可用服务（inject 可声明）

| 服务 | 用途 | 例子 |
|---|---|---|
| `tools` | 注册工具 | dsh-feishu-send、dsh-tool-ask-user |
| `systemPrompt` | 往系统提示词加 section | dsh-web-app（web-surface） |
| `shellEnv` | 暴露给 Agent 的环境变量 | dsh-web-app（DSH_WEB_URL） |
| `webServer` | 注册 HTTP 路由 / WebSocket | dsh-host-apiproxy、client-connection |
| `agents` | 创建/获取 Agent 会话（**深度集成用**） | dsh-feishu-connect（ctx.agents） |
| `sessions` | 会话服务 | 深度集成 |
| `userQuestions` | 提问（ask_user_question） | dsh-tool-ask-user |
| `slots`/`layout`/`locale` | **client 插件** UI 槽位（设置页/侧边栏） | dsh-client-ui-* |
| `workspaces` | 工作区（client 侧） | dsh-client-ui-workspace |

插件配置：导出 `Config`（schemastery schema），loader 校验后经 `apply(ctx, config)` 传入（参考 `@deepseek-ai/dsh-web-app` 的 `Config = z.object({...})`）。

## 5. 本项目转换方案（feishu-gateway → 插件）

### Phase 1：包装（最小改动，复用全部已测逻辑）
- 新建插件包 `dsh-feishu-gateway-plugin`：`apply(ctx, config)` 里做现在 `index.js` 做的事——创建 FeishuBot（长连接）+ TurnRelay（relay/store/命令/审批/进度/文件/图片全复用），仍走 DSH 本地 `/api`（插件在 DSH 进程内，loopback 3080 照常可用）。
- **feishu_send 原生化**：直接在 `apply` 里 `ctx.tools.register(feishu_send)`（工具内调用本插件的发送方法），**不再需要**独立插件 + HTTP 收件口（3180）——合并成一个插件。
- 配置：插件 `Config`（bots 数组 / 单 bot）或沿用 `.env`/`bots.json`。
- 安装：手动复制或 `dsh plugin add`；随 dsh web 启动，无需单独自启。
- 风险：低（逻辑不变）；代价：会话仍由 /api 创建（与 GUI 共享工作区，同现状）。

### Phase 2：深度集成（对齐 dsh-feishu-connect）
- 用 `ctx.agents` 创建/恢复会话（**每聊天会话池、工作区绑定、模型注入**，彻底不串 GUI）。
- 用 `ctx.userQuestions`（提问）、approval 服务（审批）原生处理，不再走 /api/respond。
- **client 插件**（client.js）：设置页 UI（机器人列表/扫码创建/测试发送），inject `slots/layout/sessions/workspaces/locale`。
- feishu_send 原生（Phase 1 已做）。
- 风险：中高（依赖内部服务 API，需随 DSH 版本演进）；收益：安装体验/设置页/会话隔离最完整。

### 取舍速览
| 维度 | 独立进程（现状） | Phase 1 插件 | Phase 2 深度插件 |
|---|---|---|---|
| 安装 | 复制目录+自启 | 复制/一行命令，随 dsh 启动 | 一行命令，随 dsh 启动 |
| 稳定性 | 与 DSH 隔离 | 在 DSH 进程内（异常互影响） | 同左 |
| feishu_send | 需伴生插件+收件口 | 原生工具 | 原生工具 |
| 设置页 UI | ❌ | ❌ | ✅（扫码/多bot/测试发送） |
| 会话隔离 | 工作区级 | 工作区级 | Agent 级（不串 GUI） |
| 工作量 | — | 低（1 天级） | 高（数天级） |

## 6. 参考资源
- 已装插件：`~/.dsh/profiles/web/node_modules/dsh-feishu-gateway-plugin/`（本项目插件，含工具注册/管理路由/设置面板范例）
- 官方 bundle 范例：`node_modules/@deepseek-ai/dsh-web-app/`（配置 schema、inject、bundle patch）
- 社区完整插件：`dsh-feishu-connect`（index.js/client.js/helper.cjs 三段式架构，见 docs/compare-dsh-feishu-connect.md）
