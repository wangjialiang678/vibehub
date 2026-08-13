---
title: VibeHub 自托管 Skill 分发设计
date: 2026-08-13
status: approved-concept
audience: product, tech
---

# 目标

让学员在 macOS 或 Windows 上安装 VibeHub 网页作品部署 Skill，不依赖 npm registry，也不依赖超脑 SkillHub。学员不需要注册第三方账号；VibeHub 自己负责提供安装入口、版本清单和 Skill 文件。

网页直接上传继续作为无需安装的完整路径。Skill 是 AI 辅助部署路径，不是学生提交作品的前置条件。

# 已确认约束

- Skill 同时支持 Codex、Claude Code、WorkBuddy 和显式指定目录的其他兼容 Agent。
- 安装流程沿用现有的完整暂存、旧版备份、原子换入和失败恢复能力。
- Skill 仍由提示词负责判断与沟通，由脚本负责绑定、打包、过滤、上传和查询。
- 营地、城市、老师和作品不能写死在 Skill 中，全部由邀请码和服务端身份决定。
- SkillHub 只作为可选镜像；npm 不再出现在学生安装链路、安装页配置或发布验收中。
- Node.js 20 仍是 Skill 运行依赖；移除 `npx` 检查，不要求 npm 账号或 npm 登录。

# 方案比较

## 采用：VibeHub 静态自托管清单与文件

构建控制台时，从仓库 `skill/` 按固定白名单复制运行所需文件，生成版本清单和 SHA-256。Vite 把生成结果放入控制台静态产物，生产由 `hub.supermind-ai.cn` 直接提供。

优点：不新增第三方分发依赖；复用现有 HTTPS、控制台部署和回滚；文件白名单可测试；macOS 与 Windows 共用一个 Node 安装器核心。缺点：VibeHub 需要自己维护版本清单和安装探针。

## 不采用：GitHub Release

可以绕开 npm，但学生网络、仓库可见性和 GitHub 可用性会变成安装前置条件，且安装页仍依赖另一个外部平台。

## 不采用：只复制提示词、不提供脚本

实现最轻，但不同 Agent 会自行猜安装目录、下载文件和更新方式，无法稳定保证备份、校验和 Windows 行为。

# 分发结构

控制台构建前生成以下静态资源：

```text
/downloads/vibehub-skill/
├── install.mjs
├── manifest.json
└── files/
    ├── SKILL.md
    ├── AGENTS.md
    ├── agents/openai.yaml
    ├── bin/install.mjs
    ├── bin/vibehub
    └── lib/platform.mjs
```

`manifest.json` 只包含公开信息：schema 版本、Skill 版本、生成时间，以及每个白名单文件的相对路径、字节数和 SHA-256。生成脚本拒绝缺文件、额外路径、路径穿越和不合法版本。

`install.mjs` 是在线引导器。它通过 HTTPS 获取清单，将白名单文件逐一下载到系统临时目录，逐个校验大小和 SHA-256，然后调用下载到临时目录中的既有 `bin/install.mjs`。无论成功或失败，在线引导器都清理临时文件；目标目录的备份与原子换入仍由既有安装器负责。

安装器只接受固定 HTTPS origin 的清单和文件，不执行清单以外的内容，不读取邀请码，也不接触 VibeHub 登录凭证。

# 学员体验

公开 `/install` 页面提供三个入口：

1. **复制给 AI（推荐）**：复制一段固定提示，要求 Agent 打开 VibeHub 安装页、按当前系统执行官方安装命令，完成后使用邀请码加入营地。提示中不包含具体营地或真实邀请码。
2. **macOS**：复制一条命令，把官方 `install.mjs` 下载到临时目录后用 Node.js 执行。
3. **Windows**：复制一条 PowerShell 命令，完成同样的下载与执行。

平台标签切换时显示不同命令，不再让两个系统共用 npm 命令。页面只检查 `node --version`，并保留 Node.js 20 下载链接。安装完成后的下一步仍是：回到 AI 对话，说“使用邀请码加入 VibeHub 营地”。

网页上传入口保持不变，学生即使不安装 Skill 也能交作品。

# 更新与失败处理

- 每次控制台构建都从 Skill 源文件重新生成清单，避免手工维护副本。
- 生产先上传文件和在线引导器，最后更新 `manifest.json`，避免新清单指向尚未上传的文件。
- 在线安装遇到网络错误、非 2xx、大小不符或哈希不符时立即停止，不改 Agent 目录，并给出可操作中文提示。
- 下载成功但本地安装失败时，沿用现有安装器恢复旧版本。
- 线上保留前一个控制台 release；整体回滚控制台即可恢复上一份安装资源。

# 代码与文档影响

- 新增 Skill 静态分发生成脚本和在线引导器。
- 调整 `web` 构建流程，在 Vite 构建前生成自托管资源。
- 重写 `InstallPage` 的平台命令、复制给 AI 和排错文案。
- 将 npm 包内容测试改为自托管白名单、清单、哈希、在线下载、临时清理和安装回滚测试。
- 更新 README、架构说明、部署手册、旧设计的替代说明和生产验收清单。
- `skill/package.json` 可暂时保留为本地版本元数据，但不再用于公开发布；若实现时发现它只剩分发用途，再在独立变更中移除，避免无必要扩大本轮范围。

# 验证方案

1. **红灯**：先写测试证明当前安装页依赖 `VITE_SKILL_INSTALL_COMMAND/npx`，且不存在自托管清单、哈希校验和在线安装路径。
2. **生成器**：白名单精确、每个文件哈希可复算、缺文件和路径异常失败、生成结果不含密钥或仓库杂项。
3. **在线引导器**：真实本地 HTTP 服务覆盖成功安装、哈希错误、404、下载中断、临时目录清理和旧版本恢复。
4. **前端**：macOS/Windows 命令不同；可复制给 AI；不出现 npm、npx、SkillHub 或城市专属文案；无 Node 时有明确说明。
5. **全量**：服务端测试、前端测试、TypeScript、生产构建、Skill 快速校验全部通过。
6. **生产**：三个下载 URL 200；清单哈希与线上文件一致；在干净临时 HOME 完成一次 macOS 安装；对 Windows 命令做 PowerShell 语法与路径单元测试；安装页和网页提交入口 200。

# 验收标准

- 学员不登录 npm、不访问 SkillHub，也能从 `/install` 安装 Skill。
- macOS 与 Windows 都有明确可复制命令，推荐入口是“复制给 AI”。
- 自托管文件只来自固定白名单，下载后经过大小与 SHA-256 校验。
- 安装失败不破坏已有 Skill，不遗留包含完整 Skill 的临时目录。
- 安装完成后能执行现有 `bind`、`deploy`、`status` 和 `open` 流程。
- 网页直接上传始终可用，不因 Skill 分发失败而受影响。
