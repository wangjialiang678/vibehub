# AI 多项目提交闭环测试方案

日期：2026-08-15
范围：AI 自助创建多个作品、目录防串项目、AI 默认入口、一步复制、Skill 分发与生产发布

## 环境结论

- 项目类型：Fastify API + React/Vite Web + Node CLI，适合 P0/P1 闭环。
- Node：24.19.0，满足项目 `>=22`。
- 依赖：复用已安装的 server/web `node_modules`；功能本身无新增第三方依赖或 API key。
- 数据库：测试使用独立临时 SQLite；生产只在上线前在线备份后迁移。
- 前端：现有 Vitest 覆盖组件/行为；未安装 Playwright，真实浏览器剪贴板权限只做发布后人工抽查，不降低下面的确定性 API/DOM 判定。

## P0：每次集成必须全部通过

- [ ] 服务端完整测试
  - 判定标准：退出码 0，失败数 0。
  - 建议命令：在 `server/` 运行 `node --test test/*.test.js`。
- [ ] Web 完整测试
  - 判定标准：退出码 0，失败数 0。
  - 建议命令：在 `web/` 运行 `node node_modules/vitest/vitest.mjs run`。
- [ ] Web 类型与生产构建
  - 判定标准：TypeScript 和 Vite 均退出码 0，生成 `web/dist/`。
  - 建议命令：先重建 Skill 分发，再运行 `tsc -b` 与 `vite build`。
- [ ] Skill 分发完整性
  - 判定标准：版本为 1.0.1，固定七文件的字节数和 SHA-256 全部一致。
  - 建议命令：运行 `server/test/skill-installer.test.js` 和生成器。
- [ ] 补丁卫生
  - 判定标准：`git diff --check` 退出码 0；没有密钥、token、邀请码或无关工作区文件进入 diff。
  - 建议命令：`git diff --check`、`git status --short`、敏感词定向检查。
- [ ] GitHub CI
  - 判定标准：PR 的 Web 与 Server jobs 全绿；没有跳过必测 job。
  - 建议工具：GitHub Actions checks。

## P1：核心用户路径

### 1. 学生自助创建第二个项目

- [后端] 判定标准：学生 Skill token 调 `POST /api/skill/projects` 返回成功、新项目 owner/camp 与原项目一致、新 token 只访问新项目、旧 token 仍只访问旧项目。
- [后端] 判定标准：同一 `request_id` 重试或并发只产生一个项目；空/超长/控制字符标题和伪造 owner/camp/project/slug 不产生项目。
- [后端] 判定标准：老师、web session、已移出营地或跨营地身份得到统一权限失败。
- 建议命令：`node --test test/student-project-creation.test.js`。

### 2. 项目数量不占设备名额，撤销仍级联

- [后端] 判定标准：一个根 Skill token 派生多个项目 token 后设备数仍为 1；第二台真实设备仍按 `max_devices` 控制。
- [后端] 判定标准：撤销初始邀请码后，根 token 和全部项目派生 token 均返回 401。
- 建议命令：项目创建/鉴权专项测试与完整服务端回归。

### 3. 本地目录不会串项目

- [CLI] 判定标准：全局 active=A 时，B 目录的 preflight/upload 都使用 B token；A/B 分别提交后版本和审核记录分离。
- [CLI] 判定标准：多连接无 binding、binding 损坏/含敏感字段/缺 credential 时，在构建与网络前失败。
- [文件] 判定标准：`.vibehub/project.json` 不含 token/邀请码/姓名，凭证文件权限 0600，上传包不含 `.vibehub`。
- 建议命令：`node --test test/cli.test.js`。

### 4. 学生只复制一次且默认 AI

- [前端] 判定标准：学生提交页初始显示 AI；一个主按钮复制共享完整提示；内容包含官网 manifest/installer、校验、必要时 bind、创建/关联作品和立即 deploy；不要求第二句。
- [前端] 判定标准：网页上传仍可切换使用；老师通用说明只有一张 AI 推荐复制卡，每份学生明码只出现一次。
- 建议命令：运行 prompt、student-submit、install-page、student-submission-entries 四个 Vitest 文件。

### 5. 生产发布闭环

- [后端] 判定标准：上线前备份 `PRAGMA integrity_check` 为 `ok`；后端发布后 `/healthz` 200、无凭证创建接口 401。
- [文件] 判定标准：`/install`、manifest、installer 和七个文件均 200，线上字节数/SHA-256 全匹配，manifest 为 1.0.1，CLI help 含 project create/link。
- [端到端] 判定标准：隔离测试学生完成 `bind A → 创建 B → A/B 分别提交不同内容`，管理数据中同一 owner 两个项目且 versions/reviews 不串；撤销测试邀请码后 A/B 凭证都失效。
- 建议工具：受控 CLI、只读 SQLite 查询、HTTP 探针；测试产生的数据明确标记并保留审计，不直接删生产数据。

## 手动抽查

- 系统剪贴板权限：在真实浏览器点击“复制完整指令给 AI”，粘贴内容与页面展示一致。自动化已验证传给 Clipboard API 的精确字符串；浏览器权限弹窗属于人工环境检查。
