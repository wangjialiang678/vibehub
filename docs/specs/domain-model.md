---
title: VibeHub 领域模型与状态机
date: 2026-07-25
status: draft
audience: tech
---

# 领域模型与状态机

本文把需求文档 §10（核心业务对象）与 §12（状态体系）落成可实现的表结构和状态迁移规则。**这部分不依赖任何未决决策**——无论学员作品的承载形态怎么选，这套骨架都成立。

## 0. 一句话数据流

```
课程 ──1:N── 邀请码 ──绑定──▶ 用户 ──1:N── 项目 ──1:N── 版本
                                            │             ├── 部署记录
                                            │             ├── 审核记录
                                            │             └── 诊断报告
                                            └── 作品地址（指向"当前正式版本"）
```

一个项目在任意时刻最多有：**1 个正式发布版本**（访客看到的）+ **1 个待审核版本**（老师看到的）+ N 个历史版本。

## 1. 表结构

存储选型：**SQLite（WAL 模式）**。理由——数据规模是「几百个课程 × 几十个学员 × 几十个版本」，量级在十万行以内；单文件零运维、备份即复制；南京机 2 核跑单进程服务，不存在多写者竞争。SQLite 在 WAL 模式下允许多读一写，与本场景（写入集中在提交/审核这两个低频动作）完全匹配。

> 若将来需要横向扩展或多进程写入，迁移到 Postgres 的成本主要在 SQL 方言，表结构不变。

### 1.1 camps — 课程 / 房间 / 活动

```sql
CREATE TABLE camps (
  id            TEXT PRIMARY KEY,           -- c_<nanoid>
  slug          TEXT NOT NULL UNIQUE,       -- URL 用，如 ai-product-2026s
  name          TEXT NOT NULL,              -- "AI 产品共创课"
  kind          TEXT NOT NULL,              -- course | room | callforwork | hackathon
  theme         TEXT,                       -- "2026 夏季 · VIBE CODING"
  intro         TEXT,
  cover_url     TEXT,
  -- 课程级策略（见 §3）
  visibility_default TEXT NOT NULL DEFAULT 'nickname',  -- realname | nickname | camp_only
  auto_approve_rules TEXT,                  -- JSON，低风险自动过审规则，NULL=全部人工
  collection_published INTEGER NOT NULL DEFAULT 0,
  starts_at     TEXT, ends_at TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  archived_at   TEXT
);
```

`kind` 只影响界面用词（"课程"/"房间"/"征集"/"黑客松"），底层逻辑完全一致——这是需求文档 §7.1 的明确要求。

### 1.2 users — 用户

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,            -- u_<nanoid>
  display_name TEXT NOT NULL,               -- 昵称，公开展示用
  real_name    TEXT,                        -- 真实姓名，仅管理端可见
  avatar_url   TEXT,
  contact      TEXT,                        -- 手机/微信 openid，可空（见"决策 3"）
  created_at   TEXT NOT NULL
);

CREATE TABLE camp_members (                 -- 用户在某课程中的角色（同一人在不同课程角色可不同）
  camp_id  TEXT NOT NULL REFERENCES camps(id),
  user_id  TEXT NOT NULL REFERENCES users(id),
  role     TEXT NOT NULL,                   -- student | teacher | admin | reviewer
  joined_at TEXT NOT NULL,
  PRIMARY KEY (camp_id, user_id)
);
```

角色是**课程内的**，不是全局的。需求文档 §10.2：「一个用户可能参与多个课程或活动，并在不同场景中拥有不同角色。」

### 1.3 invites — 邀请码

```sql
CREATE TABLE invites (
  code         TEXT PRIMARY KEY,            -- 人可读，如 SUMMER-7K3P（避免易混字符 0/O/1/I）
  camp_id      TEXT NOT NULL REFERENCES camps(id),
  role         TEXT NOT NULL DEFAULT 'student',
  status       TEXT NOT NULL,               -- unused | bound | revoked | expired
  bound_user_id TEXT REFERENCES users(id),
  bound_project_id TEXT REFERENCES projects(id),
  max_devices  INTEGER NOT NULL DEFAULT 3,  -- 一个码能绑几台 AI 工具
  expires_at   TEXT,
  created_at   TEXT NOT NULL,
  bound_at     TEXT,
  revoked_at   TEXT
);
CREATE INDEX idx_invites_camp ON invites(camp_id, status);
```

**授权原则（抄自超脑上传平台 ADR-002 的教训）**：邀请码兑换出的凭证里必须**内嵌 camp_id + project_id 作用域**，服务端一切鉴权只认凭证里的 scope，**绝不接受客户端自报的 camp/project 参数**。身份表单只用于台账和默认筛选。

### 1.4 projects — 项目（作品）

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,           -- p_<nanoid>
  camp_id       TEXT NOT NULL REFERENCES camps(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  slug          TEXT NOT NULL,              -- 作品地址用，如 voice-map；课程内唯一
  title         TEXT NOT NULL,              -- "城市声音地图"
  tagline       TEXT,                       -- 一句话简介，集合页卡片用
  category      TEXT,                       -- "城市与生活"，集合页筛选用
  cover_url     TEXT,
  dev_status    TEXT NOT NULL DEFAULT 'not_started',  -- 见 §2.1
  publish_status TEXT NOT NULL DEFAULT 'unpublished', -- 见 §2.4
  visibility    TEXT,                       -- NULL=继承 camp 默认
  live_version_id    TEXT REFERENCES versions(id),  -- 当前正式发布版本
  pending_version_id TEXT REFERENCES versions(id),  -- 当前待审核版本
  umami_website_id   TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (camp_id, slug)
);
```

> `slug` 的全局唯一性取决于 URL 方案（子域名需全局唯一，路径式只需课程内唯一）——见"决策 2"。表结构上先按课程内唯一约束，全局唯一时额外加一张 `reserved_slugs` 表做占位。

### 1.5 versions — 版本（内容快照）

```sql
CREATE TABLE versions (
  id          TEXT PRIMARY KEY,             -- v_<nanoid>
  project_id  TEXT NOT NULL REFERENCES projects(id),
  label       TEXT NOT NULL,                -- 学员可读版本号 "v1.2.0"
  seq         INTEGER NOT NULL,             -- 项目内自增，防止 label 乱写导致排序错
  summary     TEXT,                         -- "新增声音上传与地图筛选"（原型"本次更新"字段）
  bundle_sha  TEXT NOT NULL,                -- 内容指纹，用于去重与完整性校验
  bundle_size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,               -- versions/<id>/
  submitted_by TEXT NOT NULL REFERENCES users(id),
  submitted_via TEXT NOT NULL,              -- skill | web
  submitted_at TEXT NOT NULL,
  UNIQUE (project_id, seq)
);
CREATE INDEX idx_versions_project ON versions(project_id, seq DESC);
```

**版本是不可变的。** 一旦落盘就不再修改——审核、部署、诊断的结果都挂在关联表上，而不是回写版本本身。这保证「访客看到的是哪个版本」永远可追溯。

### 1.6 deployments — 部署记录

```sql
CREATE TABLE deployments (
  id         TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  target     TEXT NOT NULL,                 -- preview | live
  status     TEXT NOT NULL,                 -- deploying | ready | failed
  url        TEXT,
  error      TEXT,
  started_at TEXT NOT NULL, finished_at TEXT
);
```

### 1.7 reviews — 审核记录

```sql
CREATE TABLE reviews (
  id          TEXT PRIMARY KEY,
  version_id  TEXT NOT NULL REFERENCES versions(id),
  status      TEXT NOT NULL,                -- pending | approved | rejected
  reviewer_id TEXT REFERENCES users(id),
  comment     TEXT,                         -- 驳回原因 / 审核意见
  decided_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_reviews_pending ON reviews(status, created_at);
```

审核队列 = `SELECT ... FROM reviews WHERE status='pending' ORDER BY created_at DESC`，对应原型 `#admin` 页左侧列表。

### 1.8 diagnoses — AI 诊断报告

```sql
CREATE TABLE diagnoses (
  id          TEXT PRIMARY KEY,
  version_id  TEXT NOT NULL REFERENCES versions(id),  -- 强制绑定版本（需求文档 §14.6 硬要求）
  status      TEXT NOT NULL,                -- running | healthy | needs_work | blocked | failed
  score       INTEGER,                      -- 0-100 整体完成度
  facts       TEXT NOT NULL,                -- JSON：确定性采集的客观事实
  dimensions  TEXT NOT NULL,                -- JSON：分维度结论 [{key,label,score,verdict,evidence}]
  summary     TEXT,                         -- 一句话综合结论
  next_steps  TEXT,                         -- JSON：1-3 条下一步建议
  model       TEXT,                         -- 生成结论用的模型，便于追溯
  created_at  TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX idx_diag_version ON diagnoses(version_id, created_at DESC);
```

**`score` 必须由 `dimensions` 按固定权重算出，不由模型生成。** 这是需求文档 §9.1.3「该数字必须能够由下方诊断项解释，不应成为缺少依据的装饰性分数」的直接落实。见架构文档中的诊断流水线设计。

### 1.9 collection_entries — 集合页条目

```sql
CREATE TABLE collection_entries (
  camp_id    TEXT NOT NULL REFERENCES camps(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  featured   INTEGER NOT NULL DEFAULT 0,    -- 是否推荐位（原型里第一个卡片是大卡）
  added_at   TEXT NOT NULL,
  PRIMARY KEY (camp_id, project_id)
);
```

集合页**只展示 `projects.publish_status='published'` 的项目**，且展示的是 `live_version_id` 指向的内容。这条约束在查询层强制，不依赖运营人员记得。

---

## 2. 五维状态机

需求文档 §12 定义了五类互相独立的状态。**关键约束（§12 结尾）**：同一项目可以同时处于多个维度的不同状态，界面必须同时表达清楚。例如「旧版本已正式发布 + 新版本已部署成功但待审核 + 诊断显示需要继续完善」是完全合法的组合。

### 2.1 开发状态（project.dev_status）

```
not_started ──首次提交──▶ developing ──提交成功──▶ submittable
                              ▲                        │
                              └────────被驳回──────────┘
                                    (needs_revision)
```

| 值 | 界面用词 | 进入条件 |
|---|---|---|
| `not_started` | 未开始 | 项目创建但从未提交过版本 |
| `developing` | 开发中 | 有过提交，且当前没有待审核版本 |
| `submittable` | 已形成可提交版本 | 最新版本部署成功且诊断非 blocked |
| `needs_revision` | 等待修改 | 最新版本被驳回 |

### 2.2 部署状态（deployment.status，按版本）

```
（提交）──▶ deploying ──成功──▶ ready
                 └──失败──▶ failed ──（学员重新提交）──▶ 新版本
```

界面用词：未部署 / 部署中 / 预览版本已生成 / 部署失败。

### 2.3 审核状态（review.status，按版本）

```
（部署 ready）──自动创建──▶ pending ──老师通过──▶ approved
                                └──老师驳回──▶ rejected
```

**规则**：
- 审核任务由「部署成功」自动触发创建，学员不需要额外点"提交审核"。这与需求文档 §11.3 第 5 步一致。
- 部署失败**不创建**审核任务——老师不应该看到一个打不开的版本。
- `approved` 后立即触发发布切换（见 §2.4）。
- `rejected` 后 `projects.pending_version_id` 置空，`dev_status` 转 `needs_revision`，**但 `live_version_id` 保持不变**——需求文档 §7.6：「如果新版本被驳回，已经正式发布的旧版本应继续保持可访问。」

### 2.4 发布状态（project.publish_status）

```
unpublished ──首次审核通过──▶ published ──新版本待审核──▶ published_with_pending
                                  ▲                              │
                                  └──────新版本通过/驳回──────────┘
                                  
published ──管理员停用──▶ suspended ──恢复──▶ published
```

| 值 | 界面用词 | 含义 |
|---|---|---|
| `unpublished` | 未发布 | 从未有版本通过审核 |
| `published` | 已发布 | `live_version_id` 有效且可访问 |
| `published_with_pending` | 已有新版本待审核 | 线上是旧版，新版在队列里 |
| `suspended` | 已停用 | 管理员下线，访问返回提示页 |

**「已部署可预览」≠「已审核已上线」**——需求文档 §9.2 特别强调。学员看板必须同时显示两个版本号（原型 `#student` 页的「两个版本，要分清」区块正是这个）。

### 2.5 诊断状态（diagnosis.status，按版本）

```
（无记录）= 暂未诊断
running ──▶ healthy | needs_work | blocked | failed
```

**诊断状态与其他四维完全解耦**（需求文档 §12.5）：一个版本可以「部署成功、待审核」同时诊断显示「需要继续完善」。**诊断结论不自动改变审核结果**，只作为老师的参考信息。

### 2.6 版本发布的原子切换

审核通过时的动作序列（必须在一个事务 + 一次原子文件操作内完成）：

```
BEGIN;
  UPDATE reviews SET status='approved', reviewer_id=?, decided_at=? WHERE id=?;
  UPDATE projects SET live_version_id=?, pending_version_id=NULL,
                      publish_status='published', updated_at=? WHERE id=?;
  INSERT INTO deployments (version_id, target='live', status='deploying');
COMMIT;
-- 然后：原子切换文件系统符号链接
ln -sfn versions/<new_id>/ sites/<slug>/current.tmp && mv -T sites/<slug>/current.tmp sites/<slug>/current
  UPDATE deployments SET status='ready', url=?, finished_at=?;
```

用 `ln -sfn` + `mv -T` 而不是 `rm && ln`，保证任意时刻访客要么看到旧版要么看到新版，**不会看到 404**。

---

## 3. 可见性规则

三层，就近覆盖：

```
camps.visibility_default  ──被覆盖──▶  projects.visibility  ──▶ 实际生效值
```

| 值 | 集合页 | 作品页 | 展示姓名 |
|---|---|---|---|
| `realname` | 公开 | 公开 | 真实姓名 |
| `nickname` | 公开 | 公开 | 仅昵称 |
| `camp_only` | 需课程内身份 | 需课程内身份 | 仅昵称 |

**默认值定在 `nickname`**——让最安全的选项成为不做选择时的结果。具体见"决策 5"。

访客能看到的东西（需求文档 §13.3 的硬边界，在查询层强制）：
- ✅ 已发布项目的 `live_version_id` 内容、标题、简介、昵称、浏览量
- ❌ 邀请码、未发布版本、AI 诊断报告、审核记录、真实姓名、任何内部管理数据

---

## 4. 与原型的字段对照

验证这套模型能不能撑起乐乐老师已经画好的界面：

| 原型元素（`#student`） | 数据来源 |
|---|---|
| "城市声音地图" + "等待审核" 徽章 | `projects.title` + 由 `reviews.status` 派生 |
| "v1.2.0 · 今天 10:35 更新" | `versions.label` + `submitted_at` |
| 「现在的项目长这样」预览 | `deployments(target=preview).url` |
| 「你的网页」`voice-map.vibe.page` + 二维码 | 由 `projects.slug` 生成 |
| 「上线后的表现」1,284 / 186 / 94 / +18% | umami API，按 `umami_website_id` |
| 「开发完成度 86%」 | `diagnoses.score` |
| 「客户端/前端 100%」「服务端 72%」 | `diagnoses.dimensions` |
| 「已具备完整预览版本，可以继续打磨服务端数据」 | `diagnoses.summary` |
| 「当前线上版本 v1.1.0 / 新提交版本 v1.2.0」 | `live_version_id` / `pending_version_id` |
| 「最近发生了什么」时间线 | `versions` + `deployments` + `reviews` 按时间合并 |

| 原型元素（`#admin`） | 数据来源 |
|---|---|
| 左侧待审核队列（6 个待处理） | `reviews WHERE status='pending'` |
| "13 个已发布" | `projects WHERE publish_status IN ('published','published_with_pending')` |
| 「前端 已完成 / 服务端 已连接 / 线上版本 v1.1.0」 | `diagnoses.dimensions` + `live_version_id` |
| 中间的作品预览 iframe | `deployments(target=preview).url` |
| 「本次更新：新增声音上传与地图筛选」 | `versions.summary` |
| 「退回修改」/「审核并发布」 | `POST /api/reviews/:id` |

| 原型元素（`#collection`） | 数据来源 |
|---|---|
| "13 个作品已上线 / 24 位共同创作者 / 6 个创作主题" | 聚合查询 |
| 分类筛选（城市与生活 / 情绪与健康 / …） | `projects.category` DISTINCT |
| 作品卡片（封面/标题/简介/作者/版本/浏览量） | `projects` + `versions` + umami |
| "已发布" 徽章 | `publish_status` |

**结论：模型完整覆盖原型的全部界面元素，没有缺字段，也没有多余的表。**
