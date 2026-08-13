---
title: VibeHub 自托管 Skill 分发审计
date: 2026-08-13
status: current
audience: tech
---

# 结论

npm 登录只对发布 `@supermind/vibehub-skill` 这个第三方 registry 包必要，不是 VibeHub 部署 Skill 的运行前提。当前 Skill 运行文件已由固定白名单定义，既有安装器也已经覆盖 Codex、Claude Code、WorkBuddy、自定义目录、旧版备份、原子换入和失败恢复，因此可以改由 VibeHub 自己分发。

# 当前可复用能力

- `skill/bin/install.mjs` 从完整 Skill 目录安装五类运行文件，支持 macOS 与 Windows 路径。
- `skill/bin/vibehub` 与 `skill/lib/platform.mjs` 承担实际绑定、构建、打包、上传和预览动作。
- `/install` 已有平台识别、复制反馈、Node.js 帮助和三步使用说明。
- 控制台静态产物已经由 `hub.supermind-ai.cn` 通过 HTTPS 提供，生产发布保留版本 release 和回滚能力。

# 需要替换的 npm 耦合

- `/install` 依赖 `VITE_SKILL_INSTALL_COMMAND`，未配置时显示“即将开放”。
- 页面要求同时检查 `node` 和 `npx`。
- 服务端安装器测试用 `npm pack` 证明发布白名单。
- README、架构说明、部署手册和 2026-08-12 的设计/计划把 public npm 记录为学生主渠道。

# 推荐方向

构建控制台时按既有白名单生成公开 Skill 文件和带 SHA-256 的清单，再由一个跨平台 Node 在线引导器下载、校验并调用既有安装器。这样保留安全安装语义，同时让 VibeHub 成为唯一必需的分发入口；SkillHub 继续作为可选镜像。
