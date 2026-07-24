---
title: VibeHub 可复用存量资产盘点
date: 2026-07-25
status: active
audience: tech
---

# 存量资产盘点：哪些不用重写

结论先行：**VibeHub 真正要新写的只有三块——部署管道、审核发布状态机、AI 诊断流水线。** 其余部分在已有仓库里都有可直接搬用或直接抄设计的实现。

---

## 1. `vibe-deploy` — 部署管道的现成脚本

**位置**：`~/projects/vibe-deploy`
**是什么**：「一句话把 Vibe Coding 项目部署到 VPS」的 Skill 集合（`skills/deploy.md`、`skills/server-init.md`）。

**可直接吃的部分**：
- 项目类型自动检测规则（静态 / 前端构建 / Node / Python / Go / 单文件），已经写成决策树
- **双 SSH 身份设计**：`deploy` 受限用户（只能传文件、配静态站，可以分享）与 `admin` 完整用户（PM2、反代，私钥自留）。这个权限分离思路 VibeHub 应当照搬
- rsync + nginx + PM2 + certbot 的具体命令行

**不适用的部分**：它是**面向单个开发者的本机工具**（配置在 `~/.claude/deploy.json`），VibeHub 需要的是**服务端集中式部署**——学员不持有任何服务器凭证，提交到平台由平台代为部署。所以复用的是**方法**不是**代码路径**。

---

## 2. `超脑上传平台` — token / workspace 授权模型

**位置**：`~/projects/营地工具/超脑上传平台`
**是什么**：自托管文件上传平台，视频走腾讯云 VOD 直传，其他文件走 COS，网页与 Agent Skill 双入口。

**可直接吃的部分**（`docs/specs/architecture.md`、`decisions/002-workspace-library-and-token-scopes.md`）：

1. **workspace 作用域模型**——`workspaceType: camp | project | legacy` + `workspaceId` + `workspaceLabel`。VibeHub 的「课程/活动 → 项目」层级几乎是同一个东西，可以直接映射。
2. **token 授权边界的关键结论**（血泪教训，直接抄）：
   > 「token 给出角色上限；可选的 `workspaces` 配置将 token 限定到营地或项目。**身份表单仅用于台账和默认筛选，不能独立作为授权依据。**」
   > 「未配置 `workspaces` 的旧 token……持有人可声称任意 workspace，**无法提供真正的空间隔离**。」

   VibeHub 的邀请码体系必须一开始就把 scope 写进凭证，而不是靠客户端声明。
3. **Provider 抽象**——`VideoProvider` / `FileStorageProvider` 契约层，云厂商实现放在 `providers/tencent/`。VibeHub 的对象存储（学员作品的图片音频）照这个抽象做，将来换 OSS 不用改业务层。
4. **上传前 preflight 去重**——按校验值或文件名+大小返回可能重复项。学员反复提交同一版本时可以省带宽。
5. **安全边界清单**（`docs/handbook/release-checklist.md`）——公开仓库前的密钥与用户数据检查流程，VibeHub 要开公开仓库，这份清单直接用。

**已有的 Agent Skill**：`skills/superbrain-file-upload/`，是「Skill 作为 AI 工具与平台之间连接入口」的现成范例，VibeHub 的 `vibehub` skill 可以照它的结构写。

---

## 3. `Vibe Workbench` — 人机决策层

**位置**：`~/projects/AI 工作流/vibecoding 工作台` · 生产 `https://workbench.superbrain-ai.com`
**是什么**：把 AI 每轮思考渲染成图文网页，用户就地选择/批注/改写，提交后异步唤醒 AI 续跑。

**在 VibeHub 项目里的角色**：**开发方法**，不是产品组件。用它跟 Michael 和乐乐老师做 PRD 评审、架构评审、UI 评审。

**可能被 VibeHub 产品借用的机制**：
- **参与者 magic-link**（`workbench participant add <id> <name>` → 返回专属邀请链接，`participant list` 不回显 token，`revoke` 即时吊销）——这正是 VibeHub「邀请码」需要的能力模型，包括「私密名册 gitignore、列表脱敏、即时吊销」这三条。
- **逐人反馈与分歧标注**——多人同轮提交分别写 `feedback-<id>.json`，选择不同时标注「意见分歧」。将来老师多人共审时可参考。
- **会话文档库**——`workspace/<session>/documents/<category>/<slug>.md`，分类限定、正文上限 256 KiB、始终以 Markdown 为单一信息源、阅读页浏览器端渲染 HTML。**「不另存一份容易漂移的 HTML」这条设计原则值得写进 VibeHub 的文档策略。**

**已知缺口（引用其 README 的诚实声明）**：真实浏览器 E2E 自动化套件仍缺；embed/proxy 尚无 SSRF allowlist；暗色对比度未做 WCAG 全面复核。

---

## 4. `user-vibeloop` — 闭环开发框架

**位置**：`~/projects/AI 工作流/user-vibeloop`
**是什么**：内测用户网页报 bug / 提需求 → 云端 AI 分诊、在独立 git worktree 修复、跑 verify、judge agent 对照项目宣言评估 → 按风险分级自动合并或等人审批。

**在 VibeHub 项目里的角色**：**开发方法**（顾问乐乐老师可以直接提需求驱动 AI 改代码）。

**关键设计原则（对 VibeHub 产品本身也成立）**：
> 「你的自动化置信度上限，就是你 verify 命令的严格程度。」

这句话直接决定了 VibeHub 的 AI 诊断该怎么做——**诊断结论的可信度上限，等于我们能确定性验证的事实的丰富程度**。所以诊断必须建立在可验证事实之上，而不是让模型自由发挥。

**零侵入接入方式**：项目根放一个 `vibeloop.yaml`，运行数据在 `<repo>/.vibeloop/`（自动写入 `.git/info/exclude`）。VibeHub 仓库接入成本极低。

**风险等级与保护路径机制**：`riskTiers.high`、测试净删除防弱化守卫、prompt 注入嫌疑、judge 主动升级会强制生成人工审批卡。这套「分级自主权」的思路，正好可以移植成 VibeHub 的**审核分级**——不是所有版本都需要老师逐个点，低风险的（只改文案、改样式）可以配置为自动通过。

---

## 5. `ai-game-camp-platform` — 营地 AI 中台

**位置**：`~/projects/ai-game-camp-platform`
**是什么**：AI 游戏设计营的技术中台，4 个 P0 模块：模型网关 / 模板服务 / 一键部署 / AI 助教 endpoint。Python FastAPI。

**可直接吃的部分**：
1. **模型网关**（`app/gateway/` + `app/common/gateway_service.py`）——OpenAI 兼容入口，统一转发国产模型（`camp-chat`=qwen-plus / `camp-fast`=qwen-flash / deepseek / 豆包 / MiniMax 五个别名），含**未成年人安全过滤 + 限流 + 按营/学员配额 + 用量计量**。

   > ⚠️ **README 已过时，勿被误导**：该仓库 README 与 PRD 写于 2026-06-20 的 M0 骨架阶段，声明「P0 业务路由当前是契约 stub（返回 501）」。**实际核查源码后确认：网关已完整实现**——`gateway_service.py` 411 行，含 `check_safety` / `authenticate_student` / `_check_rate_limit` / `_check_quota` / 用量计量，且有 `tests/test_gateway.py`。安全策略是**安全检查异常时 fail-closed、配额检查异常时 fail-open**，错误信息已中文化（「这次的 AI token 额度不够了，请找老师补额度。」）。
   >
   > 当前仍为 501 stub 的只有 `app/board/`（23 行）与 `app/assets/`（17 行）——这两个本来就是 README 声明的 P1 模块。
   >
   > *（核查缘由：Codex 独立方案依据 README 判定网关为 stub 并建议不复用。读源码后确认该判断有误，此处按源码事实修正。）*

   **VibeHub 的 AI 诊断和学员作品调用 AI 的能力，应当走这个网关而不是自己再建一个。** 「学生永不碰 API key」这条约束在 VibeHub 完全成立。
2. **`data/safety_rules.yaml`**——运营可改的安全过滤规则表。学员作品公开发布前的内容检查可以复用。
3. **starter 模板服务**（`starters/`）——「学生从空白页开始必死，要一键 fork 一个已经能玩的 starter」。VibeHub 也需要这个：学员拿到邀请码后应该能一键得到一个已经跑得起来的项目骨架。
4. **PRD.md 的 MVP 收敛方法论**——把 Codex 原稿的 8 模块砍成 4 个「没有它营开不起来」的模块，其余用飞书多维表格承载。**这个「先问哪些东西不做营就开不起来」的裁剪标准，VibeHub 的 P0 应当照用。**

**架构分工的重要前例**（避免 VibeHub 重蹈）：该项目与 `superbrain-companion` 明确划分为两个网关——companion 管「看见学生怎么和 AI 协作」，中台管「给学生供给受控的 AI 能力」。VibeHub 需要同样明确自己**不**做什么。

---

## 6. 乐乐老师的前端原型

**位置**：`docs/research/prototype/`（已抓取存档）· 线上 `https://vibehub.preview.aliyun-zeabur.cn/`
**技术栈**：React + Vite（构建产物 `index-BXyukyln.js` / `index-X9vXqstn.css`），hash 路由。

**三个已实现页面**：
| 路由 | 页面 | 状态 |
|---|---|---|
| `#admin` | 部署审核队列（左列表 + 右预览 + 退回/发布） | 已实现 |
| `#student` | 学员个人看板（作品预览 / 网址二维码 / 运营数据 / 开发完成度 / 双版本对照 / 项目记录） | 已实现 |
| `#collection` | 作品集合页（Hero + 统计 + 分类筛选 + 作品卡片瀑布） | 已实现 |

**侧边栏其余入口（总览 / 项目 / 提交记录）目前未实现**，点击不切换内容——这是原型的边界，不是设计缺失。

**设计 token（已提取，直接作为设计系统基线）**：
```
--canvas: #f8f5ef    --surface: #fbf9f5   --surface-soft: #f4f0e9
--ink: #242321       --ink-soft: #73716d
--line: #ded9d0      --line-strong: #d2ccc2
--coral: #ed624a     --coral-deep: #da4d38  --coral-soft: #fff0ea
--blue: #3978bd      --amber: #e99a15       --success: #4c8561
字体: "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif
```
配色语义与需求文档 §9.1.4 完全一致：绿=已可用，蓝=正在完善/已连接，琥珀=需要关注，珊瑚红=高优先级问题或关键数字。

**重要判断**：原型是**手写 CSS**，风格克制、留白讲究（暖色浅底 + 细描边 + 低阴影）。**不要引入 antd / MUI 这类组件库**，会立刻毁掉这个质感。正式实现应当把这些 token 固化成 CSS 变量 + 少量原子类，组件自己写。

---

## 7. 汇总：新写 vs 复用

| 模块 | 结论 |
|---|---|
| 前端三个页面 | **原型已有**，需重写为可对接真实数据的正式实现，保留全部视觉与文案 |
| 邀请码 / 用户 / 角色 | **抄** 超脑上传平台的 token+workspace 模型 + Workbench 的 magic-link 名册机制 |
| 对象存储（作品图片音频） | **抄** 超脑上传平台的 Provider 抽象，用已有 COS 子账号 |
| 模型调用 | **复用** ai-game-camp-platform 的模型网关（含安全过滤与配额） |
| 统计 | **复用** 已有自托管 umami |
| 部署机制 | **抄** vibe-deploy 的方法 + 南京机已有的多租户目录约定 |
| 项目骨架分发 | **抄** ai-game-camp-platform 的 starter 机制 |
| 审核分级 | **抄** user-vibeloop 的风险分级与保护路径思路 |
| **部署管道（收版本→解包→校验→预览→切换）** | **新写** |
| **审核发布状态机（开发/部署/审核/发布/诊断 五维状态）** | **新写** |
| **AI 诊断流水线（事实采集 + 可解释评分 + 结论生成）** | **新写** |
| **学员作品的运行时数据能力** | **新写**（取决于「决策 1」的结论） |
