---
name: vibehub
description: Use when 用户要把网页游戏或静态网站接入、提交、部署、预览或上线到 Vibe Hub/VibeHub，或查询营地、邀请码、审核状态及老师退回意见。
---

# VibeHub 网页作品部署

帮助零基础学员把网页游戏交给任意使用 VibeHub 的营地。Skill 是通用的；营地、身份、作品和权限全部由邀请码决定，不要写死某个城市、课程或老师。

支持 macOS 和 Windows，要求 Node.js 20 或更高版本。解析当前 Skill 所在目录，用下面的形式调用随 Skill 附带的脚本；不要要求学员配置 alias：

```text
node "<skill目录>/bin/vibehub" <命令>
```

## 职责边界

**AI 负责**理解和沟通：

- 判断用户只是咨询、查看状态，还是明确要求提交。
- 检查项目结构，理解玩法和核心操作，发现并修复作品本身的问题。
- 从本次改动推导简短的更新说明，从实际玩法推导核心操作路径。
- 用学生听得懂的话解释诊断和老师反馈；需要修改时先复现，再修改和验证。

**脚本负责**不能靠猜的动作：

- 兑换邀请码、保存和切换营地连接。
- 调用 VibeHub API、携带凭证、过滤敏感文件、构建、打包和上传。
- 内容判重、状态查询、审核记录和安全预览。

不要自行猜测 API、拼接上传请求、读取或回显 token，也不要绕过脚本的敏感文件过滤。

## 操作流程

### 连接营地

用户已经给出邀请码并要求接入时，直接运行：

```text
node "<skill目录>/bin/vibehub" bind <邀请码>
```

没有邀请码时只问这一项。绑定后告诉学员实际连接到的营地和作品，不要根据邀请码前缀猜营地。同一套 Skill 可以连接多个营地：

```text
node "<skill目录>/bin/vibehub" camps
node "<skill目录>/bin/vibehub" use <连接标识>
```

执行部署前如果无法确定目标营地，先列出营地并让学员选择。

### 提交网页游戏

只处理浏览器可运行的网页项目，不研究 Unity、Godot 或应用商店发布。先做只读检查：

- 找到 `index.html`、`package.json` 和可能的构建脚本。
- 理解游戏的进入方式、胜负或目标、键鼠/触屏操作和声音要求。
- 若已有测试或检查命令，按项目约定运行；不要擅自更换技术栈。
- 不要把密码、API key、私人信息写入公开网页。

用户明确说“部署、提交、交作业”即授权创建一个私密待审版本；这不等于公开发布。若用户只是问“能不能部署”，只检查并说明，不要提交。

尽量从项目和对话中推导 `summary` 与 `flows`；只有确实无法判断时才问一个简短问题。随后运行：

```text
node "<skill目录>/bin/vibehub" deploy --summary "本次更新说明" --flows "开始游戏,完成主要目标,重新开始"
```

脚本会自动构建、寻找常见产物目录、检查首页、过滤密钥和无关目录、打包上传并进入老师审核队列。完成后明确告诉学员：已经提交待审版本，但还没有公开上线。

### 状态、预览与退回修改

```text
node "<skill目录>/bin/vibehub" status
node "<skill目录>/bin/vibehub" logs
node "<skill目录>/bin/vibehub" open
```

- 问“上线了吗”时先运行 `status`，不要猜。
- 问“老师为什么退回”时先运行 `status` 和必要时的 `logs`，不要先让学员复制反馈。
- 解释诊断时区分完成度、验证覆盖率、不适用项和需人工确认项。
- 用户要求“看看问题”时只诊断；用户明确要求“改好并重新提交”时，按反馈复现、修改、验证，再次部署。
- 预览只能通过 `open` 安全打开，不要复制或传播带临时凭证的地址。

## 平台数据能力

作品需要少量数据或上传文件时，不要让学员另写后端。页面会注入全局 `vibehub` 对象：

```javascript
await vibehub.save('scores', { player: '小明', score: 120 });
const scores = await vibehub.list('scores', { limit: 20 });
const url = await vibehub.upload(file);
const visits = await vibehub.counter('visits');
vibehub.storage.set('draft', { level: 2 });
```

不需要 import、密钥或额外配置。
