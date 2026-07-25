# Codex terra 任务：老师端功能补全 + 状态自动刷新（web/）

## 背景

首场是**展示型营**（学员作品不碰存数据/上传/录音）。这降低了安全隔离压力，重心转到**老师能自己把营开起来、看进度、发码审核**。当前前端只有 login/student/admin-review/collection 四个路由，老师建课发码、看进度只能靠命令行——这在真实开营时不可行。

**只改 web/ 目录。** 后端 API 大多已存在（见 `server/src/routes/admin.js`、`server/src/index.js`），你主要是补前端页面并接上。改完 `cd web && npm run build` 必须通过，不引入 UI 组件库，沿用现有设计 token 与组件风格。

后端可先起来对照：`cd server && node src/seed.js`（输出 teacher_token + 邀请码），`node src/index.js`。

## P0（开营必需）

### F1. 去掉 `?token=` query 登录，改用正规登录（Sol #9 安全）
现状：`AdminPage` 从 `?token=` 读老师 token 写进 cookie——token 会进浏览器历史和 nginx 日志。
要做：
- 登录页 `/login` 统一用**邀请码**登录（学员码 → 学员端；老师码 → 老师端），走 `POST /api/session/redeem`（已支持按 role 返回）。
- 需要后端配合的话：`server/src/seed.js` 已生成 teacher_token，请改为**同时生成一个老师邀请码**（role=teacher）。**这一处 seed.js 的小改动允许你动 server/，仅限 seed 生成老师邀请码，不要改其他 server 逻辑。**
- `AdminPage` 不再读 `?token=`；未登录访问 `/admin` 跳 `/login`。

### F2. 状态自动刷新（Sol #12）
现状：查询没有 `refetchInterval`，老师在诊断完成前打开"空队列"不会自动出现新提交；学员旧诊断不自动刷新。
要做：
- 审核队列：`refetchInterval: 4000`（4 秒）。
- 学员看板：诊断 `status==='running'` 或存在 `stale` 时轮询 `refetchInterval: 3000`，就绪后停。
- 轮询要在页面不可见（`document.hidden`）时暂停，别空耗。

### F3. 邀请码管理页 `/admin/invites`
后端已有：`POST /api/camps/:id/invites`（批量生成，明码只返回一次）、`GET .../invites`（脱敏列表）、`GET .../invites/export`（CSV）、`POST /api/invites/:code/revoke`（级联吊销）。
要做前端：
- 生成表单：数量、角色（学员/老师）、设备上限。生成后**把明码显著展示并提示"只显示这一次"**，提供"复制全部"和"导出 CSV"。
- 列表：脱敏码（····-后4位）、状态、绑定的学员/项目、已用设备数。每行有"撤销"按钮，撤销后提示"N 台设备已同时失效"。

### F4. 课程总览页 `/admin/overview`（需求文档 §7.7）
后端已有 `GET /api/camps/:id/overview`（counts + stale + recent）。对应原型侧边栏"总览"。
要做：
- 顶部数字卡：参与人数 / 已绑定 / 项目数 / 未开始 / 开发中 / 待审核 / 已发布 / 被驳回。
- **"卡住了的人"列表**（`stale`）：长期没动静的项目 + 作者 + 最后活动时间——这是老师上课时最想要的。
- "最近动态"（`recent`）。
- 点项目进入其看板视图。

### F5. 老师侧边栏接上以上页面
原型老师导航顺序：总览 / 项目 / 审核 / 集合页。把"总览"接 F4、"审核"接现有队列、"集合页"接公开集合页。"项目"接项目列表（`GET /api/camps/:id/projects` 已有，做一个简单列表即可）。

## P1（首场可用命令行顶替，有余力再做）

- 建课程 UI（`POST /api/camps` —— 注意后端可能还没有这个路由，若没有则**跳过此项、在报告里指出**，首场我用 seed 建课）
- 学员"提交记录"页 `/app/versions`（`GET /api/projects/:id/versions` 已有）
- 集合页作品排序/推荐位管理

## 验收标准

- `cd web && npm run build` 通过，无 console error
- 老师能：登录（非 query token）→ 看总览发现卡住的人 → 生成并导出邀请码 → 撤销 → 审核队列自动刷新看到新提交
- 学员提交后，老师端队列 4 秒内自动出现，不需手动刷新
- 不引入 UI 组件库；新页面沿用现有卡片/间距/配色风格，与原型一致
- 报告里说明改了哪些文件、F1 的 seed 改动、哪些 P1 项因后端缺路由而跳过
