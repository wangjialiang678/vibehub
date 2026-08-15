# VibeHub 网页作品部署

本文件供读取 `AGENTS.md` 的 Codex、WorkBuddy 等工具使用，与同目录 `SKILL.md` 执行同一套规则。

帮助零基础学员把网页游戏交给任意使用 VibeHub 的营地。Skill 是通用的；营地、身份、作品和权限全部由邀请码决定，不要写死某个城市、课程或老师。

支持 macOS 和 Windows，要求 Node.js 20 或更高版本。解析当前 Skill 所在目录并调用：

```text
node "<skill目录>/bin/vibehub" <命令>
```

不要要求学员配置 alias。

## 职责边界

**AI 负责**判断与沟通：检查项目、理解玩法、推导更新说明和核心流程、解释诊断与老师反馈，以及在获得修改授权后复现、修复和验证作品问题。

**脚本负责**确定性和安全动作：兑换邀请码、创建或关联作品、保存目录绑定、保存及切换营地、调用 API、处理凭证、过滤敏感文件、构建、打包、上传、查询状态和打开安全预览。

不要自行猜测 API、拼接上传请求、读取或回显 token，也不要绕过脚本的敏感文件过滤。

## 连接与多营地

用户给出邀请码并明确要求接入时直接执行；没有邀请码时只询问邀请码：

```text
node "<skill目录>/bin/vibehub" bind <邀请码>
node "<skill目录>/bin/vibehub" camps
node "<skill目录>/bin/vibehub" use <连接标识>
```

绑定后报告服务端返回的真实营地和作品，不能根据邀请码前缀猜测。部署前目标作品不明确时，先列出并让学员选择完整连接标识。

## 确定新作品或已有作品

每个本地目录都必须绑定一个明确的 VibeHub 作品。脚本把目录绑定保存在 `.vibehub/project.json`，并自动写入当前 Git 仓库的本地 exclude。不要手动编辑、复制或提交目录绑定，也不要向其中写 token、邀请码、cookie、真实姓名等敏感信息。

- 目录已有有效绑定：视为已有作品的新版本，直接继续部署。
- 目录没有绑定，用户明确要新作品：先运行 `camps`。只有一个连接时可直接创建；多个连接时必须给 `project create` 传 `--from <完整连接标识>`，绝不能依赖 global active 猜营地。学生可以自助创建多个新作品，不设数量上限。
- 目录没有绑定，用户明确要更新已有作品：先运行 `camps`，再把完整连接标识交给 `project link`。不能只使用营地名，也不能依赖 active 连接。
- 新作品还是已有作品无法判断时，只问这一项。

```text
node "<skill目录>/bin/vibehub" camps
node "<skill目录>/bin/vibehub" project create --title "作品名" --from <完整连接标识> "<作品目录>"
node "<skill目录>/bin/vibehub" project link <完整连接标识> "<作品目录>"
```

创建中断时原样重试，让脚本复用 pending request_id；不要换目录或手工删除绑定。多连接时，未绑定目录必须停止，绝不能回退到 active 连接上传。

复制项目目录会连同 binding 一起复制，但新目录不会自动得到部署权限。遇到这种情况必须在构建和联网前停止；只有用户明确允许同一平台作品对应第二个本地目录时，才在新目录显式运行 `project link` 登记。

用户在同一条完整请求中已经给出安装、邀请码和部署要求时，安装、绑定、判断作品及上传属于一次连续授权：同一次请求中继续部署，不要索要第二段指令或再次确认。

## 部署流程

只处理浏览器可运行的网页游戏或静态网站，不处理 Unity、Godot 和应用商店发布。

先检查 `index.html`、`package.json`、构建脚本和游戏主要玩法。若项目已有测试或检查命令，按项目约定验证；不要擅自更换技术栈。不要将密码、密钥和私人信息写进网页。

用户明确说“部署、提交、交作业”即授权创建私密待审版本，不等于公开发布。用户只问“能不能部署”时只检查，不提交。

从项目和对话推导更新说明及核心操作；无法可靠判断时只问一个简短问题：

```text
node "<skill目录>/bin/vibehub" deploy --summary "本次更新说明" --flows "开始游戏,完成主要目标,重新开始"
```

脚本自动构建、选择产物、检查首页、过滤敏感内容并上传。完成后告诉学员“已经提交待审，还没有公开上线”。

## 状态、预览和退回

```text
node "<skill目录>/bin/vibehub" status
node "<skill目录>/bin/vibehub" logs
node "<skill目录>/bin/vibehub" open
```

`status`、`open`、`logs` 均按当前目录绑定选择凭证。先进入作品目录再执行；多连接且当前目录没有绑定时必须 fail closed，再用 `project link` 明确关联，不能读取 global active 对应的其他作品。

- 问是否上线时先运行 `status`，不要猜。
- 问退回原因时先运行 `status`，必要时运行 `logs`，不要先索取截图。
- 区分完成度、验证覆盖率、不适用项和需人工确认项。
- “看看问题”只诊断；“改好并重新提交”才修改、验证和重新部署。
- 预览只通过 `open` 打开，不传播带临时凭证的地址。

## 数据能力

作品需要少量数据或文件上传时，不要另写后端。页面会注入无需 import 和密钥的全局对象：

```javascript
await vibehub.save('scores', { player: '小明', score: 120 });
const scores = await vibehub.list('scores', { limit: 20 });
const url = await vibehub.upload(file);
const visits = await vibehub.counter('visits');
vibehub.storage.set('draft', { level: 2 });
```
