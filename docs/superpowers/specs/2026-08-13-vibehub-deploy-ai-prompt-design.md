---
title: VibeHub Deploy AI 提示词安装设计
date: 2026-08-13
status: approved
audience: product, tech
---

# 目标

学生不再看到或复制终端脚本。VibeHub 官网 `/install` 只提供一段可直接粘贴给 WorkBuddy、Codex、Claude Code 或其他兼容 Agent 的自然语言；AI 负责识别电脑与 Agent、从 VibeHub 官方公开分发源安装 Skill、询问邀请码并在学生授权后部署网页游戏。

Skill 的展示名称统一为 **VibeHub Deploy**，技术标识为 `vibehub-deploy`。超脑 SkillHub 独立保存同一份 Skill 镜像，但官网、学生提示词和老师转发说明不提 SkillHub，也不要求学生获得团队口令。

# 学生体验

`/install` 的唯一主操作是“复制这段话给 AI”。复制内容是自然语言，不包含 shell、PowerShell、`curl`、`node` 命令或 npm。内容必须明确：

- Skill 名称是 VibeHub Deploy。
- 唯一公开安装来源是当前 VibeHub 官网的 `/downloads/vibehub-skill/` 分发根。
- AI 读取该目录的 `manifest.json` 和 `install.mjs`，由 AI 自己完成下载、完整性校验与安装，不让学生执行命令。
- AI 自动识别 macOS/Windows 和当前 Agent 的 Skill 目录；缺少 Node.js 20 时，由 AI 解释并协助安装。
- 安装后向学生询问个人邀请码，不猜邀请码或营地。
- 绑定后等待学生说“部署我的游戏”，再检查、过滤、提交并说明审核状态。

页面保留“直接网页登录提交”作为无需 Skill 的次要入口，但不再显示平台标签、终端代码块或复制命令按钮。

# Prompt 边界

新增一个纯函数作为学生页面和老师端的唯一提示词来源。通用版本使用 `CAMP-XXXX` 或要求 AI 询问邀请码；老师生成学员邀请码后，专属转发说明可把该学员自己的明码写入提示词。任何一段专属说明只能包含一个邀请码，不写入日志、持久化存储或 URL。

提示词只允许当前公开 origin；生产由 `VITE_PUBLIC_APP_URL`/浏览器 origin 生成，不硬编码深圳、上海或其他营地。提示词不出现 SkillHub、团队 token、内部地址或第三方下载源。

# Skill 命名与兼容

- `skill/SKILL.md` frontmatter name 改为 `vibehub-deploy`。
- `agents/openai.yaml` 和 SkillHub 中文展示名改为 `VibeHub Deploy`。
- 默认安装目录改为各 Agent 的 `skills/vibehub-deploy`。
- 现有命令行程序仍叫 `vibehub`，现有 API、凭证目录和绑定/部署语义不变。
- 老的 SkillHub 技术条目 `vibehub` 不删除，作为历史兼容；新版本发布为独立条目 `vibehub-deploy`。
- 官网公开分发路径暂时保留 `/downloads/vibehub-skill/`，避免已经复制出去的旧地址失效；名称变化不要求迁移 URL。

# 分发与 SkillHub

官网继续用现有 manifest、SHA-256 和在线安装器，自托管是学生唯一需要知道的来源。生成器和安装器随新技术名更新目标目录与白名单内容，现有安全限制不降低。

超脑 SkillHub 上传同一提交生成的 Skill 目录副本，技术名 `vibehub-deploy`、展示名 `VibeHub Deploy`。上传是发布流程的一项独立镜像动作；失败不改变官网安装能力，也不把 SkillHub 入口加入学生页面。

# 测试与验收

1. `/install` 渲染和源码都没有 shell/PowerShell 命令、平台切换、npm、SkillHub 或城市名；主按钮复制完整自然语言。
2. Prompt 包含 VibeHub 官方分发根、manifest、installer、AI 自行安装、询问邀请码和部署语义；不含团队凭证。
3. 老师端通用模板和每码说明复用同一 prompt builder；每码隔离、老师码隐藏继续成立。
4. Skill 安装测试验证 `skills/vibehub-deploy`、新 frontmatter、展示名和自托管 7 文件哈希；危险目录、回滚和在线安装测试保持全绿。
5. Skill 快速校验、前端测试、TypeScript、生产构建与完整服务端测试通过。
6. 生产 `/install` 与分发文件 200；干净临时 HOME 完成官网安装到 `vibehub-deploy`。
7. SkillHub 索引出现新条目 `vibehub-deploy`/`VibeHub Deploy`；旧 `vibehub` 仍存在；官网页面不出现 SkillHub。

