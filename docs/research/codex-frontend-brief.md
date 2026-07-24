# Codex 任务：VibeHub 前端三个页面（对接真实 API）

## 背景

VibeHub 后端已经跑通（Fastify + SQLite，本地 `http://127.0.0.1:4300`）。
乐乐老师已经做好了三个页面的**视觉原型**，你的任务是把它们实现成对接真实 API 的正式前端。

**这是把已有设计落地，不是重新设计。** 视觉、文案、信息层级都照原型来。

## 必读材料

1. **原型截图（最重要，照着做）**：
   - `docs/research/prototype/student.png` — 学员个人看板
   - `docs/research/prototype/admin.png` — 老师审核台
   - `docs/research/prototype/collection.png` — 作品集合页
2. **原型文案**（逐字照抄，别自己编）：`docs/research/prototype/*.txt`
3. **设计 token**（配色字体，直接用）：`docs/research/prototype/tokens.json`
4. **API 契约**：`docs/specs/api.md`，以及**后端源码就是最终事实**：`server/src/routes/`、`server/src/index.js`
5. 产品约束：`CLAUDE.md`（尤其"不要做的事"一节）

## 技术要求（硬约束）

- **React 18 + Vite + TypeScript**
- **手写 CSS（CSS Modules 或单一 global.css + CSS 变量），严禁引入 antd / MUI / Tailwind / shadcn** —— 原型是手写 CSS，风格克制（暖色浅底、细描边、低阴影、大留白），引组件库会立刻毁掉这个质感
- 服务端状态用 `@tanstack/react-query`；本地状态用 useState，不引 Redux
- 二维码用 `qrcode` 库前端生成
- 请求带 `credentials: 'include'`（会话是 host-only cookie）
- 目录：`web/`，`npm run dev` 起在 5173，通过 `VITE_API_BASE`（默认 `http://127.0.0.1:4300`）访问后端

## 三个页面

### 1. 学员看板 `/app`
对应 `student.png`。数据来自 `GET /api/me` 拿到 project_id，再 `GET /api/projects/:id`。

必须有的 Block（每个 Block 只回答一个问题）：
- **我的作品**：iframe 嵌 `pending_version.preview_url`（没有就用 live），右上角「查看预览」外链；底部「下一步」+「继续开发」按钮
- **访问入口**：`project.live_url` + 二维码 + 复制网址/打开网页；**未发布时显示「还没有正式上线」，不能是空白**
- **运营现状**：`stats.total_views` / `today_views`
- **当前界面现状 / 开发完成度**：`latest_diagnosis`。右上角大号百分比；逐项列出 `items`，显示 `earned_points/max_points`；`applicability === 'not_applicable'` 的项**显示为「不适用」并置灰，不显示为 0 分**；`evidence_level` 用小标记区分（verified=✓已验证 / client_reported=◑本机上报 / ai_inferred=○AI推断 / human_required=⚠需人工确认）；底部 `summary`
- **部署与审核 / 两个版本要分清**：`live_version` 与 `pending_version` 并排，文案照原型「访客现在看到的是这个版本」「审核通过后才会替换线上版本」
- **项目记录 / 最近发生了什么**：`timeline`
- 被驳回时要显眼展示 `last_review.comment`

### 2. 老师审核台 `/admin`
对应 `admin.png`。左侧队列 `GET /api/reviews?status=pending`，右侧详情 `GET /api/reviews/:id`。

- 左列表：头像、作品名、版本号、时间、状态色点
- 右详情：作者+提交时间、诊断三项摘要（前端/服务端/线上版本）、**iframe 嵌 `version.preview_url` 展示真实内容**、「本次更新」= `version.summary`、底部「退回修改」+「审核并发布」
- 「退回修改」必须弹出输入框要求填原因（后端强制非空）
- 顶部「N 个待处理 · M 个已发布」用 `counts`

### 3. 作品集合页 `/c/:campSlug`
对应 `collection.png`。数据 `GET /api/public/camps/:slug`（无需登录）。

- Hero：`camp.theme` 眉题 + 大标题 + `camp.intro` + 三个统计数字
- 分类筛选 chips（`categories`，加「全部作品」）
- 作品卡片瀑布：第一个是大卡（原型里跨两行），其余小卡；卡片含封面/分类/标题/简介/作者/版本/浏览量/「查看作品」
- 卡片封面用作品 URL 的 iframe 缩略（`pointer-events:none` + transform scale）或 `cover_url`

## 还需要一个登录页

`/login`：输入邀请码 → `POST /api/session/redeem` → 成功后按角色跳 `/app` 或 `/admin`。
文案要对小白友好（决策 3：邀请码即身份，没有密码）。

## 本地联调

后端已在跑。先建种子数据看真实内容：
```bash
cd server && node src/seed.js     # 输出 teacher_token 和 10 个学员邀请码
```
老师端本地可用 `?token=<teacher_token>` 或直接把 token 存进 cookie 调试。

## 交付标准

- `cd web && npm install && npm run build` 必须通过
- `npm run dev` 起来后三个页面都能渲染真实数据，浏览器 console 零报错
- **未发布 / 已发布 / 待审核 / 被驳回四种状态下页面都不能出现空白块或 "undefined"**
- 移动端宽度下不横向滚动

## 不要做的事

- 不要改 `server/` 下任何文件（后端是我的活；发现 API 有问题就在最后的报告里写出来）
- 不要引 UI 组件库
- 不要自己发明配色，用 tokens.json
- 不要写假数据兜底——数据取不到就显示真实的空状态文案
