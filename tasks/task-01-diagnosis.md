# 任务：诊断改成「完成度 + 验证覆盖率」两个指标，修掉逆向激励

## 背景（Sol #5）

当前诊断把单一百分比叫「开发完成度」。问题：
1. **对诚实申报逆向激励**：学员不传 `--flows`，核心路径维度就从分母删除；诚实声明反而拿 0/20 拉低分数。于是"少报能力反而高分"。
2. 百分比其实是"学员申报了哪些维度 + 静态证据看到多少"，不等于"作品健康度"，叫「完成度」会误导。
3. 关键失败（入口缺失、主样式 404）应该直接 blocker，而不是只扣分。

## 要做

在 `server/src/services/diagnosis.js` 与相关前端（`web/src/pages/StudentPage.tsx`、`web/src/lib/presentation.ts` 及审核页）实现：

1. **拆成两个指标**，都由确定性检查器算、都可复算：
   - `completeness`（完成度）= 适用项 earned / 适用项 max（沿用现值）
   - `verified_ratio`（验证覆盖率）= 已 verified 的适用项数 / 适用项总数。回答"这个分数里有多少是平台真验证过的，多少还只是自报/待人工确认"。
   - API（`GET /api/skill/project`、`/api/projects/:id`、审核详情）都返回这两个值；学员看板和审核页都展示（验证覆盖率用小字或副指标，不喧宾夺主）。

2. **修逆向激励**：核心路径维度**不再因为没声明 flows 就移出分母**。改为：
   - 没声明 flows：该维度显示 `applicability: applicable` + `result: unknown` + `evidence_level: human_required`（"未声明·待人工确认"），计入分母、得 0 分。
   - 声明了 flows：同样待验证，但 evidence 里列出声明的 flows。
   - **声明 flows 只增加信息，绝不因此把维度移出分母来抬高分数。**

3. **关键失败直接 blocker**（部分已有，补齐）：入口 index.html 缺失、被引用的主样式/脚本 404（missing_ref 命中 .css/.js）→ `is_blocker: true`。

4. UI 文案：把「开发完成度」保留为主标题，但在其旁或下方明确"验证覆盖率 X%"，并保留既有的 stale/blocked 标记。

## 约束

- 分数仍由检查器算，模型不许碰（CLAUDE.md 硬约束）。
- 不适用项仍不进分母（纯展示作品的"服务端"维度仍 not_applicable）。这条不变——变的是"核心路径"从"没声明就 not_applicable"改成"没声明就 applicable+unknown"。
- 补足够的单元测试证明：不传 flows 的作品，核心路径计入分母且为 unknown；completeness 和 verified_ratio 都可复算。

## 验收

- `bash scripts/loop-test.sh` 全绿（含新增诊断测试）
- 不传 flows 的空壳作品不再因"移出维度"而虚高
- 学员看板同时显示完成度和验证覆盖率，无 console error
