# VibeHub

**给零基础学员一条「作品从做出来到公开上线」的完整通道，给老师一个「看得见、审得了、能汇总」的管理台。**

面向 Vibe Coding 教学、主题征集和 AI 黑客松场景的中心化管理、审核、部署与展示平台。学员安装一次通用 VibeHub Skill，再用邀请码把自己习惯的 AI 工具（Claude Code / Codex / WorkBuddy）连到任意营地；写完后让 AI 部署，就能拿到预览地址。老师在审核队列里预览、通过或退回；通过的作品拿到自己的网址和二维码，并汇入课程作品集合页。

> 状态：核心黄金路径已经实现；通用 Skill、跨平台安装页和多营地连接正在做发布前收尾。

---

## 这是什么 / 不是什么

**是**：把作品变成网址 · 让老师能审 · 把作品聚起来展示。

**不是**：不是代码托管平台，不是给学员开服务器的 PaaS，不是 AI 编程工具（学员用自己的），不是课程管理系统。

## 三个角色看到的三个界面

| 角色 | 界面 | 关心什么 |
|---|---|---|
| 学员 | 个人项目看板 | 我的作品上线了吗？网址是什么？下一步做什么？ |
| 老师 | 审核队列 + 课程总览 | 谁卡住了？这个版本能不能发？ |
| 访客 | 作品集合页 | 这些人做出了什么？ |

原型（乐乐老师）：https://vibehub.preview.aliyun-zeabur.cn/ — `#student` / `#admin` / `#collection`
截图与文案已存档在 [docs/research/prototype/](docs/research/prototype/)。

## 本地前端

前端在 `web/`，采用 React 18 + Vite + TypeScript 和手写 CSS；不使用 UI 组件库。后端已运行在本机时，可这样启动：

```bash
cd web
npm install
npm run dev
```

开发服务器会通过同源代理转发到默认后端 `http://127.0.0.1:4300`，以保留 host-only 会话 cookie；用 `VITE_API_BASE` 可覆盖代理目标。部署时该变量指定浏览器请求的 API 地址，`VITE_PUBLIC_APP_URL` 指定老师转发给学员的公开登录与安装地址。npm 包发布并验证后，用 `VITE_SKILL_INSTALL_COMMAND` 开放 `/install` 的复制按钮；未配置时页面不会展示尚不可用的命令。页面入口为 `/app`、`/admin`、`/c/:campSlug`、`/login` 和 `/install`。

## 核心设计要点

- **学员作品是纯静态站 + 平台托管的数据能力**（存数据 / 传文件 / 调 AI），学员不写后端、不碰服务器、不持有任何密钥
- **版本不可变**，「已部署可预览」与「已审核已上线」严格分开；新版被驳回时线上旧版继续可访问
- **发布用软链原子切换**，访客不会看到 404
- **AI 诊断的百分比由确定性检查器算出，模型只负责翻译成人话**——每一分都能指回一条具体证据，且区分「已验证 / 本机上报 / AI 推断 / 需人工确认」
- **老师审核是正式发布的唯一闸门**，AI 诊断不自动放行

## 文档

先读这两份：
- [产品需求文档.md](产品需求文档.md) — 产品概念（乐乐老师）
- [docs/specs/PRD.md](docs/specs/PRD.md) — 可开工版 PRD：范围、用户故事与验收标准、权限矩阵、非目标

设计细节：
- [docs/specs/architecture.md](docs/specs/architecture.md) — 承载形态、URL/证书、部署管道、诊断流水线、Skill 协议、安全边界、分期路线
- [docs/specs/domain-model.md](docs/specs/domain-model.md) — 表结构、五维状态机、与原型的字段对照
- [docs/specs/api.md](docs/specs/api.md) — 四类端点与鉴权铁律

调研与决策依据：
- [docs/research/infra-facts.md](docs/research/infra-facts.md) — 已核实的服务器/域名/备案事实（**别重新猜，读这个**）
- [docs/research/codebase/existing-assets.md](docs/research/codebase/existing-assets.md) — 哪些不用重写
- [docs/research/codebase/方案对撞记录.md](docs/research/codebase/方案对撞记录.md) — 两份独立架构方案的对撞结论
- [docs/research/codebase/architecture-proposal-codex-sol.md](docs/research/codebase/architecture-proposal-codex-sol.md) — Codex 独立起草的方案

## 技术栈（拟定）

| 层 | 选型 |
|---|---|
| 前端 | React 18 + Vite + TypeScript，手写 CSS（**不引 UI 组件库**，会毁掉原型的质感） |
| 后端 | Node 20 + Fastify + SQLite(WAL)，单进程，pm2 托管 |
| 静态承载 | nginx 直接 serve，作品不经过应用进程 |
| 统计 | 复用自托管 umami |
| 模型 | 复用 ai-game-camp-platform 的模型网关（国产模型 + 未成年人安全过滤 + 配额） |
| 生产环境 | 腾讯云南京 Lighthouse，`supermind-ai.cn`（已备案） |

## 开工前必须先做的事

1. **开放 443 + 泛解析 + 通配证书** — 这是 P0 阻塞项：录音、定位等浏览器 API 只在 HTTPS 下可用，没有它一半作品做不出来
2. 确认首场落地场次与截止时间 — P0 范围的唯一裁剪依据
3. 落实「谁负责处理投诉与下架」到具体的人 — 产品设计替代不了这个

完整清单见 [architecture.md §10 待验证清单](docs/specs/architecture.md)。

## 协作方式

本项目用 **VibeLoop 中台体系**协作：
- 决策与评审走 [Vibe Workbench](https://workbench.superbrain-ai.com)（乐乐老师作为顾问参与）
- 产品跑通、测试建立后再接入 user-vibeloop 自动化闭环（见〔决策 6〕）

## 安全边界

- 仓库**不包含**任何密钥、token、学员数据、上传内容
- 只提交 `*.example.*` 配置模板；真实凭证走部署环境或保险库
- 对外发布前按 [超脑上传平台的 release-checklist](../超脑上传平台/docs/handbook/release-checklist.md) 做密钥与用户数据检查
