# 学员提交入口与发布准备代码审计

日期：2026-08-12
范围：VibeHub 当前工作区与生产环境只读检查

## 已确认事实

- 邀请码登录会自动创建学员和项目，并把网页会话写入 HttpOnly cookie。
- 学员首页和提交记录页目前只有状态展示，没有“提交作品”按钮、文件选择或 AI 部署入口。
- 当前真实版本上传只有 `/api/skill/versions`；浏览器 cookie 已能通过同一套鉴权中间件访问，但前端 API 层没有上传方法。
- 现有上传链路已经覆盖 tar.gz 解包、路径与文件限制、敏感文件过滤、密钥扫描、私有预览、异步诊断和老师审核。
- 当前上传包只接受 tar.gz；普通学员更常持有单个 HTML、ZIP 或文件夹。
- 公开 `/install` 页面和跨平台 npm 安装器已经在本地实现；npm 包尚未发布，本机也没有 npm 登录凭证。
- 超脑 SkillHub 的读写凭证已经配置，当前不存在同名 `vibehub` Skill。
- VibeHub 生产服务当前健康，`/install` 已可访问；预览泛域名的 DNS 查询未成功，需要在发布前修复和实测。

## 推断与设计含义

- 学员觉得“没有提交入口”不是文案误解，而是信息架构和功能入口真实缺失。
- 只增加指向安装页的按钮仍会排除不使用 AI 工具、已经有成品文件的学员。
- 直接让网页长期复用 `/api/skill/versions` 会导致接口语义和 `submitted_via` 记录错误，因此应抽取共享提交服务并增加网页接口。
- SkillHub 适合作为内部镜像，但不适合作为学生安装的前置依赖；公开 npm + VibeHub 安装页更符合跨营地、macOS 与 Windows 的目标。

## 关键代码位置

- 学员首页：`web/src/pages/StudentPage.tsx`
- 学员提交记录：`web/src/pages/StudentVersionsPage.tsx`
- 登录与邀请码：`web/src/pages/LoginPage.tsx`、`server/src/index.js`
- 当前上传路由：`server/src/routes/skill.js`
- 安全解包：`server/src/services/unpack.js`
- 前端 API：`web/src/lib/api.ts`
- 安装页：`web/src/pages/InstallPage.tsx`
- Skill 与安装器：`skill/SKILL.md`、`skill/bin/install.mjs`
