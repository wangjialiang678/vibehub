# 任务：未审核预览加访问控制，不再是永久公开 URL

## 背景（Sol #11）

版本预览地址 `/vibehub/_preview/<pid16>/` 现在**只靠不可猜的随机 id**，没有鉴权、过期或撤销。链接一旦通过聊天/截图/日志泄露，任何未登录浏览器都能看未审核内容。这跟"访客只能访问已审核正式作品"冲突。16 位随机能防枚举，但不是访问控制。

## 要做

让预览只对**该项目 owner 本人**和**本课程老师**可见。

1. **本地/生产统一经 Node 校验**：预览请求要携带身份（skill token 或 web session cookie），Node 校验其 scope 属于该预览对应项目的 owner，或属于该项目所在课程的 teacher/admin。校验不过返回 404（不泄露存在性）。
   - 本地 `server/src/index.js` 的预览 serve 路由加校验。
   - 审核页 iframe 嵌入预览时要能带上老师身份——注意 iframe 跨 origin 不自动带第三方 cookie。**可行方案**：给预览签发一个短期、绑定项目+身份的一次性 claim（query token 或 signed cookie），审核页/学员看板拿自己的会话向 `POST /api/previews/:pid/grant` 换取该 claim，再用带 claim 的 URL 加载 iframe。claim 短期有效（如 10 分钟）、绑定项目、可因版本 superseded/rejected 失效。
   - 生产 nginx：主域 `infra/nginx/vibehub-locations.conf` 的预览路径固定返回 404；`infra/nginx/vibehub-preview-server.conf` 用 `<pid>.preview.supermind-ai.cn` 独立 origin 代理回 Node。Node 校验 host/path、claim 与当前状态后再返回文件。

2. **预览生命周期**：版本被 `superseded` 或 `rejected` 后，其预览 claim 失效（正式版发布后旧预览不再需要开放）。

3. 学员 `vibehub status`/看板里的预览链接、审核页的预览，都走新的带 claim 流程，保证 owner 和老师仍能正常看，其他人 404。

## 约束

- 不要削弱正式作品的公开访问（正式版仍公开，这个任务只管**未审核预览**）。
- 不要引入重依赖；claim 用 server 已有的 token 机制或 HMAC 签名即可。
- CLAUDE.md 硬约束照旧（越权 404、错误人话）。

## 验收

- `bash scripts/loop-test.sh` 全绿，并**新增安全断言**：拿不到 claim 的匿名请求访问预览返回 404/401；owner 和老师能访问。
- 把这条断言也加进 `scripts/loop-test.sh` 的「安全回归」段（预览未授权访问被拒）。
- 审核页老师仍能在 iframe 里看到预览（不因鉴权而白屏）。

## 安全实现补充

- query claim 只用于交换路径专用的 host-only HttpOnly cookie；服务端随后 `303` 到删除 claim、保留其他 query 的同路径，交换响应不返回作品内容。
- claim 绑定签发 token id。每次文件访问重查 token 未撤销/过期、课程成员身份与角色仍有效，以及版本仍处于当前待审状态。
- HTTP 探测器维护内部 cookie，并从干净 URL 加载入口与资源；CLI 的 deploy/status/open 均不回显 bearer claim。
- 每个 `preview_id` 使用独立 origin 与 host-only cookie；服务端拒绝其他 preview origin 的请求并返回 `Cross-Origin-Resource-Policy: same-origin`，避免恶意作品沿同源路径读取另一个已授权预览。
- 应用请求日志不记录任何 query；预览 Nginx 虚拟主机关闭 access log 和会记录请求行的 error log。即使参数名经过编码或 upstream 故障，也不能把 claim 持久化。
- 邀请码撤销与该码签发 token 的级联吊销必须处于同一 SQLite 写事务；失败整体回滚，并发重复撤销保持幂等。
