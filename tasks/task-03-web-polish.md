# 任务：学员端「提交记录」页 + 集合页作品排序/推荐位

## 背景

两个 P1 收尾项，都是纯前端 + 已有后端接口。原型侧边栏有「提交记录」入口但未实现；集合页需要老师能控制作品顺序和推荐位。

## 要做

### A. 学员端「提交记录」页 `/app/versions`
后端已有 `GET /api/projects/:id/versions`（返回每个版本的 label/summary/submitted_at/review 状态/诊断分数）。
- 对应原型侧边栏「提交记录」。做一个时间线/列表：每次提交的版本号、本次更新说明、提交时间、审核状态（待审核/已通过/已退回 + 退回意见）、诊断完成度。
- 学员侧边栏「提交记录」接上此页。
- 空状态（还没提交过）有友好文案。

### B. 集合页作品排序 + 推荐位
后端已有 `POST /api/camps/:id/collection`（排序与推荐位管理），数据表 `collection_entries` 有 `sort_order` 和 `featured`。
- 公开集合页 `GET /api/public/camps/:slug` 的作品按 `sort_order` 排序（featured 的排前/做大卡，对应原型第一个大卡）。若后端公开接口还没按 sort_order 返回，则需要小改公开查询（这一处允许改 server 的 public 路由排序）。
- 老师端集合管理：在老师端加一个简单的排序/推荐位设置入口（可以在项目列表页或集合页加"设为推荐/调整顺序"操作），调 `POST /api/camps/:id/collection`。

## 约束

- 不引入 UI 组件库，沿用现有设计 token 和原型风格（暖色浅底、细描边、大卡+小卡）。
- 不碰安全逻辑、不碰诊断逻辑。
- 后端改动仅限「公开集合页按 sort_order/featured 排序」这一处必要查询调整；其余用已有接口。

## 验收

- `cd web && npm run build` 通过；`bash scripts/loop-test.sh` 仍全绿。
- 学员端提交记录页渲染真实版本历史，四种审核状态都显示正确，无 console error。
- 集合页 featured 作品排在前/做大卡；老师能调整顺序。
