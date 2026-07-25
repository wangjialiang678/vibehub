# Codex 任务：VibeHub 后端补完（server/）

## 边界（先读，违反会造成冲突）

- **只改 `server/` 目录下的文件。**
- **`web/` 目录有另一个任务正在并行修改，绝对不要碰。**
- 不要改 `skill/`、`docs/`、`infra/`（发现问题写进最终报告，别自己动）。
- 后端已经跑通并验证过黄金路径，**这是补完不是重写**。先读 `server/src/` 全部代码再动手。

## 必读

1. `docs/specs/architecture.md` —— 尤其 §4.4 版本保留、§5 诊断流水线、§5.3b 无头浏览器的缓解措施
2. `docs/specs/decisions-r1.md` —— 已拍板的决策，不要推翻
3. `docs/specs/api.md` —— API 契约
4. `CLAUDE.md` —— 硬约束与「不要做的事」
5. `server/src/` 现有实现

## 任务（按优先级，逐项验收）

### T1（最高优先级）真实探测预览可达性 —— 修一个诚信 bug

**现状是错的**：`server/src/routes/skill.js:156` 硬编码 `previewOk: true`，导致诊断把
「预览地址能打开」这一项标成 `evidence_level: 'verified'` 并拿满 20 分，**但实际上从未探测过**。

这违反了产品的硬约束（`CLAUDE.md` 第 5 条、需求文档 §14.6）：**没验证过的东西不能标为已验证**。

**要做的**：实现真实探测，产出确定性事实：
- HTTP 状态码（入口页）
- 入口页引用的静态资源是否都能取到（4xx/5xx 列表）
- console error 条数与前 5 条内容
- 首屏可见内容量（`document.body.innerText.length`、渲染出的非空节点数）
- 可交互元素统计（button / a / form / input）
- **整页截图**存到 `versions/<id>/../_shot.png` 或数据目录下的 `shots/`，供学员看板的「现在的项目长这样」与审核队列缩略图使用

**技术选择由你定**，但必须满足 `architecture.md §5.3b` 的全部缓解措施：
- 独立低权限执行，不给 DB / SSH key / 云凭证的读权限
- **绝不使用 `--no-sandbox`**
- 硬超时 15 秒 + 内存上限
- 网络出口限制：只允许访问预览地址本身，**禁止访问内网段与云元数据地址 169.254.169.254**
- 串行队列（2 vCPU 上并发只会互相拖垮）
- **失败降级**：探测失败时该项记 `result:'unknown'`、`evidence_level:'human_required'`，**不阻塞提交与审核**

> 如果引入 playwright 会让部署变重，可以退一步：P0 先用 HTTP 探测（能拿到状态码与资源可达性），
> console error 与截图这两项记 `unknown`。**但不管选哪条，都不许再把没探测的东西标成 verified。**
> 你选了哪条、为什么，写进最终报告。

### T2 诊断异步化

现在诊断同步跑在提交请求里。加了 T1 的探测后会让 `vibehub deploy` 明显变慢。

改成：提交接口**立即返回预览地址**（这是产品要求，学员不该等进度条），诊断进队列异步跑。
- 诊断进行中时，`GET /api/skill/project` 与 `/api/projects/:id` 返回上一次结果 + `stale: true` 标记
- 队列串行，同一 `version_id` 去重（同时只有一个诊断任务）
- 诊断完成后再创建审核任务（现有逻辑是部署成功就建，保持"部署失败不建审核任务"这条不变）

### T3 磁盘配额、版本保留与清理

`architecture.md §4.4` 写了但**一行没实现**。一台机器被学员的图片塞满，超脑官网会跟着挂。

- 每个项目在磁盘上最多保留 **3 份可运行产物**：当前正式版、上一正式版、当前待审版。其余版本只留元数据与内容哈希，产物目录删除（`versions` 表记 `artifact_pruned=1`）
- 定时清理 `tmp/`（超过 1 小时的残留）
- 每项目磁盘用量统计 + 配额（默认 200 MB，超限时提交返回人话错误）
- 磁盘使用率超 80% 时 `/healthz` 返回 warning 字段并写 error 日志

### T4 诊断第三段：模型翻译

现在 `summarize()` 是模板文案。改成走模型，但**分数仍由检查器算，模型不许碰**。

- 模型走 `~/projects/ai-game-camp-platform` 的模型网关（OpenAI 兼容，`/v1/chat/completions`，别名 `camp-fast`）。该网关**已完整实现**（含未成年人安全过滤、按学员配额、用量计量），不要另建
- 输入 = 事实 JSON + 已算好的分数表；**不发送源码正文**，只发脱敏后的短证据
- 输出走 JSON Schema 校验：`{ summary, items:[{check_key, verdict}], next_steps:[1..3] }`
- **每条结论必须引用至少一个 `check_key`**，引用不上判为无效，重试一次，仍失败**退回模板文案**（不能让诊断因为模型挂了而失败）
- 模型不得修改 `earned_points` / `is_blocker` / `evidence_level` —— 校验层强制
- 每项目每天限 20 次结论生成，超出只更新事实与分数
- 网关不可用时静默降级到模板文案，记日志

### T5 管理端补全

`docs/specs/api.md §3` 列了但没实现的：
- `POST /api/projects/:id/suspend` / `resume`（下线/恢复已发布作品，下线后作品地址返回友好提示页而不是 404）
- `PATCH /api/projects/:id/visibility`（覆盖课程默认可见性）
- `POST /api/camps/:id/collection`（集合页排序与推荐位）
- `GET /api/camps/:id/invites/export`（导出 CSV 供老师线下分发，**要记审计日志**）

### T6 路由层测试

现在只有 `test/unpack.test.js`（8 项，全过）。补集成测试，用 `app.inject()`，不要起真实端口：

必须覆盖的行为（这些是产品承诺，回归了就是事故）：
1. 邀请码撤销后，该码签发的 token **立即** 401
2. 学员访问别人的项目返回 **404 而不是 403**
3. 重复 approve 同一个 review 返回 409，**不会二次发布**
4. reject 时 comment 为空返回 400
5. **被驳回后，`live_version_id` 不变**（线上旧版继续可访问）
6. 学员提交新版本时，同项目更早的 pending review 变成 `superseded`
7. 公开端返回体**不含**真实姓名（可见性非 realname 时）、诊断报告、审核记录、邀请码
8. `camp_only` 可见性的课程，公开端返回 404
9. 诊断的百分比 = 适用项 earned 之和 / 适用项 max 之和（可复算）
10. 不适用项**不进分母**，且不记为 0 分

## 交付标准

- `cd server && npm test` 全绿
- `node src/index.js` 能起来，`/healthz` 200
- 黄金路径仍然跑通：bind → deploy → 预览可打开 → approve → 正式地址 200 → 集合页出现
- **不许为了让测试过而放宽产品约束**（例如把"越权返回 404"改成 403）
- 最终报告里写清楚：T1 你选了哪条路线及原因、有没有发现现有代码的其他问题、有没有 API 契约与实现不一致的地方

## 风格

- 中文注释，只在"为什么这么做"值得解释的地方写，不写废话注释
- 面向学员的错误信息一律中文人话 + `hint` 下一步提示
- 不引入重型依赖；能用 Node 内置就用内置（现在用的是 `node:sqlite`，没有 better-sqlite3）
