# AI 多项目提交设计

日期：2026-08-15
状态：已批准执行
范围：第一阶段 AI 自助多项目、AI 默认入口、一步式复制；第二阶段网页完整多项目

## 1. 目标

学生只需要最初的个人邀请码和自己的 AI 工具，就能在同一营地创建、连接并提交任意多个独立作品。老师不需要先在管理界面逐个建项目。

第一阶段必须同时解决三个问题：

1. AI 能为当前学生创建第二个及后续项目，并获得只属于新项目的凭证。
2. 不同本地目录与不同 VibeHub 项目稳定绑定，不能因为全局“当前连接”变化而把作品传错。
3. 学生只复制一次完整内容给 AI，AI 随后完成安装、绑定、识别新项目或旧项目、构建和提交。

网页直接上传继续保留，但学生提交页默认展示 AI 方式。第二阶段再加入网页内的项目列表、自助创建和切换。

## 2. 不采用的方案

### 2.1 把 Skill token 扩成同一学生全部项目可读写

不采用。任意一个项目 token 泄露都会扩大到该学生的全部作品、预览和 BaaS 数据。

### 2.2 每创建一个项目都要求老师生成第二个邀请码

不采用。它仍依赖老师界面操作，不符合本阶段目标。

### 2.3 继续只靠全局 `active` 连接

不采用。同一营地有多个项目时，AI 或学生很容易在错误连接下运行 deploy。

## 3. 总体架构

保持“一枚 token 只访问一个项目”的权限边界，但允许一个已经认证的学生 Skill token调用一个特殊的创建接口：

```text
原项目 token A
    │ POST /api/skill/projects { title, request_id }
    ▼
服务端验证同一学生/营地 ──事务──▶ 新项目 B + 派生 token B + 审计日志
                                      │
                                      ▼
~/.vibehub/credentials.json      项目目录/.vibehub/project.json
保存 token B（0600）              只保存 connection_key/project_id
```

普通项目读取、上传、预览、诊断和 BaaS 接口不放宽，仍只认 token 内单个 `project_id`。

## 4. 服务端设计

### 4.1 API

新增：

```http
POST /api/skill/projects
Authorization: Bearer <现有 Skill token>
Content-Type: application/json

{
  "title": "作品 B",
  "request_id": "pc_<随机幂等标识>"
}
```

只允许 `kind=skill`、`role=student`。服务端忽略并拒绝客户端自报的 owner、camp、project、slug。身份和营地全部取自现有 token。

成功响应：

```json
{
  "project": { "id": "p_xxx", "slug": "project-xxxx", "title": "作品 B" },
  "camp": { "id": "c_xxx", "slug": "game-camp", "name": "游戏营" },
  "token": "vhk_xxx",
  "message": "已创建并连接作品《作品 B》"
}
```

响应必须带 `Cache-Control: no-store`。token 只在本次响应返回，不能写日志。

### 4.2 创建事务

事务内依次执行：

1. 验证调用 token 对应用户仍是当前营地的 student 成员。
2. 验证调用 token 的当前项目仍属于同一 user/camp。
3. 规范化标题：去首尾空白、1–80 字、拒绝控制字符。
4. 根据 `owner_user_id + camp_id + request_id` 查幂等记录。
5. 首次请求生成随机项目 ID 和 slug，写入 project。
6. 写 `student_project_create` 审计日志。
7. 签发只绑定新项目的派生 Skill token。

网络失败后同一 `request_id` 重试时不得重复创建项目；允许重新签发该项目的派生 token。

项目总数没有累计上限。增加每名学生每分钟 5 次的短周期创建限流，只防误触和自动化刷库；幂等重试先于限流判断。

### 4.3 数据模型

为 `projects` 增加可空的 `creation_request_id`，并建立条件唯一索引：

```sql
CREATE UNIQUE INDEX ...
ON projects(owner_user_id, camp_id, creation_request_id)
WHERE creation_request_id IS NOT NULL;
```

为 `tokens` 增加可空的 `derived_from_token_id`：

- 邀请码直接 bind 的设备根 token 为 `NULL`。
- 新项目 token 指向调用它的 token。
- 派生 token 继承同一个 `invite_code`，因此老师撤销最初邀请码时会一起失效。
- `countDevices()` 只统计 `derived_from_token_id IS NULL` 的 Skill 根 token，创建多个项目不会被误算成多台设备。

迁移只增加列和索引，旧服务和旧 token 保持可读，不删除或重解释现有字段。

## 5. CLI 与目录绑定

### 5.1 命令

新增：

```text
vibehub project create --title "作品 B" [目录]
vibehub project link "<完整连接标识>" [目录]
```

`project create` 调用创建 API，把新 token 写入 HOME 凭证库并将新连接设为 active；随后为指定目录建立绑定。

`project link` 只能选择 HOME 中已经存在的完整 `connection_key`，不向服务端提交客户端自报的 project ID。

HOME 凭证库在每个连接下额外记录已绑定目录的规范绝对路径 `local_paths`。它只用于本机防止同一个连接被无意复用到不同作品目录，不上传服务端，也不包含邀请码、token 之外的新敏感信息；旧版凭证没有该字段时按空数组迁移。

### 5.2 目录文件

项目目录写入：

```json
{
  "version": 1,
  "connection_key": "game-camp:p_xxx",
  "project_id": "p_xxx"
}
```

文件位置为 `.vibehub/project.json`。这里禁止出现 token、邀请码、Cookie、真实姓名等敏感字段；检测到敏感字段时 CLI 立即停止且不回显内容。

token 继续只保存在 `~/.vibehub/credentials.json`，权限保持 0600。`.vibehub` 已被打包器排除；若目录属于 Git 仓库，再把 `.vibehub/` 写入本地 `.git/info/exclude`，不修改学生共享的 `.gitignore`。

请求创建前先将 pending 文件写成 `{ "version": 1, "pending_request_id": "pc_..." }`。若响应或本地保存中断，重试复用同一标识恢复，不重复创建项目；服务端成功、本地凭证保存成功后，再原子替换为正式绑定内容。

### 5.3 防串项目规则

deploy 在执行构建和网络请求前完成目标解析：

1. 有有效目录绑定：精确使用对应 credential，忽略全局 active。
2. binding 的 `connection_key/project_id` 与 HOME credential 不一致：立即停止，零构建、零网络。
3. 无 binding 且 HOME 只有一个连接，并且该连接还没有绑定其他本地目录：为兼容旧用户自动绑定。
4. 无 binding 且存在多个连接，或唯一连接已经绑定另一个目录：立即停止，提示 create 或 link，绝不回退全局 active。
5. 构建前输出目标营地、作品标题和项目 ID 短尾；不要求学生再手工确认。
6. 一次 deploy 的 preflight 与 upload 锁定同一个 credential，不受中途 `use` 影响。

`camps/use` 继续保留兼容，但新 Skill 工作流使用“作品连接”和目录绑定，不再让学生靠手工切 active 保证正确性。

## 6. 一次复制的 AI 流程

`buildVibeHubDeployPrompt` 成为安装页、学生提交页和老师转发文案的唯一 AI 内容源。完整内容包含：

- 官方分发根以及精确的 `manifest.json`、`install.mjs` 地址。
- 只允许使用官网分发源并校验字节数和 SHA-256。
- 自动识别 macOS/Windows 和 Agent Skill 目录。
- 未安装则安装，已安装则按清单更新。
- 未绑定时只询问一次原个人邀请码。
- 检查当前目录绑定；已绑定则提交新版本，未绑定则确认是新作品还是关联已有作品。
- 新作品调用 `project create`，已有作品调用 `project link`。
- 完成构建、敏感文件过滤、deploy，并报告“已提交待审、尚未公开”。

不把在线安装器的全部源码复制进剪贴板；提示词提供官方脚本的精确入口，AI 下载后按现有完整性链路验证，避免复制内容过长和脚本版本漂移。

学生提交页默认 `ai`，直接展示并复制上述完整内容，移除“先去安装页、再复制短句”的两步流程。网页上传 tab 保留为备用。

老师通用说明收敛成一张“AI 提交（推荐）”卡和一个复制按钮，网页备用地址放在同一段末尾。每个刚生成的邀请码仍保持“一名学生、一段内容、一个邀请码、一个复制按钮”。

Skill 版本从 1.0.0 升到 1.0.1，并重建官网自托管分发清单。

## 7. 第二阶段网页完整方案

第一阶段上线稳定后另开分支：

- `GET /api/me/projects` 分页列出本人项目。
- `POST /api/me/projects` 允许网页登录学生自助创建，不设累计上限。
- `POST /api/session/project` 校验 owner/camp 后轮换当前项目级 web session。
- 新增 `/app/projects` 作品列表和项目选择器。
- 保留 `/api/me.project_id`、`/app`、`/app/submit`、`/app/versions` 兼容旧前端。
- Skill token 仍不能借网页切换接口访问其他项目。

## 8. 错误与安全要求

- 跨学生、跨营地、非 student、web cookie 调用 AI 创建接口统一按权限边界返回 404。
- 创建失败不得留下孤儿 project、半写 token 或审计记录。
- 派生 token、原邀请码和完整请求头不得进入普通日志。
- binding 损坏、缺 credential、包含敏感字段时 fail closed。
- 项目 A/B 即使内容 SHA 相同，也只能在各自项目内判重。
- 撤销最初邀请码后，该设备派生出的所有项目 token 一起失效。

## 9. 测试与发布

### 9.1 自动化

- Server：创建、幂等、限流、派生 token 设备计数、撤销级联、事务回滚、跨权限 404。
- CLI：目录绑定、pending 恢复、敏感字段拒绝、多连接无绑定 fail closed、active 与目录不一致仍传正确项目、上传包不含 `.vibehub`。
- Web：默认 AI、统一 builder 精确复制、单一复制动作、网页备用 tab、老师单卡片和单邀请码文案。
- Skill：多作品决策说明、版本 1.0.1、分发文件字节数和 SHA-256。
- 回归：完整 Server/Web 测试、Web build、闭环测试。

### 9.2 GitHub 与生产

实现放在独立分支 `codex/student-ai-multi-project-mvp`，不混入主工作区尚未提交的上海营历史导入改动。

先修复 CI 中 nginx 测试在 GitHub runner 绑定 443 的权限型失败：只在测试临时配置把监听端口改成 8443，不修改生产 nginx 文件。

发布顺序：

1. PR 检查全绿并合并 main。
2. 用“UTC 时间戳 + commit SHA”备份 SQLite。
3. 部署后端新 release，验证旧邀请码、旧 token、旧单项目上传。
4. 构建并原子切换 Web/Skill 静态 release。
5. 验证 `/install`、manifest、install.mjs 和清单全部哈希。
6. 用隔离测试学生完成 `bind A → 目录 B create → A/B 分别 deploy`，确认审核队列同一学生两个项目且版本不串。
7. 验证撤销测试邀请码后全部派生连接失效。

服务端和控制台各保留上一 release；数据库迁移只做向后兼容加法。任一关键探针失败立即回滚代码软链，并依据上线前备份处理数据恢复。
