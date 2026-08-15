# 开发过程日志

## Round 0 — 2026-08-15 环境与基线

阶段：准备

### 验证结果

| 测试项 | 判定标准 | 实际命令 | 结果 |
|---|---|---|---|
| Node 运行时 | 版本满足 `>=22` | bundled Node `--version` | PASS（24.19.0） |
| 服务端基线 | 全部通过 | bundled Node `--test test/*.test.js` | PASS（217） |
| Web 基线 | 全部通过 | bundled Node `vitest.mjs run` | PASS（92） |
| Web 构建基线 | TypeScript/Vite 成功 | bundled Node 运行 tsc 与 Vite | PASS |
| CI 已知失败定位 | 与产品代码无关且有确定修复 | 临时 nginx 配置专项测试 | PASS（测试端口改 8443，生产配置未改） |

### 决策理由

- 原主工作区包含用户的上海营历史导入改动，因此在独立 worktree 和 `codex/student-ai-multi-project-mvp` 分支实现。
- 本机 shell PATH 不含 Node/npm，验证命令改用 Codex bundled Node 的绝对路径；判定标准不变。
- 工作区未安装 Playwright；前端确定性行为由现有 Vitest 组件测试覆盖，发布后补真实浏览器剪贴板人工抽查。

## Round 1 — 2026-08-15 MVP 集成

阶段：P0 + P1 自动化

### 验证结果

| 测试项 | 判定标准 | 实际命令 | 结果 |
|---|---|---|---|
| 服务端全量 | 失败数 0 | bundled Node `--test test/*.test.js` | PASS（233/233） |
| Web 全量 | 失败数 0 | bundled Node `vitest.mjs run` | PASS（92/92） |
| Web 类型与生产构建 | 退出码 0 | bundled Node 运行 `tsc -b`、Vite build | PASS（154 modules） |
| CLI/Skill 专项 | 目录绑定、分发契约全通过 | bundled Node 跑三个专项文件 | PASS（74/74） |
| 学生项目创建专项 | 创建、幂等、权限、撤销、A/B 隔离全通过 | bundled Node 跑创建专项 | PASS（10/10） |
| nginx CI 专项 | 不绑定特权端口且生产配置不变 | bundled Node 跑 security-config | PASS（4/4） |

### 失败与修复

- CLI 首轮新增测试复现多连接未绑定仍可能回退 active；实现目录 binding 后改为构建/联网前 fail closed。
- pending 创建首轮复现 active 切换后会换授权连接；把原连接指纹纳入不含秘密的 `request_id`，重试精确恢复原连接。
- 服务端首轮缺接口；后续补测并修复标题控制字符、撤销竞态和底层数据库错误泄露。
- Web 首轮命中旧的默认网页、双段复制和等待第二句行为；统一 builder 后专项与全量变绿。

### 修改范围

- 服务端：学生 Skill 项目创建、派生 token、幂等/限流/审计。
- CLI/Skill：project create/link、目录防串项目、1.0.1 分发说明。
- Web：AI 默认、一次式复制、老师单段转发。
- 文档/CI：研究、设计、实施计划、回滚备份与 nginx 测试端口。

## Round 2 — 2026-08-15 独立评审与主线合并

阶段：P0 发布门禁

### 评审修复

- 目录 binding 从其他目录复制时改为在构建和联网前 fail closed；只有显式 `project link` 才能把第二个本地目录登记到同一作品连接。
- 多连接创建作品时必须用完整连接标识明确 `--from`；`status`/`open`/`logs` 也按当前目录 binding 选准作品。
- binding、`.git`、gitdir pointer 和 exclude 路径补充符号链接、越界与原子替换保护。
- 幂等恢复改为原地轮换一枚项目 token，不累积凭证行；查询同时限定 parent/project，不同父连接不能互相重签。
- 单 token 撤销递归向下撤销派生树；邀请码设备数不再把派生项目 token 算成新设备。
- 新建参数采用 allowlist，`request_id` 必须以 `pc_` 开头；新增真实旧 SQLite schema 升级测试。
- 提示词明确校验 manifest 字节数和 SHA-256，先检查目录 binding，再创建/关联作品并立即部署。
- 发布手册改为数据库先备份，服务端切换后强制 restart + health/auth 探针，Skill 精确验证 1.0.1 与 create/link。
- 重复 bind 回包后重读本地连接，不覆盖联网期间刚完成的 `project link`；正式 binding 没有已验证路径时必须显式 link，不再静默认领。
- 项目创建锁用硬链接原子竞争、nonce/时间身份和先 rename 后比对的回收流程，关闭失效锁 ABA 竞态与 PID 复用永久阻塞。
- 网页会话每邀请码最多 10 行，淘汰时删除无派生关系的旧 web token，不让重复登录无限增长表。
- 失败提交回滚改用专用软链接删除，消除 Node 24 不同小版本对“指向目录的软链接”通用删除行为差异。

### 主线合并

- 合并 `origin/main` 的长期网页登录会话更新；`auth.js` 同时保留 cookie 滑动续期和项目 token 派生/撤销逻辑。

### 验证结果

| 测试项 | 结果 |
|---|---|
| 服务端全量 | PASS（合并最新主线后 261/261；前一稳定点连续 3 × 258/258） |
| Web 全量 | PASS（94/94） |
| Web 类型与生产构建 | PASS（154 modules） |
| CLI/Skill/安全配置 | PASS（94/94） |
| Skill 分发版本与清单 | PASS（1.0.1，7 文件） |
| 补丁格式与敏感信息扫描 | PASS |

早期并行评审在 Node 24.13 观察到 2 个提交回滚失败，而 Node 24.19 连续回归未复现。最终定位为软链接删除 API 的小版本行为差异，改用 `unlink` 后相同两条回滚路径与全量测试均通过。
