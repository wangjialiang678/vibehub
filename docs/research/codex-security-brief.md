# Codex terra 任务：安全核心修复（server / skill / infra）

## 背景

Sol 设计审查发现多个已确认为真、可复现的安全漏洞。Claude 已实测复现 #2 和 #6。
本任务修复其中**低成本、已确认、阻塞开营**的部分。

**只改 server/、skill/、infra/ 三个目录，不要碰 web/**（web/ 有另一个任务正在改视觉）。
不改 docs/（另有任务在同步文档）。改完 `cd server && npm test` 必须全绿，并为每个修复补负向测试。

参考完整分析：`docs/research/codebase/design-review-sol.md`。

---

## S1（最高优先级）BaaS 身份不可伪造 —— Sol #2

**已复现的漏洞**：`server/src/routes/baas.js` 的 `resolveProject` 优先信任客户端可控的 `x-vibehub-project` header。攻击者从任意作品/控制台伪造该 header 即可读、删任意项目数据；`?limit=-1` 因 `Math.min(-1,200)` 变成无限 LIMIT 读出整表；429 后每个请求仍同步写一行 `baas_calls`（写放大）。

**要做**：
1. **删除对 `x-vibehub-project` header 的信任**。项目身份只从 `Referer`/`Origin` 推导（同源下浏览器里的作品 JS 无法伪造 Referer；`fetch` 不允许脚本设置 Referer/Origin）。
2. 相应地，`server/src/runtime/sdk.js` 不再发送 `x-vibehub-project` header——靠同源 Referer 即可（作品与 BaaS 同源）。
3. **禁止匿名 DELETE**：删除记录需要身份（owner 的 skill token 或 web session，校验其 scope.project_id === 目标项目）。公开访客只保留 create / list / counter（营地场景需要访客能留言/上传，这是产品取舍）。
4. `GET` 的 limit **夹到 `1..200`**：`Math.min(Math.max(Number(limit)||50, 1), 200)`。
5. 达到 429 后**不再同步写 `baas_calls`**（避免写放大）。计数日志改为只记成功和真实失败，限流拒绝不逐条落库。
6. **记录/counter 加项目级上限并纳入配额**：单项目 baas_records 总字节上限（如 32 MiB）、collection 数量上限、counter key 数量上限（如 100）。超限返回人话错误。
7. `infra/nginx/vibehub.conf` 的 `/baas/` location 加防御性 `proxy_set_header X-Vibehub-Project "";`（即使有人从外部发也被剥掉）。

**验收**：补测试证明——伪造 `x-vibehub-project` 读不到别的项目；匿名 DELETE 被拒（需身份）；`limit=-1` 被夹到合法范围；429 不写 baas_calls。

---

## S2 敏感文件不泄露 —— Sol #6

**已复现的漏洞**：项目里的 `.env` 会被 CLI 打包，部署后 `.../vibehub/<u>/<p>/.env` 全网可读，密钥泄露。CLI 的 IGNORE 集合漏了 `.env`，服务端 unpack 不拒绝，nginx 不 deny dotfile。

**要做**：
1. `skill/bin/vibehub` 的 IGNORE 补齐：`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`id_ed25519*`、`*.pfx`、`*.p12`、`credentials.json`、`.npmrc`、`.git`、`*.log`、`.aws`、`.ssh`。
2. **服务端 `server/src/services/unpack.js` 独立复检**（不能信任客户端 ignore）：解包时拒绝上述敏感文件名与常见密钥文件，命中即记入 rejected。
3. **诊断加一个 secret-scan 检查项**（`server/src/services/diagnosis.js`）：若版本产物里存在敏感文件名或明显的密钥内容（`sk-`、`AKIA`、`-----BEGIN * PRIVATE KEY` 等），设为 **blocker**（`is_blocker: true`），并给学员人话提示「你的作品里包含了不该公开的密钥文件，请删除后重新提交」。
4. `infra/nginx/vibehub.conf`：作品与预览 location 增加 dotfile deny（`location ~ /\.(?!well-known) { deny all; }`），但保留 `.well-known`。

**验收**：补测试证明——带 `.env` 的包，服务端解包后 `.env` 不落盘（或被拒），且诊断标 blocker。

---

## S3 解包严格化 + 目录炸弹 —— Sol #7

`server/src/services/unpack.js` 当前只对 `entry.type==='File'` 计数，Directory 不计数——数十万空目录可绕过 5000 上限。危险条目（symlink/device）被静默跳过，但契约要求「含危险条目即 bundle_invalid」。

**要做**：
1. 目录也计入条目总数上限（总条目数 > 5000 即拒绝，含目录）。
2. node-tar 显式设 `maxDecompressionRatio: 100`（匹配文档承诺）。
3. 若 filter 过程中出现**危险条目**（symlink / hardlink / device / 可执行），不再静默跳过后成功，而是整包 `bundle_invalid` 抛 `UnpackError`。普通的"应排除文件"（node_modules/.env 等）仍静默跳过，只有危险条目才整包失败。区分清楚。

**验收**：补测试——全目录归档被拒；含 symlink 的包整包失败而非部分成功。

---

## S4 老师越权 IDOR + CSRF —— Sol #9

**漏洞 A（IDOR）**：`server/src/index.js` 的 `PATCH /api/projects/:id` 和 `GET /api/projects/:id/versions` 对 teacher/admin 未校验 `project.camp_id === req.auth.camp_id`——课程 A 的老师能改课程 B 的项目。同文件的 `GET /api/projects/:id` 反而有校验，是遗漏。
**要做**：这两个路由对 teacher 也补 `project.camp_id === req.auth.camp_id` 校验，越权返回 404。抽一个统一的 `assertProjectAccess(project, auth)` 函数，所有项目级路由都用它。

**漏洞 B（CSRF）**：cookie 鉴权 + 无 Origin/CSRF 校验，同站兄弟域可发起 mutation。
**要做**：给所有 **cookie 鉴权**的非安全方法（POST/PATCH/DELETE）加 Origin 校验——`Origin` 必须等于控制台 origin（`CONSOLE_ORIGIN`，本地放开 localhost）。**Bearer/CLI 鉴权的请求不受此限**（它们不靠 cookie，不受 CSRF 影响）。校验放在鉴权中间件里，按凭证来源区分。

**验收**：补测试——A 课程老师 PATCH B 课程项目返回 404；带 cookie 但 Origin 错误的 POST 被拒；带 Bearer 的同样请求正常。

---

## S5 诊断：空页不该拿满分 —— Sol #5（止血部分）

**漏洞**：空 `index.html`（无引用、无 SDK、无 flows、无占位词）拿 `(20+20+20+10)/70 = 100%`，摘要「已具备完整预览版本」。这对诚实申报形成逆向激励。

**要做**（P0 止血，不做完整重构）：
1. 加一个确定性检查项「首页有实际内容」：检查 index.html 的**非空可见文本长度**（去掉标签后）。过短（如 < 30 字）判 fail 且 **blocker**——一个空壳不应该是「可发布」。
2. `artifact_entry` 已是 blocker（无 index.html）；补充：index.html 存在但基本为空，也应显著扣分并进入 needs_work/blocked。
3. 确认权重：文档示例是 100，当前适用项满分可能是 110（含 core_flows 时）。这是**正常的**——applicability 决定分母，不同作品分母不同。但要确保 summarize 的阈值（85% 可提交）在不同分母下都合理。**不要**为了凑 100 而删维度。

> 完整方案（健康度 vs 验证覆盖率拆分、版本级 BaaS 证据、适用性由 policy 而非客户端决定）留 P1，本次只堵「空壳拿满分」。

**验收**：补测试——空 index.html 不再是 100%，且被标 blocked 或明显低分。

---

## 交付标准

- `cd server && npm test` 全绿，每个 S1–S5 都有对应负向测试
- 黄金路径仍跑通：bind → deploy → 预览 → approve → 正式地址 200
- **不放宽任何产品约束来让测试通过**
- 报告里逐条说明每个 S 改了哪些文件、怎么改、加了哪些测试；如果发现某条其实不是问题或有更好修法，写出来
