# 复用 VibeHub 指南

给想在这套代码上长自己功能的同事。目标：读完知道**哪些能直接拿**、**哪些要换**、**从哪加**。

## 它本质上是什么

一条「零基础用户的作品 → 变成公开网址」的管道，加一个审核闸门：

```
用户在自己习惯的 AI 工具里说一句「部署」
  → Skill 打包上传（版本不可变）
  → 平台给出隔离预览地址
  → 老师/管理员审核
  → 软链原子切换到正式网址
  → 作品汇入公开集合页
```

加一项中间能力：**作品可以调用平台托管的 BaaS**（存数据、传文件），用户不写后端、不持密钥。

如果你要做的事里包含「非技术用户要把做出来的东西发出去」，这条管道基本可以直接用。

## 5 分钟本地跑起来

```bash
# 后端
cd server && npm ci && node src/seed.js && node src/index.js   # http://127.0.0.1:4300

# 前端（另开一个终端）
cd web && npm ci && npm run dev                                # http://localhost:5173，代理到 4300
```

`node src/seed.js` 会生成演示营地和邀请码，终端会打印可用的登录码。数据落在
`~/.vibehub-data`（可用 `VIBEHUB_DATA_DIR` 改），不进仓库。

环境变量见 [`server/.env.example`](../../server/.env.example)。注意：服务不会自动读取
`.env` 文件，本地要 `set -a; source server/.env; set +a`，生产用 systemd 的 `EnvironmentFile`。

跑测试：

```bash
cd server && npm test        # 285 项，含权限、竞态、软链、解包安全
cd web && npm test           # 95 项，含组件行为与文案契约
bash scripts/loop-test.sh    # 一条命令跑完整闭环（含构建与分发完整性）
```

## 目录地图

| 路径 | 管什么 | 换场景时动不动 |
|---|---|---|
| `server/src/lib/db.js` | 全部表结构 + 幂等迁移（`ensureColumn`） | 加表/加列时改这里 |
| `server/src/lib/auth.js` | 邀请码、token 派生与撤销、设备数、网页会话 | 一般不动 |
| `server/src/routes/skill.js` | Skill 协议：bind / projects / preflight / versions | 换上传契约时才动 |
| `server/src/routes/admin.js` | 老师端：总览、邀请码、名单、审核、合集编排 | 加管理功能改这里 |
| `server/src/routes/public.js` | 公开集合页，**白名单返回体** | 改公开字段时只改这里 |
| `server/src/routes/baas.js` | 作品的数据/文件能力 | 一般不动 |
| `server/src/services/publish.js` | 版本目录、软链、原子切换 | ⚠️ 改这里要跑全量 |
| `server/src/services/diagnosis.js` | 确定性检查器：每项 `check_key` + 分数 | 加检查项改这里 |
| `server/src/services/unpack.js` | 解包、路径穿越防护、敏感文件过滤 | ⚠️ 安全关键 |
| `skill/` | 装到用户机器上的 CLI，`distribution-files.mjs` 固定分发清单 | 改 CLI 要同步版本号 |
| `web/src/pages/` | 10 个页面，路由在 `App.tsx` 一处集中 | 加页面改这里 |
| `infra/` | nginx 三份配置 + systemd 单元 | 换域名时改这里 |

## 哪些是通用的，哪些是「营地场景」特有

**通用，直接拿：**

- 版本不可变 + 预览/正式分离 + 软链原子切换（`publish.js`）
- 邀请码 → token 派生树 → 级联撤销（`auth.js`），一个码可派生多个项目 token 而不占设备数
- 确定性诊断打分 + 模型只负责翻译成人话（`diagnosis.js`），每分可溯源
- BaaS：集合读写、计数器、文件上传，按作品 URL 推导归属
- 分发完整性：manifest 带每个文件的字节数与 SHA-256，装坏了不替换
- 白名单返回体的公开 API 设计

**营地特有，换场景要改：**

| 东西 | 现状 | 换法 |
|---|---|---|
| `camps.kind` | 课程/房间/征集/黑客松（自由文本） | 直接用，语义自己定 |
| 老师审核闸门 | 正式发布必须老师 approve | 内部工具可改成自动通过：`reviews` 直接写 approved，或改 `publish.js` 调用方 |
| 学员身份 / 名单 / 实名同意 | `camp_roster` + `realname_consent` | 企业场景通常删掉这层，或换成部门字段 |
| 集合页文案 | 「把每个人的想法，vibe 在一起」等 | `web/src/pages/CollectionPage.tsx` |
| 未成年人安全过滤 | 走模型网关 | 换自己的网关地址即可 |

## 三种常见复用方式

**1. 换场景，保留全部管道**（改动最小）
改 `camps` 的名称/主题/文案 → 换集合页文案 → 换域名与证书 → 部署。业务表基本不用动。

**2. 只要「一句话部署」这层**
拿 `skill/` + `routes/skill.js` + `services/publish.js` + 预览 claim。审核、名单、集合页都可以不要。
`deployments` / `versions` / `previews` 三张表就够。

**3. 只要发布管道**
拿 `publish.js` 的版本目录约定和软链原子切换，前面接你自己的上传逻辑。
注意它依赖 `paths.versions` / `paths.sites` 两个根目录，别绕过。

## 加东西时改哪里

| 想加 | 改 |
|---|---|
| 新的诊断检查项 | `diagnosis.js` 里加 `check_key`，给 `max_points`，决定 `applicability`（不适用项不进分母） |
| 新的管理端指标 | `admin.js` 的 `/overview` 聚合 SQL + `AdminOverviewPage.tsx` 的 `metrics` 数组 |
| 新的项目字段 | `db.js` 建表语句 + 末尾 `ensureColumn('projects', ...)`（生产库已有数据，只能加列） |
| 新的公开字段 | `public.js` 的白名单构造里显式加，**不要**把内部对象整个返回 |
| 新的 CLI 命令 | `skill/bin/vibehub` + `distribution-files.mjs` 清单 + 版本号 + `server/test/cli.test.js` |

改完跑 `scripts/loop-test.sh`。它包含构建、分发完整性、后端全量、前端全量。

## 部署到你自己的服务器

完整步骤在 [`docs/handbook/deployment.md`](deployment.md)，要点只有四条：

1. 数据库**先在线备份**再动：`sqlite3 db.sqlite ".backup '...'"` + `PRAGMA integrity_check` 必须 `ok`
2. 每次发布一个新时间戳目录，`/opt/vibehub` 软链原子切换（`ln -sfn` + `mv -Tf`，不要 `ln -sf` 直接覆盖）
3. 切完必须 `systemctl restart`，没有热重载
4. 切完立刻跑 `/healthz` 200 + 无凭证 `/api/me` 401 两个探针

前端同理：`/var/www/vibehub-console/releases/<ts>` + `current` 软链。

**两个域名不是一回事**，换环境时都要配：

| 入口 | 变量 | 生产值 |
|---|---|---|
| 控制台 + API | `VIBEHUB_CONSOLE_ORIGIN` | `https://hub.supermind-ai.cn` |
| 作品站点 | `VIBEHUB_WORKS_ORIGIN` + `VIBEHUB_WORKS_PREFIX` | `https://supermind-ai.cn` + `/vibehub` |
| 预览 | `VIBEHUB_PREVIEW_ORIGIN_TEMPLATE` | `https://{previewId}.preview.supermind-ai.cn` |

在控制台域名下拼作品路径会命中 SPA 兜底、返回 **200** 和一个 445 字节的 index.html。
核验作品必须用公开 API 返回的 `url` 字段，并同时看响应体大小。

`/etc/vibehub/vibehub.env` 里的 `VIBEHUB_PREVIEW_CLAIM_SECRET` **一旦轮换，所有未过期的预览链接立即失效**。

## 别踩的坑

- **不要给公开 API 加「顺手返回整个对象」**。现在是白名单构造，这是防线本身。
- **`projects.slug` 只有 `UNIQUE(camp_id, slug)`**，跨营地会重名。`/api/public/projects/:slug` 是全局查的，多营地场景要先加 camp 作用域。
- **改 `skill/` 必须同时动版本号和 `distribution-files.mjs`**，否则已装用户拿到的清单对不上，安装器会拒绝安装（这是故意的）。
- **`publish.js` 的软链切换不要在 Windows 上跑**，测试会失败；CI 是 Linux。
- 前端不用 UI 组件库是刻意的，加组件请沿用 `styles.css` 的变量，别引入第二套设计系统。
