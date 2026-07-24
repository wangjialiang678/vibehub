---
title: VibeHub API 契约
date: 2026-07-25
status: draft
audience: tech
---

# API 契约

约定：
- 基址 `https://console.supermind-ai.cn/api`（BaaS 除外，见 §5）
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
| 学员作品运行时 | 由作品域名 Host 推导 project + 服务端签发的 project key | SDK 自动携带 |

**铁律**：服务端一切鉴权只认凭证内嵌的 `scope{camp_id, project_id, role}`，**绝不接受客户端自报的 camp_id / project_id 参数**。请求里出现的 camp/project 参数只用于校验「是否与 scope 一致」，不一致即 403。

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
  "endpoints": { "api":"https://console.supermind-ai.cn/api", "works_domain":"works.supermind-ai.cn" }
}
```
错误：`invite_not_found` · `invite_revoked` · `invite_expired` · `invite_device_limit`（已绑满 `max_devices` 台设备）

### `GET /api/skill/project`
返回当前项目全貌，供 `vibehub status` 输出。

```jsonc
{
  "project": { "id","slug","title","dev_status","publish_status","live_url" },
  "live_version":    { "id","label","published_at" },
  "pending_version": { "id","label","submitted_at","review_status","preview_url" },
  "latest_diagnosis":{ "version_id","status","score","summary","next_steps":[..],"finished_at" },
  "last_review":     { "status","comment","decided_at" }   // 驳回原因在这里
}
```

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
{ "version_id":"v_..", "seq":7, "preview_url":"https://p-a1b2c3d4e5f6g7h8.works.supermind-ai.cn",
  "deployment":{"status":"ready"}, "diagnosis":{"status":"running"},
  "review":{"status":"pending"},
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
| `GET` | `/api/reviews/:id` | 单条详情：版本信息、预览地址、诊断摘要、本次更新说明 |
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

**公开端的返回体是白名单构造的**，不是把内部对象删字段。永远不会出现：邀请码、未发布版本、诊断报告、审核记录、真实姓名（除非可见性为 `realname`）、任何内部 id 之外的管理数据。

`camp_only` 可见性的课程，这两个接口要求有效的课程内会话，否则 404。

---

## 5. BaaS 端（学员作品运行时调用）〔决策 1〕

基址：作品自己的域名下的 `/baas/v1/*`，由 nginx 反代到平台。**项目身份由 Host 推导**，作品不需要也拿不到任何密钥。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/baas/v1/:collection` | 存一条数据，返回 `{id, created_at}` |
| `GET` | `/baas/v1/:collection` | 列表，支持 `?limit=&cursor=&order=` |
| `GET` | `/baas/v1/:collection/:id` | 单条 |
| `DELETE` | `/baas/v1/:collection/:id` | 删除 |
| `POST` | `/baas/v1/files` | 上传文件（multipart），返回公开 URL |
| `POST` | `/baas/v1/ai` | `{prompt, max_tokens?}` → 走模型网关（含安全过滤） |
| `POST` | `/baas/v1/counter/:key` | 原子自增，返回新值 |

配额与限流（每项目）：数据 10 万条 · 单条 64 KB · 文件总量 500 MB · 单文件 20 MB · AI 每日 200 次 · 全局 60 req/min 令牌桶。超限返回 429 且 `message` 是人话（"这个作品今天的 AI 调用次数用完了，明天会重置"）。

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
| 发布切换过程中有访客访问 | `ln -sfn` + `mv -T` 原子替换，访客要么看到旧版要么看到新版，不会 404 |
| 诊断任务重复入队 | 按 `version_id` 去重，同一版本同时只有一个诊断任务在跑 |
