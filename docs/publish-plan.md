# 发布计划：dsh-feishu-gateway → npm

> 目标：把 feishu-gateway 包装为可发布的 npm CLI 包，发布后用户一条命令安装使用。
> 状态：**包装已完成并验证**（CLI `-h/-V/check/start` 实测通过；`npm pack --dry-run` 确认 19 文件 23.8kB，不含 .env/data/test；单元测试 ALL PASS；运行中的网关已切换到 CLI 启动）。发布动作待用户 npm 账号执行。

## 一、包装方案（已落地）

| 项 | 现状 |
|---|---|
| 包名 | `dsh-feishu-gateway`（npm 上可用，已确认 404=未占用） |
| 入口 | `bin/dsh-feishu-gateway.js`（子命令 `setup / check / verify / start`，`-h/-V`） |
| 包内容 | `bin/ src/ scripts/ README.md LICENSE .env.example`（`files` 白名单） |
| 排除 | `.env data/ .npm-cache/ test/ tools/ *.log`（`.npmignore`，防泄露凭据/冗余） |
| 配置目录 | 默认 `process.cwd()` 的 `.env`；可用 `DSH_FEISHU_CONFIG_DIR` 覆盖（src/env.js 已改） |
| 状态文件 | 配置目录下 `data/sessions.json`（随配置目录走） |
| 版本/许可 | 0.1.0 / MIT（LICENSE 已补） |
| Node 要求 | >= 20（package.json engines） |

## 二、发布步骤（需要你的 npm 账号，我无法代办）

```bash
cd feishu-gateway

# 1. 发布前自检
npm test                      # 单元测试
node bin/dsh-feishu-gateway.js -h
npm pack --dry-run            # 预览发布内容（确认不含 .env / data）

# 2. 登录 npm（必须官方 registry，镜像源不能发布）
npm login --registry https://registry.npmjs.org

# 3. 发布（首次）或改版本后发布
npm publish --registry https://registry.npmjs.org
# 更新版本：npm version patch && npm publish --registry https://registry.npmjs.org
```

## 三、发布前必查清单
- [ ] `.env` 不打包（npm pack --dry-run 确认无 `data/`、无 `.env`、无测试）
- [ ] README 顶部"npm 全局安装"说明准确
- [ ] `dsh-feishu-gateway setup` 在**空目录**下能打印清单（不依赖仓库内 .env）
- [ ] 全局安装自测：`npm i -g .` 后从任意目录执行各子命令
- [ ] 版本号语义：0.1.0 首版；破坏性改动 1.0.0 前可 0.x

## 四、发布后（可选，提升信任）
- 补 `repository` 字段（GitHub 仓库）
- 提交到 GitHub Releases + 在 README 放徽章
- 对照 `dsh-feishu-connect`（见 compare-dsh-feishu-connect.md）补差异化宣传：审批卡片/进度/图片/文件/独立进程

## 五、路线图（后续版本候选）
1. ~~多机器人/多工作区~~ ✅ 已实现（`bots.json`，各 bot 独立长连接/工作区/会话池/白名单）
2. ~~会话隔离~~ ✅ 已实现（会话进入各自 DSH 工作区 + 每聊天会话池 `/new /switch`）
3. ~~Agent 主动推送（feishu_send）~~ ✅ 已实现：网关内置 loopback 收件口（127.0.0.1:3180，令牌保护）+ 伴生插件 `dsh-feishu-send`（注册 `feishu_send` 工具），端到端实测通过（工具→收件口→飞书卡片）
4. **扫码创建机器人**：飞书官方应用注册流程（OAuth），免手动建应用
5. **Markdown 卡片主回复** ✅ 已实现（回复改为 lark_md 卡片渲染）；OnIt 表情（`im:message.reaction` 权限）待做
6. **配置热加载**（改动 .env / bots.json 无需重启）
