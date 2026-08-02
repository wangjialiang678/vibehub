---
title: VibeHub API 契约
date: 2026-07-25
status: draft
audience: tech
---

# API 契约

约定：
- 控制台/API 基址 `https://hub.supermind-ai.cn/api`（BaaS 除外，见 §5）
- 全部 `application/json`（上传除外）
- 时间一律 ISO 8601 UTC 字符串
- 错误体：`{ "error": { "code": "invite_already_bound", "message": "这个邀请码已经被使用了", "hint": "找老师要一个新的" } }`
  - `message` 是**给学员看的人话**，前端可直接展示；`code` 给程序判断
- 分页：`?limit=&cursor=`，返回 `{ items, next_cursor }`

## 0. 鉴权

三种主体，三套凭证：

| 主体 | 凭证 | 载体 |
|---|---|---|
| 网页用户（学员/老师） | 会话 cookie（**host-only、SameSite=Lax、HttpOnly、Secure**） | 浏览器 |
| AI 工具（skill） | `Authorization: Bearer <token>` | `~/.vibehub/credentials.json` |
| 未审核预览 | 10 分钟 HMAC claim（绑定 preview、version、project、用户、课程与签发 token） | grant 返回的单次引导 URL → 预览路径专用 HttpOnly cookie |
| 学员作品运行时 | 由作品 URL 路径映射 project；作品不持有密钥 | SDK 发送路径线索，服务端负责校验 |

**铁律**：服务端一切鉴权只认凭证内嵌的 `scope{camp_id, project_id, role}`，**绝不接受客户端自报的 camp_id / project_id 参数**。请求里出现的 camp/project 参数只用于校验「是否与 scope 一致」，不一致即 403。

### `POST /api/previews/:pid/grant`

网页会话或 skill Bearer token 用该接口换取短期预览地址。只有项目 owner 本人，或项目所在课程的 `teacher` / `admin` 可以签发；匿名、跨项目、跨课程及已经失效的预览统一按不存在处理。

```jsonc
// ← 200
{
  "preview_url": "https://supermind-ai.cn/vibehub/_preview/a1b2c3d4e5f6g7h8/?claim=<短期签名>",
  "expires_at": "2026-08-03T01:20:00.000Z"
}
```

claim 有效期固定为 10 分钟，绑定 `preview_id + version_id + project_id + user_id + camp_id + role + issuer_token_id`。任何携带 query claim 的请求都**只做交换**：Node 校验后设置该预览路径专用、host-only、HttpOnly cookie，再以 `303` 跳转到删除 `claim`、保留其他 query 的同路径；该响应绝不返回或执行作品内容。CSS、JS、图片等后续请求只带 cookie，不再复制 claim 到资源 URL。

Node 在每次预览文件请求时重新检查签发 token 仍未撤销/过期、用户仍是课程成员且角色未变，以及版本仍是该项目当前待审版本。邀请码撤销、成员移除、角色变化、`superseded`、`rejected`、诊断 blocker 清退或正式发布都会让已经换取的 cookie 立即返回 404。响应一律 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`；Node 请求日志与诊断证据会脱敏 claim，nginx 关闭预览路径 access log，避免短期凭证落盘。

---

## 1. Skill 端（AI 工具调用）

### `POST /api/skill/bind`
用邀请码换取长期凭证。**无需鉴权**（这是入口）。

```jsonc
// →
{ "code": "SUMMER-7K3P", "device_name": "Michael 的 MacBook · Claude Code" }
// ←  200
{
  "token": "vhk_...",                 // 只在此处返回一次
  "user":    { "id":"u_..", "display_name":"张路" },
  "camp":    { "id":"c_..", "name":"AI 产品共创课", "slug":"ai-product-2026s" },
  "project": { "id":"p_..", "slug":"voice-map", "title":"城市声音地图" },
  "message": "已连接到《AI 产品共创课》，你的作品：城市声音地图"
}
```
错误：`invite_not_found` · `invite_revoked` · `invite_expired` · `invite_device_limit`（已绑满 `max_devices` 台设备）

### `GET /api/skill/project`
返回当前项目全貌，供 `vibehub status` 输出。

```jsonc
{
  "project": { "id","slug","title","dev_status","publish_status","live_url" },
  "live_version":    { "id","label","seq","submitted_at","preview_url" },
  "pending_version": { "id","label","seq","submitted_at","preview_url" },
  "latest_diagnosis":{ "version_id","status","score","completeness","verified_ratio",
                       "applicable_earned","applicable_max","applicable_items","verified_applicable_items",
                       "summary","next_steps":[..],"finished_at" },
  "last_review":     { "status","comment","decided_at" }   // 驳回原因在这里
}
```

诊断的两个百分比都由服务端确定性检查器从 `items` 复算，模型不得修改：

- `completeness`（完成度）= `applicable_earned / applicable_max`；`score` 是兼容旧客户端的同值字段。
- `verified_ratio`（验证覆盖率）= `verified_applicable_items / applicable_items`；只统计 `evidence_level='verified'` 的适用项。

诊断尚在 `running` 或已经 `failed` 时，以上两个指标及其分子/分母为 `null`，表示检查器还没有可复算的结果，客户端不得展示为 `0%`。

`GET /api/projects/:id` 的 `latest_diagnosis` 和 `GET /api/reviews/:id` 的 `diagnosis` 返回同一组字段。`not_applicable` 项不计入任一分母；未声明的核心路径仍是 `applicable + unknown + human_required`，计入完成度的分母。

### `POST /api/skill/versions/preflight`
避免重复上传。

```jsonc
// →  { "sha256":"...", "size":1048576, "file_count":42 }
// ←  { "duplicate":false }
//    或 { "duplicate":true, "version_id":"v_..", "message":"内容和上一版完全一样，没有需要提交的改动" }
```

### `POST /api/skill/versions`
`multipart/form-data`：`bundle`（tar.gz，≤30 MB）+ `meta`（JSON）

```jsonc
// meta
{ "label":"v1.2.0", "summary":"新增声音上传与地图筛选", "flows":["上传声音","查看地图"] }
// ←  201
{ "version_id":"v_..", "seq":7, "preview_url":"https://supermind-ai.cn/vibehub/_preview/a1b2c3d4e5f6g7h8/?claim=<短期签名>",
  "preview_expires_at":"2026-08-03T01:20:00.000Z",
  "deployment":{"status":"ready"}, "diagnosis":{"status":"running"},
  "review":{"status":"waiting_for_diagnosis"},
  "message":"已生成预览版本，正在做 AI 诊断，随后会自动进入老师的审核队列" }
```
错误：`bundle_too_large` · `bundle_invalid`（解包失败/含危险条目）· `missing_index_html` · `rate_limited`

---

## 2. 学员端（网页，cookie 鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/session/redeem` | 用邀请码登录网页（〔决策 3〕邀请码即身份） |
| `POST` | `/api/session/logout` | 退出（公用电脑场景必须有） |
| `GET` | `/api/me` | 当前身份与所属课程列表 |
| `GET` | `/api/projects/:id` | 项目全貌（同 skill 的 `/skill/project`，但含更多展示字段） |
| `GET` | `/api/projects/:id/versions` | 提交记录，分页 |
| `GET` | `/api/projects/:id/timeline` | 「最近发生了什么」——versions/deployments/reviews 按时间合并 |
| `GET` | `/api/projects/:id/diagnoses/latest` | 最新诊断（含 `dimensions` 与证据） |
| `POST` | `/api/projects/:id/diagnoses` | 手动触发重新诊断（受每日配额限制） |
| `GET` | `/api/projects/:id/stats` | 浏览量（服务端代理 umami，不把 umami 凭证下发到前端） |
| `PATCH` | `/api/projects/:id` | 改标题/简介/分类/封面（不能改 slug、不能改状态） |

**学员的权限边界**：只能读写 `scope.project_id` 指向的那个项目。任何跨项目请求返回 404（不是 403——不泄露"存在但无权"这个信息）。

---

## 3. 管理端（老师，cookie 鉴权 + camp 内 role 校验）

### 课程
| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/camps` | 建课程/活动 |
| `PATCH` | `/api/camps/:id` | 改基本信息、可见性默认值、自动过审规则 |
| `GET` | `/api/camps/:id/overview` | **课程总览**，见下 |
| `GET` | `/api/camps/:id/projects` | 项目列表，支持按状态筛选 |

`GET /api/camps/:id/overview` —— 对应需求文档 §7.7，老师端首页：
```jsonc
{
  "counts": {
    "members": 24, "invites_bound": 22, "projects": 20,
    "not_started": 3, "developing": 8, "pending_review": 6,
    "published": 13, "needs_revision": 2
  },
  "stale": [ { "project_id","title","owner","last_activity_at" } ],  // 超过 N 天没动静的
  "recent": [ { "project_id","title","owner","label","status","updated_at" } ]
}
```
`stale` 是需求文档「管理者可以快速发现……长期没有进展的项目」的直接落实。

### 邀请码
| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/camps/:id/invites` | 批量生成 `{ count, role, expires_at, max_devices }`，**返回的明码只在此处出现一次** |
| `GET` | `/api/camps/:id/invites` | 列表，**脱敏**（只回显后 4 位与状态，不回显完整码） |
| `POST` | `/api/invites/:code/revoke` | 撤销，**级联吊销该码签发的全部 token** |
| `GET` | `/api/camps/:id/invites/export` | 导出 CSV 供老师线下分发（一次性，记审计日志） |

> 名册脱敏 + 即时吊销这三条抄自 Vibe Workbench 的 participant 机制，已在生产验证过。

### 审核
| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/reviews?camp_id=&status=pending` | 审核队列（原型 `#admin` 左栏） |
| `GET` | `/api/reviews/:id` | 单条详情：版本信息、预览地址、含完成度与验证覆盖率的诊断摘要、本次更新说明 |
| `POST` | `/api/reviews/:id/approve` | `{ comment? }` → 事务更新 + 原子切换软链 |
| `POST` | `/api/reviews/:id/reject` | `{ comment }` —— **comment 必填**，学员要看到驳回原因 |

### 项目管理
| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/projects/:id/suspend` | 下线已发布作品 |
| `POST` | `/api/projects/:id/resume` | 恢复 |
| `PATCH` | `/api/projects/:id/visibility` | 覆盖课程默认可见性 |
| `POST` | `/api/camps/:id/collection` | 集合页排序/推荐位管理 |

---

## 4. 公开端（无需鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/public/camps/:slug` | 集合页数据：课程信息 + 统计 + 分类 + 作品卡片 |
| `GET` | `/api/public/projects/:slug` | 单个作品的公开信息 |

集合页的作品卡片按推荐位、老师设置的顺序、更新时间返回；卡片白名单中包含 `featured: boolean`，供公开端将推荐作品渲染为大卡。

**公开端的返回体是白名单构造的**，不是把内部对象删字段。永远不会出现：邀请码、未发布版本、诊断报告、审核记录、真实姓名（除非可见性为 `realname`）、任何内部 id 之外的管理数据。

`camp_only` 可见性的课程，这两个接口要求有效的课程内会话，否则 404。

---

## 5. BaaS 端（学员作品运行时调用）〔决策 1〕

基址：主域作品路径下的 `/baas/v1/*`，由 nginx 反代到平台。正式作品使用
`https://supermind-ai.cn/vibehub/<username>/<projectname>/`，预览使用
`https://supermind-ai.cn/vibehub/_preview/<pid16>/`。项目身份来自 URL 路径映射，不由 Host 推导；作品不需要也拿不到任何密钥。

SDK 当前发送 `x-vibehub-project` 路径线索，服务端当前按该 header 优先、`Referer` 兜底解析。两者都是客户端可控请求头，**不是授权凭证或安全边界**；服务端不得信任客户端自报的 project header/id。

### 当前已实现

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/baas/v1/:collection` | 存一条数据，返回 `{id, created_at}` |
| `GET` | `/baas/v1/:collection` | 列表，支持 `?limit=`，上限 200 |
| `DELETE` | `/baas/v1/:collection/:id` | 删除 |
| `POST` | `/baas/v1/files` | 上传文件（multipart），返回文件 URL 字段；文件读取见下方规划接口 |
| `POST` | `/baas/v1/counter/:key` | 原子自增，返回新值 |

### 规划中（当前未实现）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/baas/v1/:collection/:id` | **【规划中，当前未实现】** 单条读取 |
| `GET` | `/baas/v1/files/...` | **【规划中，当前未实现】** 文件读取 |
| `POST` | `/baas/v1/ai` | **【规划中，当前未实现】** `{prompt, max_tokens?}` → 计划走模型网关（含安全过滤） |

配额与限流（每项目）：数据 10 万条 · 单条 64 KB · 文件总量 500 MB · 单文件 20 MB · 每项目 60 req/min 令牌桶。AI 配额属于规划接口，当前不能调用。超限返回 429 且 `message` 是人话。

**BaaS 数据默认公开可读**（作品是公开网页，读操作没有身份），写操作同样开放但受限流与大小约束。这是刻意的取舍：营地场景下作品需要"任何访客都能留言/上传"，做鉴权反而做不出想要的作品。**代价是数据可能被恶意写入**，缓解手段是配额、内容过滤和老师可一键清空某个 collection。

> 这条取舍需要在第 2 轮决策中跟 Michael 确认——如果某些作品需要"只有作者能写"，要加一层可选的作品级口令。

---

## 6. 内部/运维

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 存活探针 |
| `GET` | `/api/internal/queue` | 诊断队列长度与耗时（管理员） |
| `POST` | `/api/internal/reindex` | 重建 slug ↔ 目录映射（灾后恢复用） |

---

## 7. 幂等与并发

| 场景 | 处理 |
|---|---|
| skill 重复提交同一内容 | preflight 按 `sha256` 去重，返回已有 version |
| 老师同时点两次「审核并发布」 | `reviews` 表带乐观锁（`status='pending'` 作为 WHERE 条件），第二次影响 0 行 → 返回「这个版本已经处理过了」 |
| 学员在审核过程中又提交新版本 | 新版本入队，旧的 pending review 自动置为 `superseded`，老师队列只显示最新的 |
| 未审核预览 claim 已签发后凭证或版本状态变化 | 每次文件请求都重新检查签发 token、课程成员身份、`pending_version_id` 与 review 状态，旧 cookie 立即返回 404 |
| 发布切换过程中有访客访问 | `ln -sfn` + `mv -T` 原子替换，访客要么看到旧版要么看到新版，不会 404 |
| 诊断任务重复入队 | 按 `version_id` 去重，同一版本同时只有一个诊断任务在跑 |
