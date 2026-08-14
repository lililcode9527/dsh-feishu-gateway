# 手机连接 DeepSeek Harness 方案分析

> 目标：手机像电脑端一样直接与 DeepSeek Harness 对话、下达任务、查看进度/产物、处理审批。
> 参考实现：OpenClaw（HTTP Gateway + 移动端）、Codex 社区（remote_codex 等）、腾讯 WorkBuddy（云端多端同步）。
> 分析日期：基于本机 DSH 0.1.0-rc.6（`dsh --profile web`，端口 3080）。

## 实施进度（2026-08）
- ✅ **已打通（手机实测通过）**：飞书机器人 `ds-hs` 与电脑 DSH 全链路运行中。手机实测：`你好` 对话、PowerShell 真实任务执行（🔧 工具 + 📁 产物提示）、`⏳` 进度推送、`/help` 命令，均在手机上收到回复。用户 open_id：`（个人标识，已隐藏；见 feishu-gateway/.env 的 ALLOWED_OPEN_IDS）`。
- ✅ 方案：**D（飞书机器人网关）**，适配场景：手机与电脑不在同一 Wi-Fi、鸿蒙 NEXT、追求聊天式体验。
- ✅ 网关已实现并本地验证：`feishu-gateway/`（Node + 飞书长连接 SDK + DSH /api 直连）。普通对话、提问（ask_user_question）全链路通过真实 DSH 冒烟测试（ALL PASS）；审批（授权）链路通过 9 项单元测试覆盖（本环境审批策略未触发真实审批帧，属策略相关，非网关缺陷）；pwsh 等工具在机器人会话中已可正常执行。
- ✅ 你侧配置环节已配套：`npm run check` 配置预检（验证 DSH 可达 + 凭据有效性）、网关启动时 DSH 健康检查、飞书后台配置清单见 `docs/feishu-setup-checklist.md`。
- ✅ 进度与产物能力已补齐：任务进行中节流推送「⏳ 进行中：已执行 N 步，正在调用：工具…」；写文件/命令类任务结束时附「📁 产物已保存在电脑工作区」提示。配套 `start-gateway.bat` 一键启动、`scripts/` 开机自启（计划任务）脚本。单元测试 12/12 ALL PASS。
- ✅ 回归验证（round 3）：真实 DSH 冒烟 ALL PASS，进度推送与产物提示在真实任务中实时生效。
- ✅ 配置摩擦已降到最低（round 4）：`npm run setup` 配置向导（打印清单+自动打开飞书后台）、`start-gateway.bat` 改为"先自检再启动"（chcp 65001 修正中文显示）、setup-guide.ps1 带 UTF-8 BOM 兼容 PowerShell 5.1。12/12 单元测试仍全过。
- ✅ 产物图片推送已实现（round 5）：任务产出的图片块自动经 `session.attachment` 取图并推送到飞书（`im.image.create` 上传 + 图片消息），带去重；SDK 接口签名已核实。单元测试 15/15 ALL PASS，网关 dry-run 启动正常。
- ✅ SDK 接线 bug 修复 + 上线验收脚本（round 6）：发现并修复 SDK 用法错误（长连接必须用 `new Lark.WSClient` 而非 `client.ws`；API 路径为 `im.v1.message/image.create`）——该 bug 若不修，填入真实凭据后也无法连接。新增 `npm run verify`：验证 DSH → 凭据 → 真正建立飞书长连接（轮询等 connected，20 秒超时判失败，附排查指引）。已用假凭据实测：飞书通道可达（返回 code 1000040343），验证脚本正确判失败；单元测试仍 15/15 ALL PASS。
- ✅ 最后一步工具就绪（round 7）：`docs/mobile-acceptance-checklist.md` 手机实测验收清单（9 项功能 + 失败定位表）；`scripts/run-gateway.ps1` 升级为崩溃自动重启的守护进程（配合开机自启长期运行）。单元测试仍 15/15 ALL PASS，守护进程启动实测正常。
- ✅ 消息去重加固（round 8）：飞书长连接事件超时会被重推，按 `message_id` 去重（120 秒窗口、上限 2000 条），防止同一任务重复执行。语法/单测/启动均验证通过。
- ⏳ 待你完成：飞书后台建应用（App ID/Secret）→ 填 `.env` → `npm run check` → `npm run verify` → `npm start` → 按验收清单手机实测。

---

## 打通思路（总览，纯逻辑梳理）

### 1. 总体链路：一条消息如何从手机到达你电脑上的 DSH

```
手机飞书 App
   │ ① 你发消息
   ▼
飞书服务器（云端）
   │ ② 推送到电脑上网关主动建立的【长连接 WebSocket 通道】
   ▼
电脑上的网关进程
   │ ③ 解析消息 → 调 DSH 本地 /api（127.0.0.1:3080）
   ▼
DSH agent 执行（用你电脑的算力/文件/网络/API 额度，与电脑端 UI 完全同一套）
   │ ④ 事件流（文本块、工具调用、提问/审批、回合结束）经 WebSocket 流回网关
   ▼
网关整理成飞书消息
   │ ⑤ 回复推回飞书 → 手机收到
```

**核心洞察**：整条链路里，电脑**不需要公网 IP、不需要开放任何端口、不需要改路由器**。因为通道方向是"网关主动连出去"（出站），飞书服务器只是把消息推送回这条已建立的通道。这一条就解决了"手机和电脑不在同一 Wi-Fi"的最大障碍，也天然避开了家庭宽带没有公网 IP、运营商 NAT 的问题。

### 2. 为什么是这条路线（约束推导）
- 手机与电脑大概率**不在同一 Wi-Fi** → 局域网直连方案出局；
- **鸿蒙 NEXT** 无法安装 Tailscale 安卓版 → 组网方案受挫（浏览器访问 Web UI 的完整形态只能降级）；
- 追求**最好用** → 聊天式对话体验 > 浏览器里操作；
- 选**飞书**：国内可用、鸿蒙原生客户端、个人可免费创建企业自建应用、**长连接免公网回调地址**、机器人 API 支持审批卡片（后续演进）；
- **安全**：App Secret 是唯一钥匙（泄露=控制你的电脑）；可选用户白名单；不开放任何入站端口。

### 3. 要打通的 5 个问题及答案
| 问题 | 答案 |
|---|---|
| 跨网络怎么连 | 飞书长连接（出站 WebSocket），免公网、免端口 |
| 手机怎么下达任务 | 飞书文本消息 → 网关解析：普通文本=任务，`/new` `/list` `/stop` `/help`=会话管理 |
| DSH 怎么执行 | 复用运行中的 `dsh --profile web` 实例的 /api；**每个飞书用户映射一个 DSH 会话**（sessionId 持久化），消息以 queue 模式入队，agent 在你电脑上跑，与电脑端 UI 共用同一套会话/工作区/额度 |
| 结果怎么回来 | 网关订阅 DSH 事件流（WebSocket）：流式文本块 → 回合结束汇总成一条飞书回复；长任务发进度提示，超时有兜底 |
| 授权/提问怎么办 | 事件流中的 approval/question 帧 → 转成飞书"允许/拒绝"或"编号选择" → 你的回复经 `/api/respond` 回填给 agent，任务继续 |

### 4. 会话与状态管理
- 映射关系：飞书 `open_id` ↔ DSH `sessionId`，持久化到本地 JSON（重启不丢）；
- 同一会话**串行执行**，新消息自动排队（与电脑端同一会话的队列一致）；
- 机器人创建的会话在**电脑端 GUI 侧边栏同样可见**，两边可以接力同一个任务；
- 机器人会话固定工作目录（避免 Windows 沙箱临时目录冲突，已在本地验证修复）。

### 5. 分工边界（代码 vs 你）
- **已做（代码，本地已验证）**：网关全部逻辑——飞书长连接接入、消息解析、会话映射、事件流订阅、回复整理、提问/审批回填、命令、持久化、dry-run 模式、冒烟+单元测试。
- **你来做（一次性飞书后台配置，约 10 分钟）**：创建企业自建应用 → 添加机器人 → 开通 `im:message` / `im:message:send_as_bot` 权限 → 事件订阅选"长连接"并订阅 `im.message.receive_v1` → 发布版本 → 复制 App ID / Secret。
- **之后**：填 `.env` → `npm start` → 手机飞书发第一条消息，实测完成。

### 6. 打通后的形态与演进
- **v1（当前）**：文本对话 + 提问/授权问答 + 命令 + 会话持久化；
- **可选演进**：飞书卡片按钮审批（替代文本回复）、图片/产物文件推送、Windows 开机自启（nssm/计划任务）、多用户白名单、群聊内 @机器人 使用。

### 7. 风险与边界（诚实清单）
- 没有 App Secret 前，飞书侧无法实测（网关侧已 dry-run 验证）；
- 审批帧是否触发取决于 DSH 会话的审批策略（本环境 pwsh 未触发真实审批帧，网关侧逻辑已用单元测试覆盖）；
- 飞书文本消息有长度上限 → 超长回复截断并提示到电脑端查看；
- 模型输出的**图片暂不支持推送**（占位提示，后续可做）；
- 网关进程需保持运行（电脑睡眠/关机时不可用；可做自启+断线重连，重连已实现）。

---

## 一、DSH 现状摸底（已核实源码）

| 事实 | 说明 |
|---|---|
| 服务端监听 | `dsh --profile web` 只监听 `127.0.0.1:3080`（仅本机）。 |
| 绑定限制 | `WebServer` 配置只允许 `127.0.0.1` / `0.0.0.0`；CLI 显式拒绝 `--host 0.0.0.0`（注释明说：会向网络暴露远程代码执行）。但**配置补丁层（cordis.patch.yml）允许写 `0.0.0.0`**，CLI 拒绝只是启动参数层的限制。 |
| /api 信任围栏 | 所有 `/api` 请求过 browser-trust fence：Host 头必须是 loopback 或 `trustedHosts` 列表内（`--trusted-host <host[:port]>` 可加；绑定 0.0.0.0 时自动把本机 LAN IP 加进去）。**它不是认证**，只是防 DNS rebinding / CSRF；且要求浏览器 Origin 与 Host 一致。 |
| API 能力 | `/api` 是完整 RPC：sessions、events（流式）、goals、jobs、questions（审批/提问）、subagents、workspace、llm、settings、skills、下载、导出等。**前端 UI 就是通过这套 API 工作的**。 |
| 前端 | React SPA，已带 `viewport` 移动端 meta + `manifest.webmanifest`（可“添加到主屏幕”当 App 用，全屏模式）。无 Service Worker（不能离线）。 |
| 会话持久化 | 会话存 `~/.dsh/sessions`（JSONL），重启服务不丢会话、可恢复。 |

**核心结论**：手机要“像电脑端一样”，最直接 = 让手机浏览器访问同一个 Web UI。DSH 已备好 LAN IP 派生、`--trusted-host`、PWA 清单，缺的只是“把端口安全地暴露到网络 + 加一层认证”。

---

## 二、参考实现怎么做的

### 1. OpenClaw（最接近 DSH 的形态）
- 官方[远程访问文档](https://docs.openclaw.ai/zh-CN/gateway/remote)推荐两条路线：
  1. **Tailscale / WireGuard 等 mesh VPN**：电脑和手机入同一虚拟内网，手机浏览器直接访问 `http://<tailscale-ip>:<port>`，流量加密、无公网暴露；
  2. **Cloudflare Tunnel 等公网隧道**：拿到一个 `https://` 公网地址，配 Cloudflare Access / 密码鉴权。
- 社区移动客户端（[ClawApp](https://github.com/qingchencloud/clawapp) PWA+APK、[clawke](https://github.com/clawke/clawke)）本质都是“手机浏览器/壳 访问同一个 HTTP Gateway”。
- 另有**聊天平台网关**（Telegram/Discord/WhatsApp bot）：手机用聊天 App 直接对话，agent 在电脑上执行——这是“手机原生聊天体验”的样板。

### 2. Codex（社区方案）
- [remote_codex](https://github.com/lanchoxie/remote_codex)：手机端 Web UI + 远程控制面，驱动 PC/服务器上的 Codex 会话，配合反向隧道 + token 认证。
- [codex-remote-control-lab](https://github.com/Sunwood-ai-labs/codex-remote-control-lab)：局域网手机桥接实验，token 保护。
- 模式总结：**本地 agent + 暴露 HTTP 端点（局域网/隧道）+ 认证层**。

### 3. 腾讯 WorkBuddy（云端控制面）
- 架构：电脑端 agent 与手机 App **都通过腾讯云端同步任务/产物**；手机可发起任务、查看产物、**远程授权/停止**电脑端任务。
- 对本地 DSH 的启示：我们不需要建云端，但可以模拟“控制面”——用**聊天机器人网关**（把聊天平台当控制面）或**自建隧道**，实现“手机发消息 → 电脑执行 → 手机看结果/审批”。

---

## 三、可行方案对比

| 方案 | 手机体验 | 可用范围 | 安全性 | 成本/工作量 | 适配场景 |
|---|---|---|---|---|---|
| **A. 局域网暴露 + 反向代理/密码** | 浏览器/PWA，功能与电脑端 100% 一致（含审批、任务、产物） | 同一 Wi-Fi/局域网 | 需自加认证 + 防火墙限 IP | **低**（约半小时） | 在家/办公室，最快可用 |
| **B. Tailscale 组网** | 同上 | **任何网络**（蜂窝网也行） | 高（隧道加密 + 设备身份） | 低（装两个 App） | 常外出、想要安全内网 |
| **C. 公网隧道**（Cloudflare/ngrok/frp） | 同上，HTTPS 公网地址 | 任何网络 | 高（Access/密码/token） | 中 | 不想装 App；国内注意 trycloudflare 可能不通 |
| **D. 聊天机器人网关**（Telegram/飞书/QQ bot） | 聊天 App 原生对话 + 推送，最“像聊天” | 任何网络 | 高（bot token） | **中高**（需开发 DSH 网关插件） | 想要手机端最佳对话体验 |
| **E. 自研手机客户端**（原生/定制 PWA） | 定制化 UI | 取决于传输 | 取决于传输 | 高 | 有定制需求时再说，当前不推荐 |

### 方案 A 细节（推荐第一优先）
- 保持 `dsh --profile web` 不动，在电脑上再起一个**反向代理**（Caddy / Nginx / Node 单文件）监听 `0.0.0.0:<端口>`，转发到 `127.0.0.1:3080`，并加 **HTTP Basic 认证（密码）**。
- **关键坑**：DSH 的 /api 信任围栏要求 `Host == Origin`。代理必须**透传原始 Host**（手机访问的 `http://<电脑IP>:<端口>`），并让这个地址进入 `trustedHosts` —— 即重启 dsh 时加 `--trusted-host <电脑LAN-IP>`（或带端口）。不能把 Host 改写成 127.0.0.1，否则浏览器请求会被 403。
- Windows 防火墙：放行代理端口，`RemoteAddress` 可只允许手机 IP/网段。
- 手机浏览器访问 `http://<电脑IP>:<端口>` → “添加到主屏幕”当 App。
- 需要重启一次 dsh（会话不丢，可恢复）。

### 方案 B 细节
- 电脑、手机都装 Tailscale，同一 tailnet；手机访问 `http://<电脑tailscale-IP>:<端口>`。
- 认证由 Tailscale 身份承担（未加入 tailnet 的人根本连不上），无需额外密码。
- 同样要 `--trusted-host <tailscale-IP>` 或绑定 0.0.0.0。
- 国内网络：Tailscale 走 DERP 中继时可能慢，可配置自建 DERP；替代品 ZeroTier / 蒲公英。

### 方案 C 细节
- `cloudflared tunnel --url http://127.0.0.1:3080`（临时隧道）或 ngrok `http 3080` + basic auth；生产用 Cloudflare Tunnel + Access（邮箱验证码）。
- 手机直接开 HTTPS 公网地址，无需装任何东西。
- 国内：trycloudflare 域名常被墙；稳定做法是 frp + 自己的云服务器域名（配密码/token + HTTPS）。

### 方案 D 细节（WorkBuddy 式“控制面”）
- 在电脑上跑一个 bot 网关插件：手机在聊天 App 里发消息 → 网关调 DSH 的 `/api`（sessions/events/questions）→ 电脑上的 harness 执行 → 流式回消息，审批用按钮。
- 国内可用平台：飞书 / QQ 机器人 / 钉钉；海外：Telegram / Discord。
- 工作量最大，但体验最接近“手机直接对话”，且**完全不需要开放端口**（bot 是出站连接）。
- 建议作为第三阶段，或与方案 A/B 并存。

---

## 四、安全须知（务必读）
1. DSH 的 /api 能执行命令（跑代码、改文件），**暴露 = 远程代码执行**。任何方案都必须有认证层，不能裸奔。
2. browser-trust fence **不是认证**，只是防 DNS rebinding/CSRF。
3. 推荐组合：**认证（反代密码 / Tailscale 身份 / bot token） + 防火墙只放行必要端口/来源 IP + 尽量不走公网明文**。
4. 临时验证可用 `dsh --profile web --host 0.0.0.0 --trusted-host <LAN-IP>`？——注意：CLI 拒绝 0.0.0.0，需走配置补丁 `cordis.patch.yml` 写 `webServer.host: 0.0.0.0`（重启生效），仅限可信网络、临时开。

---

## 五、推荐路线（按用户实际场景：不在同一 Wi-Fi、鸿蒙、追求最好用）
1. **主方案 D：聊天机器人网关**（飞书优先：国内可用、有鸿蒙客户端、官方机器人 API 支持卡片按钮审批）——手机聊天式对话 + 审批推送，最像 WorkBuddy 的"手机直接对话"。
2. **搭配方案 B：Tailscale 组网**——手机浏览器随时打开完整 Web UI（任务进度、产物、全部面板）。鸿蒙兼容安卓 APK（HarmonyOS 4.x）可装 Tailscale 安卓版；HarmonyOS NEXT 纯血则改用 ZeroTier/蒲公英 或仅依赖 D。
3. **方案 A（局域网反代+密码）** 降级为可选补充：偶尔手机与笔记本同网时直接用。
4. 方案 C/E 视需要再议（国内网络下 trycloudflare 大概率不通）。

### 运作原理速览（防误解）
- 手机**不是**控制笔记本连接的 WiFi，而是通过网络访问笔记本上运行的 DSH 程序。
- **A（局域网）**：手机与笔记本连同一路由器 → 手机浏览器访问 `http://笔记本局域网IP:端口`。
- **B（Tailscale）**：两端装 Tailscale，建立加密虚拟内网隧道（各自网络无所谓），手机访问 `http://<tailscale-IP>:端口`，无需公网端口，跨网络可用。
- **D（聊天机器人）**：笔记本上跑 bot，**主动出站连接**聊天平台服务器；手机在聊天 App 发消息 → bot 调 DSH /api（本机 127.0.0.1，信任围栏天然通过）→ 执行 → 回消息/审批按钮。不开放任何入站端口。

---

## 六、待确认问题（已按新场景更新）
- 鸿蒙版本：HarmonyOS 4.x（兼容安卓 APK，可装 Tailscale）还是 HarmonyOS NEXT（纯血，需 ZeroTier/蒲公英或仅靠 D）？
- 聊天平台选哪个：飞书（推荐）/ QQ 机器人 / Telegram（需梯子）？
- 实施顺序：先做 B（完整 Web UI，快）过渡，还是直接开发 D？
