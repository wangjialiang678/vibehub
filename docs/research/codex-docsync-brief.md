# Codex luna 任务：设计文档同步到路径式方案（docs/）

## 背景

Sol 审查发现（#14）：核心设计文档仍描述**已被创始人否决**的子域名架构，会误导后续实现和运维走错方向。第 1 轮决策（`docs/specs/decisions-r1.md`）已明确改为**主域路径式** + `hub` 独立控制台 origin，但架构/API/领域模型/基础设施文档还停留在旧方案。

**只改 docs/ 目录，不碰任何代码。** 这是文档订正，把文档跟已落地的实现和已拍板的决策对齐。

## 权威来源（真源）

以 `docs/specs/decisions-r1.md` 为决策真源，以 `server/src/`、`skill/bin/vibehub`、`infra/nginx/vibehub.conf` 的**实际实现**为契约真源。文档与实现冲突时，改文档去匹配实现，不要反过来。

## 逐文件订正

### docs/specs/architecture.md
- 顶部加一行醒目提示：「本文部分早期章节描述子域名方案，已被 decisions-r1.md 否决为路径式；以 decisions-r1.md 和实际实现为准。」
- §1 系统总览、§3 URL 与证书：把 `console.supermind-ai.cn` / `api.supermind-ai.cn` / `<slug>.works.supermind-ai.cn` / Host 推导项目 / 通配证书 / DNS-01，全部改为路径式实际方案：
  - 作品正式版 `supermind-ai.cn/vibehub/<username>/<projectname>/`
  - 预览 `supermind-ai.cn/vibehub/_preview/<pid>/`
  - 控制台+API `hub.supermind-ai.cn`
  - 普通证书（HTTP-01），**不需要**通配证书和 DNS-01
- §2.1b「作品里没有秘密」：补一句明确的威胁模型——**所有作品共享 supermind-ai.cn 这一个 origin，SDK 的 `vh:` 命名空间只是约定、不是安全边界；作品之间的 localStorage/IndexedDB/权限是共享的**。不要让读者以为作品已经互相隔离。
- 项目身份推导：删掉所有「由作品域名 Host 推导项目」的表述（那是子域名方案）。路径式下项目身份来自 URL 路径，且**服务端不得信任客户端自报的 header**。

### docs/specs/api.md
- 基址从 `console.supermind-ai.cn` 改为 `hub.supermind-ai.cn`
- §5 BaaS：删除「项目身份由 Host 推导」的旧表述
- **未实现的接口单独标注 `【规划中，当前未实现】`**，不要混在可调用的接口表里。当前确认未实现的：`POST /baas/v1/ai`（AI 能力）、`GET /baas/v1/:collection/:id`（单条读）、`GET /baas/v1/files/...`（文件读取）。以 server/src/routes/baas.js 的实际路由为准核对。

### docs/specs/domain-model.md
- §4 里的 `voice-map.vibe.page` 改为路径式示例 `supermind-ai.cn/vibehub/<username>/voice-map/`
- 发布原子切换那段（§2.6）：核对当前实现 `server/src/services/publish.js` 的实际 symlink 布局（是 `sites/<user>/<project>` 指向 `versions/<id>`），把文档里的 `current` 子链接表述改成与实现一致。

### docs/specs/PRD.md
- §8 开放问题表：决策 1-6、8 已拍板，把状态从「已提交工作台」更新为「已拍板，见 decisions-r1.md」，并填入结论。决策 7（首场）已定为 7/29。

### docs/research/infra-facts.md
- 「需要开通的运维项」表：删掉通配证书 / DNS-01 / 泛解析的表述，改为路径式所需的普通证书（supermind-ai.cn + hub.supermind-ai.cn 两个，HTTP-01）。443 仍是待办。
- 补记一条待验证：生产机 Node 版本是否 ≥ 22（服务用 node:sqlite，依赖 Node 22）。

## 交付标准

- 只改 docs/，不动代码
- 改完后，一个只读文档的新工程师不会再被引导去申请通配证书、按 Host 判项目、或以为作品已独立 origin
- 未实现的接口都带「规划中」标注
- 报告里列出你改了哪些文件、每处改了什么
