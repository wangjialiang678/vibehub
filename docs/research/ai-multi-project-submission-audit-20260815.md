# AI 多项目提交代码审计（2026-08-15）

## 结论

VibeHub 数据层已经是 `user 1:N projects`，发布、审核和版本服务也都按 `project_id` 隔离；当前限制来自学生接入链路：一次邀请码绑定只创建一个项目，web session 和 Skill token 都固定到一个项目，且没有学生创建第二项目的 API。

第一阶段无需放宽现有项目鉴权。最小可上线方案是让已绑定学生的 Skill token 调用学生专用项目创建接口，由服务端在同一营地、同一 owner 下创建项目并返回新的项目级派生 token。CLI 现有凭证 v2 已以 `campSlug:projectId` 保存多个连接，只需补目录绑定和 create/link 命令。

## 代码证据

- `server/src/lib/db.js`：`projects.owner_user_id` 没有唯一约束，唯一约束是 `(camp_id, slug)`；`versions.project_id` 是一对多。
- `server/src/services/invite-access.js`：首次兑换邀请码时创建一个项目，之后同一码只重签该项目的 token。
- `server/src/lib/auth.js`、`server/src/routes/submissions.js`、`server/src/routes/skill.js`：学生凭证严格限制在单个 `project_id`，这是应保留的安全边界。
- `skill/bin/vibehub`：凭证库 v2 的 key 已包含营地 slug 和项目 id；当前 deploy 仍只读取全局 active，尚无目录级绑定。
- `web/src/pages/StudentSubmitPage.tsx`：提交页默认网页上传，AI 方式被拆成“先安装”和“再复制部署短句”两步。
- `web/src/lib/vibehubDeployPrompt.ts`：安装页和老师说明已有共用的官方分发提示词 builder，可作为一步式内容的唯一来源。

## 风险与约束

1. 新项目 token 不能被计为新设备，否则默认三台设备会变成三个项目上限。派生 token 应继承原邀请码撤销链，而设备数只统计邀请码直接签发的根 Skill token。
2. 同营地多项目时不能继续依赖全局 active；目录绑定损坏、缺凭证或多连接歧义时必须在构建和网络请求前停止。
3. 项目目录只能保存不可授权的连接标识；token 继续只留在 HOME 下 0600 的凭证文件。
4. 项目创建需要 `request_id` 幂等，避免网络中断重试生成重复作品。
5. “不限项目”是没有累计配额；短周期防误触限流不构成项目总数限制。

## 发布链核查

- Skill 公开分发由 `skill/distribution-files.mjs` 固定七文件白名单，再由 `skill/scripts/build-distribution.mjs` 生成字节数和 SHA-256 清单；不需要新的分发系统。
- GitHub Actions 最近一次服务端失败并非产品回归，而是测试临时 nginx 配置尝试绑定 443 导致 runner 权限错误。证据：[GitHub Actions run 31801709424](https://github.com/wangjialiang678/vibehub/actions/runs/31801709424)。修复应只把测试临时监听端口替换为 8443，不能改生产 nginx。
- 生产发布必须先备份 SQLite、再部署后端接口，最后切换包含新 Skill 的 Web 静态 release，避免新版 CLI 先于 API 上线。

## 采用方案

详细设计见 `docs/superpowers/specs/2026-08-15-ai-multi-project-submission-design.md`，执行清单见 `docs/superpowers/plans/2026-08-15-ai-multi-project-submission.md`。
