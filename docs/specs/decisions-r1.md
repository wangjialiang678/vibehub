---
title: 第 1 轮决策结论
date: 2026-07-25
status: accepted
audience: both
---

# 第 1 轮决策结论（Michael 2026-07-24 17:29 UTC 拍板）

来源：Vibe Workbench 会话 `vibehub` round 1。原始反馈在
`~/projects/AI 工作流/vibecoding 工作台/workspace/vibehub/round-1/feedback.json`。

| # | 决策 | 结论 | 是否采纳我的推荐 |
|---|---|---|---|
| 1 | 学员作品承载形态 | **静态 + 平台数据能力（BaaS）** | ✅ |
| 2 | 作品网址形态 | **路径式** `supermind-ai.cn/vibehub/<username>/<projectname>/` | ❌ 我推荐子域名，被否 |
| 3 | 学员身份 | **邀请码即身份** | ✅ |
| 4 | AI 诊断 | **服务端跑，平台出钱** | ✅ |
| 5 | 默认公开范围 | **全网公开，只展示昵称** | ✅ |
| 6 | VibeLoop 接入 | **分阶段** | ✅ |
| 7 | 首场落地 | **7/29 开营** | — |
| 8 | 后端语言 | **Node** | ✅ |

## 附加要求（决策附言，同样具有约束力）

### A. 关于 BaaS 的形态
> 「能不能部署一个类似 supabase 这样的数据库后台，可以让 AI agent 来操作，另外也可以有一些比较简单和常见的后端部件。尽量用开源项目。」

**处理**：目标形态确认为"可被 AI agent 直接操作的开源数据库后台"。

- **P0（今晚）**：自研最小 BaaS（数据 / 文件 / 计数器），SQLite 承载，先把黄金路径跑通，不引外部依赖。
- **P1（vibeloop 迭代）**：换 **PocketBase** 作为 BaaS 引擎。理由：单个 Go 二进制、SQLite、自带 auth / 文件存储 / 实时订阅 / 管理后台 / 完整 REST API，MIT 协议，常驻内存约几十 MB。AI agent 可通过其 `/api/collections` 管理 API 建表、`/api/collections/:name/records` 读写。
- **不选自托管 Supabase**：其 docker-compose 需要 Postgres + PostgREST + GoTrue + Realtime + Storage + Kong + Studio 等十余个容器，在 2 vCPU / 7.4 GiB 且需同时承载平台与超脑官网的机器上会争抢内存。若将来换更大机器可重新评估。
- **隔离原则不变**：学员的 AI agent **不直接持有 BaaS 管理凭证**，通过 VibeHub 的接口代为建表与读写，VibeHub 负责按项目做命名空间隔离与配额。

### B. 关于项目预估
> 「不要用传统的项目预估周期，因为现在 AI 做项目都是小时级的」

**处理**：所有排期以小时为单位，不写"人天/人周"。分期表（P0/P1/P2）保留，但只表示**依赖顺序**，不表示时长。

### C. 关于交付节奏
> 「今天晚上本地先做出第一版，然后明天就可以马上部署到 vibeloop 上去迭代了。我本地不去改 bug 或者做任何修订。」

**处理**：
- 今晚目标 = **黄金路径可跑通的第一版**，不是完备产品。
- Michael **不在本地改 bug**。因此本地版本只需要"能跑起来给他看"，缺陷在 vibeloop 闭环里迭代。
- 这反过来提高了明天接 vibeloop 的优先级：**〔决策 6〕的"分阶段"里的第二阶段被提前到 7/25**，而不是等第一场营结束。

## 因决策 2（路径式）产生的架构修订

### 修订 1：控制台必须换到另一个 origin ⚠️

路径式意味着学员作品和平台如果同在 `supermind-ai.cn`，就是**同源**——学员作品里的 JS 可以直接 `document.cookie` 读到老师的登录态。这是真实的安全洞，不是理论风险。

**修订**：
| 用途 | 地址 |
|---|---|
| 学员作品（正式版） | `supermind-ai.cn/vibehub/<username>/<projectname>/` ← 按 Michael 要求保留 |
| 版本预览 | `<pid16>.preview.supermind-ai.cn/vibehub/_preview/<pid16>/` ← 每个待审版本独立 origin |
| **平台控制台 + API** | **`hub.supermind-ai.cn`** ← 换 origin |

平台 cookie 必须 **host-only**（不设 `Domain`），否则仍会下发到 `supermind-ai.cn`。

### 修订 2：正式作品用普通证书，预览必须使用通配证书

正式作品仍是路径式，`supermind-ai.cn` + `hub.supermind-ai.cn` 可以使用普通证书。安全复核确认：若所有未审核预览仍在主域下，只靠 path cookie 不能阻止恶意预览读取浏览器已授权的另一个预览。因此预览改为逐 `preview_id` 独立 origin，需要 `*.preview.supermind-ai.cn` 泛解析和通配证书；通配证书通常需要 DNS-01。DNS、证书和 Nginx 上线属于外部运维前置条件，不能仅凭仓库配置视为已经完成。

**仍需开 443**——HTTPS 依然是功能前提（录音 `getUserMedia`、定位只在安全上下文可用）。这一条不因 URL 方案改变。

### 修订 3：部署管道必须处理绝对路径

作品跑在子目录下，AI 生成的 `/style.css`、`/assets/x.png` 这类绝对路径会 404。

**解包时自动处理**：
1. 向所有 HTML 注入 `<base href="/vibehub/<username>/<projectname>/">`
2. 把 HTML/CSS/JS 中形如 `"/xxx"` 的本地资源引用重写为相对路径
3. 重写记录写入部署日志，学员可见（让他知道平台动了什么）

### 修订 4：作品间的存储隔离

所有**正式作品**共享 `supermind-ai.cn` 这一个 origin，`localStorage` / `sessionStorage` / cookie 会互相串。未审核预览已改为逐 `preview_id` 独立 origin，不再共享预览 cookie 或浏览器存储。

**处理**：平台注入的 SDK 提供 `vibehub.storage`，自动以 `vh:<project_id>:` 前缀命名空间；文档里明确告诉学员的 AI 用它而不是裸 `localStorage`。**这只能缓解正式作品间的串扰，不能根治**——同源下学员仍可绕过。正式作品若也需要强隔离，仍须另行决策并迁移到逐作品 origin。

## 待办：mermaid 图渲染失败

Michael 反馈架构图报 `syntax error (mermaid 11.15.0)`。原因是节点标签里用了 `<br/>` 与括号的组合。下一轮重出时改用简单标签，并在本地先验证渲染。
