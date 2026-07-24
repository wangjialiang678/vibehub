# Codex 任务简报：VibeHub 架构方案（独立起草）

你是独立架构师。请**不要**先看别人的方案，直接基于下列材料自己推导，产出一份可执行的架构方案。

## 你要读的材料（都在本机）

1. `/Users/michael/projects/营地工具/vibehub/产品需求文档.md` —— 产品需求（最重要，通读）
2. `/Users/michael/projects/营地工具/vibehub/docs/research/prototype/*.txt` —— 已上线原型站三个页面的完整文案（admin 审核页 / student 个人看板 / collection 作品集合页）
3. `/Users/michael/projects/营地工具/vibehub/docs/research/prototype/tokens.json` —— 原型的设计 token（配色/字体）
4. 存量可复用资产（**读 README 与 docs/specs 即可，不要改这些仓库的任何文件**）：
   - `/Users/michael/projects/vibe-deploy/` —— 已有的「一句话部署到 VPS」skill（nginx/PM2/rsync 三档）
   - `/Users/michael/projects/营地工具/超脑上传平台/` —— 已有的自托管上传平台（token/workspace/provider 抽象，docs/specs/architecture.md 值得看）
   - `/Users/michael/projects/AI 工作流/vibecoding 工作台/` —— Vibe Workbench 人机交互层（会话/文档/参与者 magic-link/事件 webhook）
   - `/Users/michael/projects/AI 工作流/user-vibeloop/` —— VibeLoop 闭环框架（报障→分诊→修复→judge→分级合并）
   - `/Users/michael/projects/ai-game-camp-platform/` —— 营地 AI 中台（模型网关/模板服务/一键部署/助教）

## 已核实的硬约束（不要推翻，直接当事实用）

- **生产机**：腾讯云南京 Lighthouse `<南京机 IP，见 server-vault TC_NANJING_*>`，Ubuntu 24.04，**2 vCPU / 7.4 GB RAM / 79 GB 磁盘**，当前几乎空载。nginx 已在 80 与 8080 监听，certbot 已装，**443 当前没有监听**。
- **域名**：`supermind-ai.cn` 已解析到该机且 **80 端口能正常返回 200 → 域名已备案**（境内未备案域名 80/443 会被拦）。443 需要额外开通与配置。
- **该机已有多租户部署机制**：静态站 rsync 到 `/var/www/sites/<name>/` → `http://<南京机 IP，见 server-vault TC_NANJING_*>:8080/<name>/`；后端 rsync 到 `<backend 档部署账号>` + pm2 + 自助反代。
- **团队规模极小**（1 名主力工程 + 1 名顾问），**不要引入 k8s、不要引入重型微服务**。
- **用户是零基础学员**（含未成年人），作品要公开展示，发布前必须由老师审核。
- **统计**：已有自托管 umami（`statistics.superbrain-ai.com`）可复用。

## 你要产出什么

写一份 Markdown 文件到：
`/Users/michael/projects/营地工具/vibehub/docs/research/codebase/architecture-proposal-codex-sol.md`

必须覆盖以下 8 节，且**每节都要给出明确推荐 + 理由 + 你放弃的选项和放弃原因**：

1. **学员作品的承载形态**（最关键的架构分叉）——至少对比 3 条路线：纯静态站 / 静态 + 平台托管 BaaS（学员不写后端，只调平台提供的数据·文件·AI 接口）/ 允许学员部署任意后端进程（含沙箱隔离方案与成本）。给出在 2 vCPU 机器上、100~300 个作品规模下的可行性判断。
2. **URL 与域名方案**——泛子域名 vs 路径式，各自对小白体验、证书、备案、nginx 配置复杂度的影响。
3. **数据模型**——课程/活动、用户、邀请码、项目、域名、版本、部署记录、审核记录、AI 诊断报告的完整实体与关系（给出表结构，注明主键外键索引）。选型给出理由（SQLite / Postgres / 文件）。
4. **API 面**——按角色分组列出端点（学员端、管理端、公开端、Skill 端），标注鉴权方式。
5. **Skill 连接协议**——学员在自己的 AI 工具（Claude Code / Codex / WorkBuddy）里如何用邀请码换取凭证、绑定项目、发起提交与部署。给出握手时序与凭证生命周期。
6. **AI 诊断引擎**——诊断在哪里跑（学员端 / 服务端）、输入是什么、如何保证「百分比可被下方诊断项解释」（需求文档 §9.1.3 的硬要求）、如何避免用旧版本结论误导用户、成本估算。
7. **部署拓扑与安全边界**——平台自身、学员作品、预览环境三者的隔离；学员代码是 AI 生成的不可信代码，说明你的威胁模型与缓解措施。
8. **分期路线**——P0 / P1 / P2，P0 必须是「不做就开不了营」的最小集合，并给出 P0 的验收标准。

## 写作要求

- 事实与推测分开：不确定的地方明确写「待验证」，不要编造。
- 不要写空话套话，每个推荐都要能被质疑和反驳。
- 中文书写。
- 只写这一个文件，不要改本仓库或其他仓库的任何其他文件。
