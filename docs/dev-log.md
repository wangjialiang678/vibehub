# 开发过程日志

## Round 0 — 2026-08-15 环境与基线

阶段：准备

### 验证结果

| 测试项 | 判定标准 | 实际命令 | 结果 |
|---|---|---|---|
| Node 运行时 | 版本满足 `>=22` | bundled Node `--version` | PASS（24.19.0） |
| 服务端基线 | 全部通过 | bundled Node `--test test/*.test.js` | PASS（217） |
| Web 基线 | 全部通过 | bundled Node `vitest.mjs run` | PASS（92） |
| Web 构建基线 | TypeScript/Vite 成功 | bundled Node 运行 tsc 与 Vite | PASS |
| CI 已知失败定位 | 与产品代码无关且有确定修复 | 临时 nginx 配置专项测试 | PASS（测试端口改 8443，生产配置未改） |

### 决策理由

- 原主工作区包含用户的上海营历史导入改动，因此在独立 worktree 和 `codex/student-ai-multi-project-mvp` 分支实现。
- 本机 shell PATH 不含 Node/npm，验证命令改用 Codex bundled Node 的绝对路径；判定标准不变。
- 工作区未安装 Playwright；前端确定性行为由现有 Vitest 组件测试覆盖，发布后补真实浏览器剪贴板人工抽查。

## Round 1 — 2026-08-15 MVP 集成

阶段：P0 + P1 自动化

### 验证结果

| 测试项 | 判定标准 | 实际命令 | 结果 |
|---|---|---|---|
| 服务端全量 | 失败数 0 | bundled Node `--test test/*.test.js` | PASS（233/233） |
| Web 全量 | 失败数 0 | bundled Node `vitest.mjs run` | PASS（92/92） |
| Web 类型与生产构建 | 退出码 0 | bundled Node 运行 `tsc -b`、Vite build | PASS（154 modules） |
| CLI/Skill 专项 | 目录绑定、分发契约全通过 | bundled Node 跑三个专项文件 | PASS（74/74） |
| 学生项目创建专项 | 创建、幂等、权限、撤销、A/B 隔离全通过 | bundled Node 跑创建专项 | PASS（10/10） |
| nginx CI 专项 | 不绑定特权端口且生产配置不变 | bundled Node 跑 security-config | PASS（4/4） |

### 失败与修复

- CLI 首轮新增测试复现多连接未绑定仍可能回退 active；实现目录 binding 后改为构建/联网前 fail closed。
- pending 创建首轮复现 active 切换后会换授权连接；把原连接指纹纳入不含秘密的 `request_id`，重试精确恢复原连接。
- 服务端首轮缺接口；后续补测并修复标题控制字符、撤销竞态和底层数据库错误泄露。
- Web 首轮命中旧的默认网页、双段复制和等待第二句行为；统一 builder 后专项与全量变绿。

### 修改范围

- 服务端：学生 Skill 项目创建、派生 token、幂等/限流/审计。
- CLI/Skill：project create/link、目录防串项目、1.0.1 分发说明。
- Web：AI 默认、一次式复制、老师单段转发。
- 文档/CI：研究、设计、实施计划、回滚备份与 nginx 测试端口。

## Round 2 — 2026-08-15 独立评审与主线合并

阶段：P0 发布门禁

### 评审修复

- 目录 binding 从其他目录复制时改为在构建和联网前 fail closed；只有显式 `project link` 才能把第二个本地目录登记到同一作品连接。
- 多连接创建作品时必须用完整连接标识明确 `--from`；`status`/`open`/`logs` 也按当前目录 binding 选准作品。
- binding、`.git`、gitdir pointer 和 exclude 路径补充符号链接、越界与原子替换保护。
- 幂等恢复改为原地轮换一枚项目 token，不累积凭证行；查询同时限定 parent/project，不同父连接不能互相重签。
- 单 token 撤销递归向下撤销派生树；邀请码设备数不再把派生项目 token 算成新设备。
- 新建参数采用 allowlist，`request_id` 必须以 `pc_` 开头；新增真实旧 SQLite schema 升级测试。
- 提示词明确校验 manifest 字节数和 SHA-256，先检查目录 binding，再创建/关联作品并立即部署。
- 发布手册改为数据库先备份，服务端切换后强制 restart + health/auth 探针，Skill 精确验证 1.0.1 与 create/link。
- 重复 bind 回包后重读本地连接，不覆盖联网期间刚完成的 `project link`；正式 binding 没有已验证路径时必须显式 link，不再静默认领。
- 项目创建锁用硬链接原子竞争、nonce/时间身份和先 rename 后比对的回收流程，关闭失效锁 ABA 竞态与 PID 复用永久阻塞。
- 网页会话每邀请码最多 10 行，淘汰时删除无派生关系的旧 web token，不让重复登录无限增长表。
- 失败提交回滚改用专用软链接删除，消除 Node 24 不同小版本对“指向目录的软链接”通用删除行为差异。

### 主线合并

- 合并 `origin/main` 的长期网页登录会话更新；`auth.js` 同时保留 cookie 滑动续期和项目 token 派生/撤销逻辑。

### 验证结果

| 测试项 | 结果 |
|---|---|
| 服务端全量 | PASS（合并最新主线后 261/261；前一稳定点连续 3 × 258/258） |
| Web 全量 | PASS（94/94） |
| Web 类型与生产构建 | PASS（154 modules） |
| CLI/Skill/安全配置 | PASS（94/94） |
| Skill 分发版本与清单 | PASS（1.0.1，7 文件） |
| 补丁格式与敏感信息扫描 | PASS |

早期并行评审在 Node 24.13 观察到 2 个提交回滚失败，而 Node 24.19 连续回归未复现。最终定位为软链接删除 API 的小版本行为差异，改用 `unlink` 后相同两条回滚路径与全量测试均通过。

## Round 3 — 2026-10-29 历史归档批次收口与合集可见性

阶段：P0 发布门禁（代码已通过，尚未上线）

### 迭代内容

- `POST /api/camps/:campId/collection` 增加可选 `hidden`：请求带布尔值才改 `collection_hidden`，缺省保持原值；非布尔值整批回滚并返回 400，避免只调排序的旧调用方意外放出或藏起作品。
- 管理端「项目 → 集合页编排」新增逐条「从合集隐藏 / 恢复展示」，隐藏条目保留发布状态与作品网址，只退出公开合集；`getCollectionUpdates` 把可见性差异纳入差分。
- 补齐文档：`api.md` 请求体、`domain-model.md` 字段语义与不变式、`deployment.md` §9 的手动操作入口。
- 首次纳入 2026-08-13 完成但一直未提交的历史归档导入/补全脚本（`import-ai-game-sh.mjs`、`reconcile-ai-game-sh.mjs`）与审计报告。

### 验证结果

| 测试项 | 判定标准 | 实际命令 | 结果 |
|---|---|---|---|
| 服务端全量 | 失败数 0 | `node --test "test/*.test.js"` | PASS（283/283） |
| 新增合集可见性用例 | 隐藏/恢复、缺省不改、非布尔整批拒绝 | 同上（routes.test.js 第 54–56 项） | PASS |
| 历史归档脚本专项 | 13/13 | `node --test test/import-ai-game-sh.test.js` | PASS（13/13） |
| Web 全量 | 失败数 0 | `npm test`（含 pretest 重建分发） | PASS（95/95） |
| Web 类型与生产构建 | 退出码 0 | `npm run build` | PASS（154 modules） |
| Skill 分发完整性 | 1.0.1，七文件字节与 SHA-256 全等 | 生成器 + 逐文件核对 | PASS（7/7） |
| 补丁卫生 | `git diff --check` 退出 0，无密钥/邀请码/无关文件 | `git diff --check` + 敏感词定向扫描 | PASS |

### 失败与修复

- 首轮无测试失败；新增用例按「先写失败断言再实现」的顺序补，未出现修 A 破 B。
- **交付前自查发现阻塞项**：审计文档原本照抄了 14 名未成年学员的真实姓名、5 名「无作品」名单和「推测为某某」的未证实对应，还带本机绝对路径。仓库是 public，这与「仓库不包含学员数据」的安全边界冲突。处理：名册改为人数口径、作品表改用公开账号/署名、本地路径改为运营侧描述；补全脚本里的 `displayName` 也从代码移除，改为 `--authors` 从仓库外注入、缺省用账号，并加 `resolveDisplayName` 与清单不含姓名的回归断言。
- 首次提交被 `git diff --check` 拦下（审计文档 Markdown 硬换行留下 2 处行尾空格），去掉后退出码 0。
- 校验了统计口径：`stats.published` 直接取过滤后的 `items.length`，合集隐藏后计数自动一致，无需额外改动。

### 上线待办

- 线上仍是 `666a39c`，部署本批后需要在管理端把上海营 4 个轮回变体和 1 个课程设计页隐藏，公开合集才会从 22 张收敛到 17 张。

## Round 4 — 2026-10-29 交付前安全与功能复审

阶段：独立代码审查

### 审查范围

- 全仓密钥/凭证模式扫描、145 个提交的完整 git 历史、stash、被跟踪文件清单
- 公开端隐私边界、名单与实名展示链路、可见性同意校验
- 端点级测试覆盖与统计口径一致性

### 发现与修复

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| 1 | 中 | 集合页 `stats.creators` 用 `camp_members` 全量计数：老师也算创作者，没有作品的学员也算；`/api/camps/:id/overview` 的「参与人数」同样把老师算进去 | 改为按集合内作者去重；管理端补 `role='student'`；新增用例覆盖「1 老师 + 2 学生 + 1 个作品」 |
| 2 | 低 | `/api/public/projects/:slug` 按 slug 全局查询，而 `projects` 只有 `UNIQUE(camp_id,slug)`；两个营地出现同名 slug 时会返回更新时间更近的那个 | 记为风险：当前前端未调用该端点，启用前需加 camp 作用域 |
| 3 | 信息 | 本地 stash 中留着未脱敏版本（含 14 名学员真名） | 已 drop 两个 stash，其中「codex student submission」的 patch 另存到仓库外归档目录 |

### 未发现问题的项

- 源码无真实密钥：命中项全部是测试构造的假值（`sk-secret…`、测试用 claim secret）
- `.gitignore` 覆盖 `.env` / `*.key` / `*.pem` / `*.db` / `data/` / `uploads/` / `credentials.json`；当前无凭证类文件被跟踪
- 145 个提交的历史中不含学员真名（对 14 个姓名逐个 `git log -S` 核对，仅命中的是已 drop 的 stash）
- 公开端是白名单返回体，默认只暴露昵称；`realname` 需要 `consent_confirmed=true` 且写审计
- BaaS 项目归属由 Referer/origin 推导，不接受前端自报 project；预览额外绑定 preview_id 与独立 host

### 遗留提示

- 老师导入名单时若把真名填进「昵称」列，会直接公开到集合页；界面需保持两列语义的区分提示
- 本地 git 对象里可能仍存在已 drop 的 stash 内容，彻底清除需 `git gc --prune=now`（会同时清理其他可恢复历史，未执行）

### 验证结果

| 测试项 | 结果 |
|---|---|
| 服务端全量 | PASS（285/285，新增 1 项统计口径用例） |
| Web 全量 | PASS（95/95） |

## Round 5 — 2026-10-29 生产部署与复用文档

阶段：上线

### 部署记录

- 目标：腾讯云南京 Lighthouse，`hub.supermind-ai.cn`；从 `20260815-061518` 升级到 `20261029-183756`（对应 `f25ea56`）。
- 部署前备份：`/var/lib/vibehub/backup/pre-deploy-20261029-183722.sqlite`，`PRAGMA integrity_check` = `ok`（442 KB → 备份 479 KB）。
- 服务端：rsync 到 `/opt/vibehub-releases/20261029-183756`，`npm ci --omit=dev`（27 MB），软链 `ln -sfn` + `mv -Tf` 原子切换，`systemctl restart vibehub`。
- 前端：`web/dist` → `/var/www/vibehub-console/releases/20261029-183756`，`current` 软链切换。
- `/etc/vibehub/vibehub.env` 未改动，预览 claim 不变。

### 上线验证（从服务器外部发起）

| 项目 | 期望 | 实测 |
|---|---|---|
| `GET /` | 200 且是新构建 | 200，`index-DOc0iWk2.js` / `index-ClV7VSPm.css` |
| `GET /healthz`（机内） | 200 | 200 |
| 无凭证 `GET /api/me` | 401 | 401 |
| 公开合集 `stats` | 22 → 17 | `published: 17` |
| 被隐藏的 5 个作品网址 | 仍 200 | 全部 200 |
| 正常作品抽查 2 个 | 200 | 200 |
| `/install` | 200 | 200 |
| Skill manifest | 1.0.1 / 7 文件 / AGENTS.md 5761 B `c065b6c9…` | 一致 |
| 服务日志 | 无 error | 仅 Node 的 SQLite experimental 警告 |

`creators` 从 16 变成 14：这个数字原本是 `camp_members` 计数，现在按集合内作者去重；
有 2 个作者（`player`、`feiyang`）的作品只在被隐藏的 5 张里，所以不再计入。

### 复用性补强

- 新增 `docs/handbook/reuse-guide.md` 与 `server/.env.example`；README 技术栈更正为实际运行形态（Node 22 + systemd）。
- 修正 `.gitignore`：`.env.*` 规则排在 `!.env.example` 之后，把例外覆盖掉了，配置模板一直被忽略；例外移到 `.env.*` 之后。
