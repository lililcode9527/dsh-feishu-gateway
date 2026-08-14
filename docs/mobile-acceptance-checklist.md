# 手机实测验收清单（凭据就绪后按序执行）

> 前置：`.env` 已填 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，且飞书后台 5 项配置已完成（见 `feishu-setup-checklist.md`）。
> 预计 10 分钟。每一项标注 ✅ 即通过；失败项按括号内提示排查。

## 阶段 0：环境自检（电脑上）
- [ ] `npm run check` → 1/3 DSH 正常；2/3 凭据有效（飞书返回 code=0）
- [ ] `npm run verify` → 出现 **「✓ 飞书长连接已建立（WebSocket connected）」**

## 阶段 1：启动与连通（电脑上）
- [ ] `npm start` → 日志出现 `[feishu] long-connection started (WS)` 且无报错
- [ ] （可选）开机自启：`powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`

## 阶段 2：手机端功能实测（手机飞书给机器人发消息）
| # | 测试 | 操作 | 预期 | 排查提示 |
|---|---|---|---|---|
| 1 | 基础对话 | 发 `你好` | 回「🤖 已收到，开始处理…」→ 最终回复 | 无回复：查后台事件订阅/权限/发布 |
| 2 | 任务执行 | 发 `用 PowerShell 输出 HelloFromBot` | 回复含 HelloFromBot + 🔧 工具 + 📁 产物提示 | 沙箱报错：确认 `.env` 的 `DSH_SESSION_CWD` 指向工作区 |
| 3 | 进度推送 | 发一个稍长的任务（如搜索+总结） | 过程中收到「⏳ 进行中：已执行 N 步」 | 无进度：`PROGRESS_THROTTLE_MS` 是否被改大 |
| 4 | 提问回填 | 发 `用 ask_user_question 问我猫还是狗，然后按回答回复` | 收到「❓」→ 回复 `1` → 「✅ 已回复」→ 模型继续 | 「回复未生效」：该提问已超时，重发 |
| 5 | 授权审批 | 视会话策略：需要授权时收到「🔐」→ 回复 `允许`/`拒绝` | 「✅ 已允许」任务继续 | 若策略不触发审批属正常（网关逻辑已单测覆盖） |
| 6 | 图片推送 | 发 `读取一张图片并描述`（工作区放张图）或让模型生成图表 | 收到图片消息 | 图片≤10MB；`session.attachment` 失败看网关日志 |
| 7 | 命令 | 发 `/new` `/list` `/stop` `/help` | 各自正常响应 | — |
| 8 | 排队 | 任务进行中再发一条 | 回「⏳ 已排队」，完成后继续处理 | — |
| 9 | 断线恢复 | 重启网关进程 | 自动重连，再次发消息正常 | `DshClient`/`WSClient` 均带重连 |

## 阶段 3：收尾
- [ ] 确认控制台 `[gw] message from open_id=ou_xxx` 打印（可用来填 `ALLOWED_OPEN_IDS` 白名单）
- [ ] （可选）在 `.env` 填 `ALLOWED_OPEN_IDS=ou_xxx` 后重启，验证非白名单被拒
- [ ] 更新本文档：标注完成日期与结果

## 失败快速定位表
| 现象 | 大概率原因 |
|---|---|
| verify 卡住/超时 | App Secret 错误、应用未发布、后台未选长连接 |
| 网关启动但收不到消息 | 事件未订阅 `im.message.receive_v1` 或订阅方式仍是 Webhook |
| 能收不能回 | `im:message` / `im:message:send_as_bot` 权限未开通 |
| 电脑端 DSH 没在跑 | 先 `dsh --profile web`，浏览器能开 127.0.0.1:3080 |
