# 学员提交入口与发布准备代码审计

日期：2026-08-12
范围：VibeHub 当前工作区与生产环境只读检查

> **2026-08-13 后续结论**：本文下方保留 2026-08-12 当日快照，但其中“公开 npm 是学生 Skill 主渠道”的推断已被 [2026-08-13 自托管分发设计](../superpowers/specs/2026-08-13-self-hosted-skill-distribution-design.md) 取代，不应再按旧结论发布。

## 2026-08-13 实施后状态

- 学员已有网页和 AI 两条提交路径：网页路径接受 HTML、ZIP、网页文件夹和 tar.gz；AI 路径从公开 `/install` 安装 Skill。
- 学生 Skill 主渠道已改为 `VibeHub /install → VibeHub HTTPS 静态资源 → 完整性校验引导程序 → 现有本地安装器`。安装不要求 npm 账号、npm 包发布、SkillHub 口令或内部账号。
- macOS 与 Windows 在同一安装页获得各自的 shell/PowerShell 命令；下载引导程序只接受清单中的固定文件，并在执行前校验字节数和 SHA-256。
- 老师管理端的邀请码页会持续展示“网页登录提交”和“AI 助手部署”两份可复制说明；生成学员码后还可复制每人独立、只含一个明码的完整转发文案。
- 发布验收必须探测 `/install`、`/downloads/vibehub-skill/install.mjs`、`manifest.json` 及清单中的每个文件，并在本地重算字节数和 SHA-256；只看安装页返回 200 不足以证明分发链路完整。

## 已确认事实

- 邀请码登录会自动创建学员和项目，并把网页会话写入 HttpOnly cookie。
- 学员首页和提交记录页目前只有状态展示，没有“提交作品”按钮、文件选择或 AI 部署入口。
- 当前真实版本上传只有 `/api/skill/versions`；浏览器 cookie 已能通过同一套鉴权中间件访问，但前端 API 层没有上传方法。
- 现有上传链路已经覆盖 tar.gz 解包、路径与文件限制、敏感文件过滤、密钥扫描、私有预览、异步诊断和老师审核。
- 当前上传包只接受 tar.gz；普通学员更常持有单个 HTML、ZIP 或文件夹。
- 当日公开 `/install` 页面和跨平台 npm 安装器已经在本地实现；npm 包尚未发布，本机也没有 npm 登录凭证。这是 2026-08-12 的历史事实，不是当前发布前置条件。
- 超脑 SkillHub 的读写凭证已经配置，当前不存在同名 `vibehub` Skill。
- VibeHub 生产服务当前健康，`/install` 已可访问；预览泛域名的 DNS 查询未成功，需要在发布前修复和实测。

## 推断与设计含义

- 学员觉得“没有提交入口”不是文案误解，而是信息架构和功能入口真实缺失。
- 只增加指向安装页的按钮仍会排除不使用 AI 工具、已经有成品文件的学员。
- 直接让网页长期复用 `/api/skill/versions` 会导致接口语义和 `submitted_via` 记录错误，因此应抽取共享提交服务并增加网页接口。
- 当日推断认为 SkillHub 不适合作为学生安装的前置依赖，并曾提议公开 npm + VibeHub 安装页。其中“不依赖 SkillHub”仍然成立，“公开 npm”已由 2026-08-13 自托管方案取代。

## 关键代码位置

- 学员首页：`web/src/pages/StudentPage.tsx`
- 学员提交记录：`web/src/pages/StudentVersionsPage.tsx`
- 登录与邀请码：`web/src/pages/LoginPage.tsx`、`server/src/index.js`
- 当前上传路由：`server/src/routes/skill.js`
- 安全解包：`server/src/services/unpack.js`
- 前端 API：`web/src/lib/api.ts`
- 安装页：`web/src/pages/InstallPage.tsx`
- Skill 与安装器：`skill/SKILL.md`、`skill/bin/install.mjs`
