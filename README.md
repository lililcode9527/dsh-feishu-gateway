# DSH-Feishu-Gateway

手机飞书直连电脑上的 **DeepSeek Harness**：对话、任务、审批（卡片）、进度、图片/文件产物、会话池、工作区、多机器人、**feishu_send 主动推送**。独立进程、免公网端口、零侵入 DSH。

## 快速开始（约 10 分钟）

```bash
cd feishu-gateway
npm install
copy .env.example .env        # 编辑填入 FEISHU_APP_ID / FEISHU_APP_SECRET
npm run check                 # 自检
npm run verify                # 上线验收（建立飞书长连接）
npm start                     # 启动网关
```

前置：DSH Web 已运行（127.0.0.1:3080）、Node.js ≥ 20、已按《使用文档》第 3 节完成飞书后台建应用。

## 文档

- **《使用文档.md》** —— 完整说明（配置/手机命令/运维/安全/排查/发布）
- `docs/feishu-setup-checklist.md` —— 飞书后台配置清单
- `docs/mobile-acceptance-checklist.md` —— 手机实测验收清单
- `docs/compare-dsh-feishu-connect.md` —— 与社区插件方案对比
- `docs/publish-plan.md` —— npm 发布计划

## 注意事项

- 交付包已剔除 `.env`（真实密钥）与 `data/`（运行时数据），使用前需自行创建
- 不要在 feishu-gateway 目录里运行 `dsh` 命令（`.env` 的 `DSH_BASE_URL` 与 dsh 保留变量冲突）
- 开机自启与手动双击启动二选一，避免双实例

MIT License
