---
title: VibeHub 架构设计
date: 2026-07-25
status: draft
audience: tech
---

# VibeHub 架构设计

> ⚠️ **同步提示**：正式作品按 `decisions-r1.md` 保留路径式；安全复核后，未审核预览单独改为逐 `preview_id` 子域。两者不要混为一套域名策略。

> 本文回答需求文档 §15「当前文档暂不定义」的那七件事——它们恰好是能不能开营的关键。
>
> **前置假设**：本文按第 1 轮决策的**已拍板选项**书写（静态 + 平台数据能力 / 路径式网址 + `hub` 独立控制台 origin / 邀请码即身份 / 服务端诊断 / 昵称公开 / 分阶段接 VibeLoop / Node）。凡是依赖决策的地方都用 `〔决策 N〕` 标注，决策改变时只需改动这些段落。
>
> 配套阅读：[领域模型与状态机](domain-model.md) · [基础设施事实](../research/infra-facts.md) · [存量资产盘点](../research/codebase/existing-assets.md)

---

## 1. 系统总览

```
┌─ 学员的电脑 ────────────────────┐
│  AI 工具（Claude Code/Codex/    │
│  WorkBuddy）                    │
│      └─ vibehub skill           │  绑定 · 打包 · 提交
└──────────────┬──────────────────┘
               │ HTTPS + Bearer token
┌──────────────▼─────────────────────────────────────────┐
│  南京机（supermind-ai.cn 已备案）                        │
│                                                         │
│  nginx ─┬─ supermind-ai.cn/vibehub/<user>/<project>/      │
│         │                         学员作品（静态，正式版）│
│         ├─ <pid>.preview.supermind-ai.cn/vibehub/...     │
│         │      独立 origin 版本预览（Node 校验短期 claim）│
│         └─ hub.supermind-ai.cn   控制台 + API（独立 origin）│
│                                                         │
│  VibeHub 服务                                           │
│    ├─ 提交接收 → 校验 → 解包 → 版本落盘                  │
│    ├─ 部署切换（symlink 原子替换）                       │
│    ├─ 审核状态机                                        │
│    ├─ 诊断流水线（串行队列）                             │
│    └─ 作品运行时数据能力（KV / 文件 / AI）〔决策 1〕      │
│                                                         │
│  数据：SQLite(WAL) + 版本快照目录 + COS 对象存储         │
└─────────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
  umami 统计                    模型网关（复用营地中台）
  statistics.superbrain-ai.com   国产模型 + 安全过滤 + 配额
```

**进程数：一个。** VibeHub 服务是单个 Node 进程（pm2 托管），诊断流水线是它内部的一个串行队列，不额外起服务。2 核机器上不需要也不应该拆微服务。

---

## 2. 学员作品的承载形态 〔决策 1〕

### 2.1 采用方案：静态站 + 平台数据能力

学员的产物是**纯静态文件**（HTML/CSS/JS/图片）。需要存数据时，不写后端，而是调用平台提供的一组带项目作用域的接口。

平台在每个作品页自动注入一个 SDK（生产路径为 `/vibehub/_sdk/vibehub.js`）：

```javascript
// 学员的 AI 只需要写这样的代码
await vibehub.save('sounds', { title: '早高峰的路口', lat: 31.2, lng: 121.4 });
const list = await vibehub.list('sounds', { limit: 20 });
const url  = await vibehub.upload(fileBlob);          // 返回可直接用的公开 URL
const text = await vibehub.ai('把这段描述润色一下：' + input); // 【规划中，当前未实现】
```

对应三组已实现能力和一组规划能力。正式作品的项目身份来源是固定正式 origin + URL 路径；预览版必须由逐 preview origin 与 path 中相同的 `preview_id` 共同确认。服务端不得把客户端自报的 header 或 project id 当作授权依据（见 §2.1b）：

| 能力 | 接口 | 配额（每项目） |
|---|---|---|
| 结构化数据 | `POST/GET/DELETE /baas/v1/:collection` | 10 万条 · 单条 64 KB |
| 文件上传 | `POST /baas/v1/files` | 500 MB 总量 · 单文件 20 MB |
| AI 调用 | `POST /baas/v1/ai` | 【规划中，当前未实现】每日 200 次，走模型网关（含安全过滤） |
| 计数器 | `POST /baas/v1/counter/:key` | 无限 |

**为什么是这四个**：从原型里六个作品倒推——城市声音地图（文件+数据+位置）、情绪天气站（数据+时序）、无障碍菜单（数据+AI 朗读文本）、专注岛（计数器）、记忆拼图（文件+数据）、光合日记（数据）。**四个能力覆盖全部六个作品**，没有一个需要自定义后端。

### 2.1b 作品里没有秘密（重要）

作品是**公开的静态网页**，任何人都能查看它的源代码。因此：

> **浏览器里的「项目标识」只能是可公开的路由标识，不能当成密钥。** 任何写进静态产物的东西都等于公开。

真正的保护来自服务端，而不是"把 key 藏在前端"：
- 正式项目身份来自 `supermind-ai.cn` + `/vibehub/<username>/<project>/`；预览项目身份来自 `<pid>.preview.supermind-ai.cn` + `/vibehub/_preview/<pid>/`，host/path 必须一致。服务端忽略客户端自报的 project header，只把经过 origin/path 校验的 `Referer` 当公开路由线索
- 每项目的配额、限流、单条大小、内容过滤全在服务端强制
- 上游模型 API key **永不下发**，AI 调用一律经平台网关中转
- 需要"只有作者能写"的作品，走**服务端签发的短期会话**，而不是硬编码 token

> **同源威胁模型（路径式正式作品的关键代价）**：一句话：**正式作品之间共享同一 origin，SDK 命名空间不是安全边界。** 正式作品和主站路径共享 `https://supermind-ai.cn`，其 `localStorage`、`IndexedDB` 和浏览器权限也是共享的。未审核预览不再加入这个执行面：每个 `preview_id` 使用不同 origin、host-only cookie 与 `Cross-Origin-Resource-Policy: same-origin`，Node 还拒绝其他预览 origin 的请求。`hub.supermind-ai.cn` 则把控制台登录态移出所有作品执行面。

> BaaS 的默认策略是"公开可读、限流可写"——营地场景下作品需要访客能留言/上传，做强鉴权反而做不出想要的作品。代价是数据可能被恶意写入，缓解手段是配额 + 内容过滤 + 老师可一键清空某个 collection。**这条取舍需要第 2 轮跟 Michael 确认**（见 api.md §5）。

### 2.1c BaaS 是 P0 还是 P1

Codex 的独立方案主张 **P0 只发静态站，BaaS 放 P1**，以缩小首期攻击面与工作量。这个分歧的裁决条件很清晰：

> **首场营的作品是否强依赖"运行时上传/存数据/调 AI"？**

- 若第一场是「城市声音地图」这类要录音要存数据的作品 → **BaaS 是 P0 阻塞项**，没有它开不了营
- 若第一场作品以展示型网页为主 → BaaS 可以推到 P1，P0 只做静态发布链路

这个问题挂在〔决策 7〕（首场落地场次）上，Michael 回答后即可确定。**在得到答案前，工程上按"BaaS 接口先定契约、实现排在静态链路之后"推进**，两种结论都不返工。

### 2.2 为什么不做学员自己的后端

在 2 vCPU / 7.4 GiB 的机器上，每个常驻 Node 进程占 40–80 MB，扣除系统与平台自身，理论上限只有几十个，且 2 核无法调度几十个进程的并发。**更根本的问题是**：学员代码是 AI 生成、没人逐行审过的不可信代码，让它作为进程在我们机器上执行，等于开放任意代码执行。

保留升级路径：`versions` / `reviews` / `deployments` 这套骨架与承载形态无关，将来真要开放后端，只是多一条部署路径，已有数据不受影响。

### 2.3 这个选择如何满足「服务端诊断」

需求文档要求诊断能回答「服务端是否存在、必要的数据接口是否已经连接」。在本方案下，这**不再是猜测而是服务端台账**：某个项目调用了哪些 BaaS 接口、成功多少次、失败多少次、数据有没有真的写进去，全都是可查询的事实。这比读学员代码去猜要可靠得多。

---

## 3. URL 与证书 〔决策 2〕

### 3.1 域名布局

| 用途 | 域名 | 说明 |
|---|---|---|
| 学员作品正式版 | `https://supermind-ai.cn/vibehub/<username>/<projectname>/` | 主域路径式地址 |
| 版本预览 | `https://<pid16>.preview.supermind-ai.cn/vibehub/_preview/<pid16>/` | 每个版本独立 origin；Node 用 10 分钟 HMAC claim 换 host-only 路径 cookie，303 清除 query，带 `X-Robots-Tag: noindex` |
| 平台控制台 + API | `https://hub.supermind-ai.cn` | 学员看板、老师审核台和 `/api/*`；与作品不同 origin |
| 课程集合页 | `hub.supermind-ai.cn/c/<camp-slug>` | 控制台内页面；公开数据接口仍为 `/api/public/*` |

**为什么控制台要放在 `hub`**：路径式正式作品与主站同源，作品 JavaScript 不能读取 `hub` 的 host-only cookie。未审核预览另用逐版本子域，防止恶意待审作品读取另一个已授权预览。

### 3.2 证书

正式路径和控制台使用 `supermind-ai.cn`（可包含 `www`）与 `hub.supermind-ai.cn` 的普通 HTTPS 证书。预览还需要 `*.preview.supermind-ai.cn` 泛解析和通配证书；通配证书通常通过 **DNS-01** 签发。另需腾讯云防火墙放行 443。这些都是生产启用独立预览 origin 的上线前置条件。

> **HTTPS 不是可选项。** 原型里的「城市声音地图」要录音——`getUserMedia` 只在安全上下文（HTTPS）下可用。地理位置、剪贴板等 API 同理。没有 HTTPS，一半的作品做不出来。这一条把 §3.2 从"运维待办"提升为"P0 阻塞项"。

### 3.3 nginx 路由骨架

```nginx
# 主域：官网 + 路径式作品
server {
  listen 443 ssl http2;
  server_name supermind-ai.cn www.supermind-ai.cn;
  location ~ ^/vibehub/(?<user>[a-z0-9][a-z0-9_-]*)/(?<project>[a-z0-9][a-z0-9_-]*)(?<rest>/.*)?$ {
    alias /var/lib/vibehub/sites/$user/$project;
    try_files $rest $rest/index.html /index.html =404;
  }
  location ~ "^/vibehub/_preview/[a-z0-9]{16}(/.*)?$" { return 404; }
  location /baas/ { proxy_pass http://127.0.0.1:4300; }
}

# 未审核预览：逐 preview_id 独立 origin
server {
  listen 443 ssl http2;
  server_name "~^(?<pid>[a-z0-9]{16})\.preview\.supermind-ai\.cn$";
  access_log off;
  error_log /dev/null crit;
  location ~ "^/vibehub/_preview/[a-z0-9]{16}(/.*)?$" {
    proxy_pass http://127.0.0.1:4300;
    proxy_set_header Host $host;
  }
  location / { return 404; }
}

# 控制台 + API（独立 origin）
server {
  listen 443 ssl http2;
  server_name hub.supermind-ai.cn;
  location /api/ { proxy_pass http://127.0.0.1:4300; }
  location / { try_files $uri $uri/ /index.html; }
}
```

生产配置还将 `/vibehub/_sdk/` 和 `/vibehub/_hit` 回源到 Node。正式作品静态文件仍由 nginx 直接读取；**未审核预览是唯一例外**，只允许从逐 preview 子域回源 Node，主域预览路径固定返回 404。预览虚拟主机关闭 access log 与可能记录请求行的 error log；应用日志也只记录 path、不记录 query。BaaS 清空外部 `x-vibehub-project`，服务端从校验后的 `Referer` origin + path 解析项目。

`try_files ... /index.html` 让学员写的前端路由（AI 很爱生成 SPA 路由）不会 404。

---

## 4. 部署管道（新写的核心之一）

### 4.1 目录布局

```
/var/lib/vibehub/
├── db.sqlite                      # 主库（WAL）
├── versions/v_<id>/               # 版本快照，不可变
├── sites/<username>/<project> -> versions/v_<id>/     # 正式版软链，直接指向版本目录
├── previews/<pid16>   -> ../versions/v_<id>/          # 预览软链
├── uploads/<project_id>/          # BaaS 文件（也可直传 COS）
├── runtime/sdk.js                 # 注入作品页的 SDK
└── tmp/                           # 上传暂存，定时清理
```

### 4.2 提交流程

```
① skill 本地打包
   ├─ 若有 package.json 且有 build 脚本 → 本地 npm run build，只打包产物目录
   ├─ 否则打包当前目录
   ├─ 排除：node_modules .git .env *.log 及 .vibehubignore 指定项
   └─ tar.gz，硬上限 30 MB

② POST /api/skill/versions/preflight { sha256, size, file_count }
   ← { duplicate: true, version_id } 时直接返回，不重复上传（抄超脑上传平台的 preflight）

③ POST /api/skill/versions  (multipart)
   服务端按顺序做：
   ├─ 校验 token scope → 定位 camp/project
   ├─ 落 tmp/，校验 sha256 与声明大小一致
   ├─ 安全解包（见 §4.3）
   ├─ 内容校验：必须存在 index.html；否则 400 并给出人话提示
   ├─ 写入 versions/v_<id>/，seq = 项目内自增
   ├─ 建预览软链 previews/<pid16>，创建 deployment(target=preview)
   ├─ 入队诊断任务
   └─ 返回 { version_id, preview_url }

④ 诊断完成 → 自动创建 review(status=pending)
   （部署失败则不创建——老师不该看到打不开的版本）

⑤ 老师审核通过 → 事务更新 + 原子切换软链（见 domain-model §2.6）
```

### 4.3 安全解包（不可省略）

学员上传的压缩包是不可信输入。解包器必须拒绝：

| 风险 | 拒绝规则 |
|---|---|
| 路径穿越 | 任何含 `..` 或以 `/` 开头的条目 |
| 符号链接逃逸 | 任何 symlink / hardlink 条目 |
| 压缩炸弹 | 解压后总大小 > 200 MB，或压缩比 > 100:1 |
| 文件数炸弹 | 条目数 > 5000 |
| 单文件过大 | 单个文件 > 20 MB |
| 可执行文件 | `.sh .exe .so .dylib` 及带执行位的文件（静态站不需要） |

解包到临时目录后再 `rename` 进 `versions/`，保证 `versions/v_<id>/` 要么完整要么不存在。

### 4.4 版本保留策略与磁盘容量

79 GB 磁盘不是无限的，而学员会频繁提交。**每个项目在磁盘上最多保留 3 份可运行产物**：

| 保留 | 说明 |
|---|---|
| 当前正式版 | 访客正在访问，必须留 |
| 上一正式版 | 回滚用，必须留 |
| 当前待审版 | 老师要预览，必须留 |

其余历史版本**只保留元数据 + 内容哈希**，产物打包进对象存储（COS）冷存，需要时可回捞。

容量测算：
```
单份产物上限 20 MiB（图片/音视频走文件服务，不进站点包）
300 个项目 × 3 份 × 20 MiB ≈ 18 GiB
+ 临时解包与回滚余量 30%    ≈ 24 GiB      → 79 GB 磁盘可容纳
```

配套必须有：**每项目磁盘配额**、**定时清理任务**（清 `tmp/` 与超出保留数的产物）、**磁盘使用率告警**（80% 报警）。

> 这三条不是"以后再说"——一台机器被学员的图片塞满，整个平台连同超脑官网一起挂掉。

---

## 5. AI 诊断流水线（新写的核心之二）

需求文档 §9.1.3 的硬要求：**整体完成度必须能被下方诊断项解释，不能是装饰性分数。** 这一条排除了「把代码丢给大模型打分」的做法——大模型给的分数解释不了。

因此把诊断拆成三段，**分数由程序算，模型只负责翻译成人话**。

### 5.1 第一段：确定性事实采集（不花钱）

**静态扫描**（对 `versions/v_<id>/`）：
- 文件树、总大小、页面数（`*.html`）
- **本地引用完整性**：解析 HTML/CSS 中引用的 `src`/`href`，检查被引用的本地文件是否都在包里 —— 这是「打开是白页」最常见的根因
- JS 中的 `fetch` / `XMLHttpRequest` 目标；是否引用 `vibehub` SDK 及调用了哪些方法
- 占位物检测：`TODO` / `Lorem ipsum` / `示例文本` / 空 `href="#"`

**动态探测**（无头 Chromium 打开预览 URL，超时 15 秒）：
- console error / warning 的条数与内容
- 失败的网络请求（4xx/5xx）及其 URL
- 首屏可见内容量（`document.body.innerText.length`、渲染出的非空节点数）
- 可交互元素统计（button / a / form / input 数量）
- **整页截图** —— 直接用作学员看板的「现在的项目长这样」和管理端队列的预览缩略图

**运行时台账**（查服务端日志）：
- 该项目最近调用了哪些 BaaS 接口、成功/失败次数、是否真的写入过数据

> 2 vCPU 上无头浏览器需**串行排队**，单次约 5–10 秒。高峰期（一个班同时提交）会排队，因此提交接口立即返回，诊断异步完成，界面显示「诊断更新中」并保留上次结果——这正是需求文档 §9.1.5 的要求。

### 5.2 第二段：确定性评分（可解释）

评分由一份**诊断 policy** 定义，每个检查项是一条 `diagnostic_item`：

```jsonc
{
  "check_key": "preview_reachable",
  "applicability": "applicable",     // applicable | not_applicable
  "earned_points": 20, "max_points": 20,
  "result": "pass",                  // pass | fail | unknown
  "evidence_level": "verified",      // verified | client_reported | ai_inferred | human_required
  "evidence": { "http_status": 200, "checked_at": "..." },
  "is_blocker": false
}
```

**公式固定，且只有适用项进分母**：

```
health_percent = round(100 × Σ applicable.earned_points / Σ applicable.max_points)
```

五条硬规则：

1. **不适用的项不进分母，不算 0 分。** 一个纯展示型作品（比如「光合日记」）本来就不需要服务端，「服务端连接」维度应显示「不适用」而不是永远 0 分——否则做得再好也只能拿 70%，学员会觉得系统在骗他。*（这条是我原设计的缺陷，采纳 Codex 方案修正。）*
2. **适用但没证据的项记 `unknown`、得 0 分、显示「未验证」**，不允许模型猜测补分。
3. **页面逐项显示 `earned/max` 和证据**，用户可以自己把总分加一遍——这才叫"能被诊断项解释"。
4. **`is_blocker` 独立于分数**，不偷偷封顶。有阻塞问题时显示「81%，存在阻塞问题，不能据此判断可发布」，而不是把 81 硬改成 59。
5. **policy 一旦用于生成报告就不可原地修改**；调整权重必须新建 `policy_version`，否则历史报告不可复算。

示例（对应原型里的 86%）：

| 检查维度 | 得分 | 证据 |
|---|---:|---|
| 产物与入口完整 | 20/20 | 服务端重算哈希，index.html 存在 |
| 预览可访问 | 20/20 | HTTP 200，引用资源全部可取 |
| 核心用户路径 | 15/30 | 1 条已验证，1 条客户端报告，1 条未验证 |
| 平台数据能力 | 16/20 | 数据接口正常，文件上传未验证 |
| 配置与安全基线 | 10/10 | 未发现密钥，解包检查通过 |
| **合计** | **81/100** | |

### 5.2b 证据分级（需求文档 §14.6 硬要求）

> 「区分『已经验证』『AI 推断』和『仍需人工确认』。」

每条结论必须带 `evidence_level`，界面用不同标记呈现：

| 级别 | 含义 | 界面 |
|---|---|---|
| `verified` | 服务端亲自验证过（HTTP 状态、哈希、解包检查） | ✓ 已验证 |
| `client_reported` | 学员本机 skill 上报（构建退出码、本地测试结果） | ◑ 本机上报 |
| `ai_inferred` | 模型从代码推断 | ○ AI 推断 |
| `human_required` | 只能人工确认 | ⚠ 需人工确认 |

**客户端上报的结果不得标为「已验证」**——学员的 AI 完全可以生成一份漂亮的报告，老师必须知道每条结论的证据强度。

「核心操作路径」由学员在 skill 里声明（`vibehub deploy --flows "上传声音,查看地图"`）。P0 只做前两个维度，核心路径维度标为 `unknown` 并显示「未验证」，P1 再补。

### 5.3 第三段：模型翻译（花钱，但很便宜）

输入 = 第一段的事实 JSON + 第二段的分数表
输出 = 结构化 JSON：`{ summary, dimensions[].verdict, next_steps[1..3] }`

**关键约束写进 prompt**：分数已经算好并作为输入给出，模型**不得修改分数**，只负责把技术事实翻译成产品语言，并按优先级给 1–3 条下一步建议。

**Schema 强制**：模型输出必须通过 JSON Schema 校验，且**每条结论必须引用至少一个 `check_key`**。它不能修改 points、blocker 或 evidence_level。引用不上的结论直接判为无效并重试一次，仍失败则退回模板文案。

**源码正文默认不整包发给模型**——先用确定性工具提取短证据、相关片段和错误信息，发送前剥掉密钥、个人信息和本机绝对路径。这既省钱，也避免学员代码里的文本被当成指令（prompt 注入）。

模型走 ai-game-camp-platform 已有的网关（国产模型别名 + 未成年人安全过滤 + 按学员配额 + 用量计量，**已实现并有测试**，见存量资产盘点）。

**成本估算**（容量预算，非选型承诺）：
- 每份报告约 6k 输入 token（脱敏证据，非全量代码）+ 1k 输出 token
- 按腾讯云 TokenHub 2026-07-16 公布的 Hy3 价格（输入 1 元/百万、输出 4 元/百万）：单份约 `0.006 + 0.004 = 0.01 元`
  来源：https://cloud.tencent.com/document/product/1823/130055
- 一场营（100–300 个作品 × 平均 5 个版本 = 500–1500 份）约 **5–15 元**，不含重试与网关附加费

> 价格会变。生产环境必须记录每次实际的 input/output token 数、模型别名与当时单价，切换模型前用真实样本评估解释质量。
>
> 兜底：**每项目每天限 20 次结论生成**，超出只更新事实与分数、不调模型，成本天花板因此锁死。

### 5.3b 关于「服务端要不要跑无头浏览器」的分歧

Codex 的独立方案主张 **P0 服务端完全不执行学员的任何 JavaScript**，把浏览器功能检查推到 P1 的独立 runner。理由是生产机同时持有平台数据库、SSH 与云密钥，不该让不可信代码在同一爆炸半径内运行。

**我的判断是 P0 保留无头浏览器检查**，理由：
1. 「页面能不能打开、首屏有没有内容」是学员最常翻车的地方，也是老师审核前最想知道的事。没有这一项，诊断的可信度会大幅下降。
2. 它同时产出**整页截图**——学员看板的「现在的项目长这样」和审核队列的预览缩略图都靠它。没有它这两处只能放 iframe，移动端体验差很多。
3. 这不等于「执行学员的构建脚本」。构建在学员本机完成，服务端只是**用浏览器打开一个已经公开可访问的静态页面**，与任意访客做的事一样。

但 Codex 的顾虑是对的，所以必须配套硬缓解：

| 措施 | 说明 |
|---|---|
| 独立低权限用户运行 | 不与 VibeHub 服务同用户，无 DB、无 SSH key、无云凭证的读权限 |
| 不禁用 Chromium 沙箱 | **绝不使用 `--no-sandbox`** |
| 硬超时 15 秒 + 内存上限 | 防死循环与内存炸弹 |
| 网络出口限制 | 只允许访问预览域名本身；**禁止访问内网段与云元数据地址（169.254.169.254）** |
| 串行队列 | 2 核机器上并发只会互相拖垮 |
| 失败降级 | 浏览器检查失败时该维度记 `unknown`，不阻塞提交与审核 |

> 若压测发现资源占用超预期，或安全评估认为风险不可接受，退路是采纳 Codex 方案：把这一步移到独立 runner。届时只需改诊断流水线的一个执行器，评分模型与报告结构不变。

### 5.4 版本绑定与陈旧防护

- 每份诊断报告**强制关联 version_id**（表结构已约束）
- 界面必须显示「本次诊断对应 v1.2.0，生成于 10:41」
- 新诊断未完成时，展示上次结果 + 「诊断更新中」标记
- 诊断结论**不自动改变审核状态**（需求文档 §12.5），只作为老师参考

### 5.5 诊断边界（写进界面）

需求文档 §9.1.6 要求明示边界。界面底部固定一行小字：
> AI 诊断是辅助判断，不等同于安全审计或最终审核。涉及隐私、安全、付费的功能需要人工检查。老师拥有最终发布决定权。

---

## 6. Skill 连接协议（新写的核心之三）

### 6.1 分发形态

一个仓库同时满足三家 AI 工具：
```
vibehub-skill/
├── SKILL.md          # 三家 Agent 共用的提示词与操作流程
├── AGENTS.md         # 兼容读取 AGENTS.md 的工具
├── agents/openai.yaml
├── bin/install.mjs   # 跨平台安装器
├── bin/vibehub       # Node CLI，零第三方运行时依赖
└── lib/platform.mjs  # macOS / Windows 系统命令差异
```
学生侧安装：macOS 与 Windows 共用 `/install` 页面提供的一条命令。npm 包完成发布并验证可下载后，构建前通过 `VITE_SKILL_INSTALL_COMMAND` 开放复制按钮；未配置时页面明确显示“即将开放”，不会向学生提供失效命令。安装器把同一份 Skill 分别放到 Codex、Claude Code 与 WorkBuddy 的个人 Skill 目录；可用 `--targets` 只安装指定工具，其他兼容 `SKILL.md` 的 Agent 可用 `--dir` 指定完整目录。更新时先在目标同级暂存完整新版本并验证文件，再把原目录移到 `~/.vibehub/skill-backups/` 下的时间戳备份，最后原子换入新目录；失败时恢复原目录并清理暂存目录。备份不留在 Agent 的 Skill 扫描目录里。超脑 SkillHub 作为内部镜像和版本管理入口，不作为 Windows 学生的唯一安装方式。

### 6.2 握手时序

```
学员                    skill                    平台
 │  "我要接入 VibeHub"    │                        │
 ├───────────────────────▶│                        │
 │  ← 请输入邀请码         │                        │
 ├──── SUMMER-7K3P ──────▶│                        │
 │                        ├─ POST /api/skill/bind ▶│
 │                        │   {code, device_name}  │ 校验 code 状态、
 │                        │                        │ 未超 max_devices
 │                        │◀── {token, project,   ─┤ 绑定 user↔project
 │                        │     camp, endpoints}   │ code.status=bound
 │                        ├─ 合并写入 ~/.vibehub/credentials.json
 │◀── "已连接到《AI 产品共创课》，你的作品：城市声音地图"
```

### 6.3 命令集

| 命令 | 作用 |
|---|---|
| `vibehub bind <邀请码>` | 绑定身份与项目 |
| `vibehub camps` | 列出已经连接的营地与唯一连接标识 |
| `vibehub use <连接标识>` | 切换接下来查询、预览和部署所使用的营地/作品 |
| `vibehub status` | 当前版本 / 审核状态 / 无凭证预览定位地址 / 诊断摘要；不签发或打印 claim |
| `vibehub deploy [--summary "..."]` | 打包 → 提交 → 显示无凭证预览定位地址；不打印返回体中的 claim |
| `vibehub open` | 为待审版本换取短期 claim 并直接交给浏览器；终端不回显 claim。无待审版时打开正式作品 |
| `vibehub logs` | 最近几次提交与审核反馈（含驳回原因） |

### 6.4 凭证设计

- **不透明随机串，不用 JWT** —— 必须支持即时吊销（老师撤销邀请码 → token 立刻失效）
- 存 DB：`token_hash`（只存哈希）、`scope{camp_id, project_id, role}`、`device_name`、`last_used_at`、`expires_at`
- **服务端一切鉴权只认 token 里的 scope**，绝不接受客户端自报的 camp/project 参数（超脑上传平台 ADR-002 的血泪教训）
- 本地存 `~/.vibehub/credentials.json`。一个文件保存多个营地连接和当前连接；macOS/Linux 使用 0600，Windows 依赖用户目录 ACL
- 邀请码撤销 → 级联吊销该码签发的全部 token

---

## 7. 前端架构

### 7.1 技术栈

沿用乐乐老师原型的技术选择：**React 18 + Vite + TypeScript**。

- 路由：`react-router`，三个 shell —— `/app/*`（学员）、`/admin/*`（老师）、`/c/:camp`（公开集合页）
- 服务端状态：TanStack Query（轮询审核状态、诊断进度天然适配）
- 本地状态：`useState` / `useReducer`，**不引 Redux**
- 样式：CSS Modules + 从原型提取的 CSS 变量
- 二维码：`qrcode` 前端生成，不走服务端

### 7.2 不引入 UI 组件库（重要）

原型是**手写 CSS**，风格克制：暖色浅底、细描边、低阴影、大量留白。引入 antd / MUI 会立刻毁掉这个质感，而且它们的默认圆角、阴影、主色都与这套 token 冲突。

设计系统直接固化原型提取的变量：

```css
:root {
  --canvas:#f8f5ef;  --surface:#fbf9f5;  --surface-soft:#f4f0e9;
  --ink:#242321;     --ink-soft:#73716d;
  --line:#ded9d0;    --line-strong:#d2ccc2;
  --coral:#ed624a;   --coral-deep:#da4d38;  --coral-soft:#fff0ea;
  --blue:#3978bd;    --amber:#e99a15;       --success:#4c8561;
  --font: "PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
}
```

**颜色语义（需求文档 §9.1.4，必须遵守）**：绿=已可用 · 蓝=正在完善/已连接 · 琥珀=需要关注 · 珊瑚红=仅用于高优先级问题或关键数字。

### 7.3 Block 组件模型

需求文档 §14.5 要求「每个 Block 只回答一个清晰问题」。实现为一个统一容器：

```tsx
<Block eyebrow="当前界面现状" title="开发完成度" badge={<Score value={86}/>}>
  ...
</Block>
```

对应原型的信息层级：眉题（这是什么）→ 主标题（回答什么问题）→ 右上角状态 → 主体 → 底部综合结论。

P0 需要的 Block：项目概览 / AI 产品诊断 / 版本对照 / 部署状态 / 审核状态 / 正式网址+二维码 / 浏览量 / 最近记录。

### 7.4 角色与页面

| 角色 | 页面 | 对应原型 |
|---|---|---|
| 学员 | 我的项目看板 | `#student` ✅ 已有 |
| 学员 | 提交记录 | 侧边栏有入口，原型未实现 |
| 老师 | 审核队列 | `#admin` ✅ 已有 |
| 老师 | 课程总览（人数/进度/卡住的人） | 侧边栏有入口，原型未实现 |
| 老师 | 项目列表 | 侧边栏有入口，原型未实现 |
| 老师 | 邀请码管理 | 原型没有，**需求文档 §7.2 要求，必做** |
| 访客 | 作品集合页 | `#collection` ✅ 已有 |

**原型已实现 3 个页面，还需新增 4 个。** 老师端的「课程总览」是需求文档 §7.7 明确要求的（要能看出谁没开始、谁卡住了），P0 不能省。

---

## 8. 安全边界与威胁模型

**前提**：学员的代码是 AI 生成、没有人逐行审查过的。默认它不可信。

| 威胁 | 缓解 |
|---|---|
| 作品 JS 窃取平台登录凭证 | 平台控制台迁到 `hub.supermind-ai.cn`，cookie 设为 **host-only**（不设 `Domain`）+ `SameSite=Lax`；作品拿不到 `hub` 的 cookie。正式作品之间仍共享 origin；未审核预览则逐 `preview_id` 隔离 origin |
| 恶意预览跨路径读取另一个已授权预览 | 每个 `preview_id` 使用独立 origin 与 host-only cookie；Node 校验 host/path、拒绝其他 preview origin，并发送 `Cross-Origin-Resource-Policy: same-origin` |
| 作品伪造项目身份访问 BaaS | 忽略客户端 project header；正式作品要求正式 origin + 路径，预览要求独立 origin 与 path 的 `preview_id` 一致。公开 BaaS 本身仍不把路由标识当秘密 |
| 作品页把平台控制台嵌进 iframe 钓鱼 | 控制台响应加 `X-Frame-Options: DENY`；作品页 CSP 限定 `frame-ancestors` |
| 压缩包路径穿越 / 炸弹 | §4.3 解包规则 |
| BaaS 接口被刷 | 按项目配额 + 令牌桶限流 + 单条大小限制 |
| 作品内容违规 | **发布前人工审核**（产品设计已强制）；AI 调用走网关的安全过滤；可选自动内容扫描 |
| 未审核预览泄露或被搜索引擎收录 | 16 位 id 只负责定位；10 分钟 HMAC claim 绑定版本/项目/身份/签发 token，只用于在独立 preview origin 换 host-only 路径 HttpOnly cookie 并 303 清 URL；每次文件请求重查 token、课程成员和待审状态；匿名与越权返回 404，另加 `X-Robots-Tag: noindex` |
| 平台被作品拖垮 | 正式作品由 nginx 直接 serve；仅低频的未审核预览经过 Node 做授权后读取静态文件 |
| 邀请码泄露被冒用 | 码绑定后状态变更；限制 `max_devices`；老师可即时撤销并级联吊销 token |

**合规责任**：作品挂在已备案的 `supermind-ai.cn` 下，内容责任落在备案主体上。产品设计里「发布前必须老师审核」正是这条责任的技术落实，不能为了效率去掉。若涉及未成年人，默认可见性设为昵称公开（〔决策 5〕）。

---

## 9. 分期路线

### P0 —— 不做就开不了营

**验收标准（端到端黄金路径，必须一次跑通）**：
> 老师建课程 → 生成 10 个邀请码 → 学员在 Claude Code 里 `vibehub bind` → 写一个能录音并保存的网页 → `vibehub deploy` → 拿到预览地址 → 老师在审核队列看到它、点开预览、审核通过 → 学员拿到 `https://supermind-ai.cn/vibehub/<username>/<projectname>/` 和二维码 → 手机扫码能打开 → 作品出现在课程集合页

| # | 事项 | 说明 |
|---|---|---|
| 1 | **开 443 + 正式/控制台普通证书 + 预览泛解析与通配证书** | 阻塞项；预览独立 origin 依赖 `*.preview.supermind-ai.cn`，通配证书通常需 DNS-01 |
| 2 | 数据层 + 五维状态机 | 见 domain-model.md |
| 3 | 提交/解包/版本落盘/预览 | §4 |
| 4 | 审核队列 + 原子发布切换 | §4.2 ⑤ |
| 5 | BaaS 四能力 + SDK | §2.1 |
| 6 | vibehub skill（bind/deploy/status） | §6 |
| 7 | 学员看板 + 老师审核台 + 集合页（对接真数据） | §7 |
| 8 | 老师端课程总览 + 邀请码管理 | 原型未覆盖，需求文档要求 |
| 9 | 诊断第一、二段（事实 + 分数）+ 截图 | 第三段可先用模板文案兜底 |

### P1 —— 让它好用

- 诊断第三段（模型翻译）+ 核心功能路径维度
- umami 接入，学员看板显示真实浏览量
- 提交记录页 / 项目列表页
- 项目骨架分发（一键拿到能跑的 starter，抄营地中台的 starter 机制）
- 低风险自动过审规则（只改文案/样式的版本免人工，抄 user-vibeloop 的风险分级）
- 集合页的分类、排序、推荐位管理

### P2 —— 长出新东西

- 学员/访客反馈闭环（把 user-vibeloop 内嵌进产品：作品页报 bug → AI 修 → 老师审）
- 多人团队项目
- 学员身份升级（手机号/微信，支持离营后回访）
- 作品导出（学员带走自己的代码与数据）
- 开放学员后端（需要换机器 + 容器隔离，重新评估）

---

## 10. 待验证清单

| # | 待验证 | 影响 | 验证方式 |
|---|---|---|---|
| 1 | 南京机归属哪个腾讯云账号 | 决定谁能开 443 | 控制台核对 |
| 2 | `hub.supermind-ai.cn` A 记录是否已生效 | 决定控制台独立 origin 是否可用 | `dig` / HTTPS 实测 |
| 3 | `*.preview.supermind-ai.cn` 泛解析与通配证书是否就绪 | 决定独立预览 origin 是否可上线 | `dig`、证书链与 HTTPS 实测 |
| 4 | 备案主体名称与备案号 | 合规存档 | 腾讯云备案控制台 |
| 5 | umami 是否支持按作品动态建 website | 决定浏览量方案 | 读 umami API 文档 + 实测 |
| 6 | 模型网关的实际单次成本 | 诊断成本模型 | 接入后实测回填 |
| 7 | 无头 Chromium 在 2 核机上的实际耗时与内存 | 决定诊断队列并发度 | 部署后压测 |
