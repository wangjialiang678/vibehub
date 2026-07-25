# 设计审查（Codex Sol）

> 审查时间：2026-07-25（工作区并行开发快照） / 审查范围：产品需求、PRD、架构、领域模型、API、已拍板决策、基础设施事实、部署手册、nginx、Skill/CLI、`server/src` 与 `web/src` / 一句话结论：按当前快照，路径式网址没有形成作品间安全边界，诊断分数可以被空页或少报元数据拿到 100%，BaaS 可以跨项目读写删，发布状态存在可复现的失真和不可恢复窗口；这些问题没有解决前，不满足 7 月 29 日公开开营的最低门槛。

说明：

- 这是只读静态审查，没有修改或运行 `web/`、`server/`，也没有连接生产环境。工作区有其他任务并行写入，下面的“实现事实”以本次审查结束时可见文件为准。
- “事实”指由当前文档或代码直接推出；“推断”会明确标注。所有成本均为工程小时，不含外部账号、DNS、证书签发等待时间。
- 已采纳的“适用项才进分母、证据分级、blocker 与分数分离、版本保留”等原则不作为新建议重复；这里审查的是它们能否被绕过、是否真正落到了实现和界面。

## 严重问题（会导致开营失败、数据泄露或法律风险）

### 1. 路径式网址仍允许作品之间直接读取、篡改和持久污染

**问题描述（事实）**

正式作品、预览和超脑官网都位于 `https://supermind-ai.cn`。`hub.supermind-ai.cn` 只把控制台凭证移出了作品 origin，却没有隔离作品与作品、作品与官网。SDK 的 `vh:*` 前缀只是命名约定，不是访问控制：任意作品脚本仍可枚举或删除全部 `localStorage` 键、访问同源 IndexedDB/Cache Storage、加入已知 BroadcastChannel，并读写主域下非 HttpOnly 的 cookie。HTML 标准把这些能力明确列为同源带来的跨应用风险；Web Storage 也按 origin，而不是 URL path，划分存储。[HTML 同源风险](https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-objects)、[Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html)。

当前作品响应的 `frame-ancestors 'self' https://hub.supermind-ai.cn` 还明确允许一个作品用 iframe 嵌入另一个作品；同源后，父页面可以直接访问子页面 DOM。`infra/nginx/vibehub.conf:32-41` 的注释把 `frame-ancestors` 理解反了：它限制“谁能嵌入当前作品”，不限制“当前作品能嵌入谁”。

麦克风、定位等权限也通常以 origin 作为 permission key，不会以 `/vibehub/<user>/<project>/` 分开；浏览器仍可能叠加生命周期、用户激活等限制，但设计不能承诺每个作品获得独立授权。[Permissions 规范](https://www.w3.org/TR/permissions/#permission-key)。

Service Worker 需要精确表述：当前没有配置 `Service-Worker-Allowed`，所以某作品目录内的 worker 默认不能直接控制兄弟作品或根路径；不能声称它已能接管全站。但同源页面仍能枚举/注销同源注册、污染共享 Cache Storage 和耗尽 origin 存储额度。默认最大 scope 是 worker 脚本所在目录。[Service Worker scope](https://w3c.github.io/ServiceWorker/v1/#service-worker-script-response)。

**触发条件**

1. 发布作品 A，在其中执行 `const f=document.createElement('iframe'); f.src='/vibehub/victim/project/'; document.body.append(f)`。
2. iframe 加载后执行 `f.contentWindow.document.body.innerHTML='已被替换'`，或调用被嵌入作品暴露的全局函数。由于两者 origin 完全一致，浏览器不会触发同源策略拦截。
3. 在 A 中遍历 `localStorage.key(i)`，可读写 B 通过 `vibehub.storage` 写出的 `vh:*` 数据；打开已知 IndexedDB 数据库名或删除共享 Cache Storage，也没有 path 级边界。
4. 用户顶层打开 A 并授予麦克风/定位后，再顶层打开 B；B 不具备独立的 path 级授权边界，是否再次弹窗取决于浏览器，而不是 VibeHub。

**影响**

- 一个通过审核但带恶意或被注入脚本的作品可以劫持其他正式作品、删除草稿和离线数据、污染官网客户端状态。
- 预览也是主域同源代码；老师顶层打开未审核预览时，预审内容已经能攻击正式作品。
- 人工审核能降低概率，但不是隔离边界；“只展示昵称”也无法阻止作品数据互读。

**建议修法**

不改变公开路径的前提下，让该路径只返回可信 shell；原始学员产物始终在不含 `allow-same-origin` 的 sandbox 执行上下文中运行，存储、BaaS 和敏感权限由 shell 通过严格的 `postMessage` broker 提供，并把 `event.source`、项目和能力绑定。原始产物不能另有一个可顶层直开的逃逸 URL。

开营前的临时止血至少包括：从作品 `frame-ancestors` 删除 `'self'`、禁止扩大 Service Worker scope、主域官网所有身份 cookie 设 HttpOnly/Secure 且避免把敏感状态放前端存储、明确禁用尚未隔离的 PWA/SharedWorker 能力。但这些措施不能修复 localStorage/IndexedDB/权限共用，不能当成完整关闭。

**修复成本估计**

可信 shell、sandbox 资源交付和最小存储/BaaS broker：40–64 小时；录音、定位、下载、弹窗、ES module 与移动端兼容验收另需 16–32 小时。

### 2. BaaS 的项目身份由攻击者自报，跨项目读写删可直接复现

**问题描述（事实）**

`server/src/routes/baas.js:30-49` 优先信任客户端可控的 `x-vibehub-project`，其次信任 Referer；SDK 本身也在 `server/src/runtime/sdk.js:12-16` 发送这个 header。这和 `docs/specs/api.md:24-28` 的“绝不接受客户端自报 project”相反。

所有记录读、写、删除、计数器和文件上传都使用这样解析出的项目。公开匿名写是已知产品取舍，但“访客可向当前项目提交内容”不等于“访客可以选择任意项目并删除现有内容”。当前 DELETE 也完全匿名。

限流只按被自报的 project 计数。攻击者既可以耗尽受害项目的 60 次/分钟额度，也可以在不同受害项目间切换。超过额度后的每个请求仍向 `baas_calls` 写一行失败记录；因此达到 429 后继续发包仍会造成 SQLite 写放大。`GET ?limit=-1` 又会因为 `Math.min(-1, 200)` 变成 SQLite 的无限 LIMIT，一次读出整个 collection。

记录和 counter 还没有字节总额/key 数量限制，也没有计入 `projectDiskUsage`。当前允许每项目 10 万条、单条 64 KiB，理论上约 6.1 GiB JSON 数据，远高于项目 200 MB 文件/产物额度；随机 counter key 也可无限增表。

**触发条件**

从任何作品或浏览器控制台执行：

```js
const headers = {'x-vibehub-project': '/vibehub/victim/project/'};
const rows = await fetch('/baas/v1/sounds', {headers}).then(r => r.json());
await fetch('/baas/v1/sounds/' + rows.items[0].id, {method: 'DELETE', headers});
```

受害项目路径是公开网址，不需要猜内部 ID。把读取 URL 改成 `/baas/v1/sounds?limit=-1` 可绕过 200 条上限；持续请求则可占满受害项目令牌桶并持续写调用日志。

即使修掉 header 伪造，正常访问某项目后也可向它写满 10 万条接近 64 KiB 的记录，或不断创建随机 counter key；现有项目磁盘配额不会拦截这些 SQLite 字节。

**影响**

- 任意作品的数据可被读取、污染或删除，BaaS “项目命名空间隔离”实际上不存在。
- 城市声音、留言、位置等可能含用户生成内容；跨项目读取把内容审核和隐私责任扩大到整个平台。
- 恶意访客能让真实作品持续 429，或者用失败日志和大量 collection/counter key 消耗单机 SQLite 与磁盘。

**建议修法**

立即删除客户端 header 的权威性、禁止匿名 DELETE，并把列表上限夹到 `1..200`。限流至少使用 `来源 IP + 目标项目 + 操作类型`，429 不应每次同步写明细日志。给记录设置项目总字节、collection 数量和 counter-key 数量上限，并纳入全局磁盘 stop-write。

完整边界要承认“公开浏览器里没有秘密”：不能靠可见 token 证明请求来自某段作品代码。应由可信 shell/broker 固定目标项目；公开访客只获得按 collection/schema 配置的窄操作（例如 create/list），作者或老师身份才可 delete/clear/admin。若暂时不用 shell，至少把 BaaS 放到项目路径下并由 nginx 剥离外部同名 header、注入内部解析结果；这能去掉当前伪造入口，但仍不能阻止访客主动调用另一个公开项目允许的匿名操作。

**修复成本估计**

删除伪造入口、关闭匿名删除、修 LIMIT/日志限流及负向测试：6–10 小时；可配置的 collection 权限与可信 broker：16–32 小时。

### 3. 审核 iframe 获得了隔离，却因此无法验证 BaaS、存储和录音

**问题描述（事实）**

`web/src/components/Ui.tsx:33-40` 的 iframe sandbox 没有 `allow-same-origin`。这是正确的隔离方向，但 sandboxed 文档会得到 opaque origin；HTML 规范明确规定缺少 `allow-same-origin` 时被强制为不透明 origin。[iframe sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)。

后果是：

- SDK 带自定义 header 请求 `/baas` 时变成从 `Origin: null` 发往主域的跨源预检；`server/src/index.js:83-93` 不允许该 origin，调用失败。
- `localStorage`/IndexedDB/Service Worker 不可按正式作品方式使用。
- iframe 没有 `allow="microphone; geolocation"`，录音与定位也无法代表最终体验。

**触发条件**

提交一个在页面加载后调用 `vibehub.save()`、`vibehub.storage.set()` 并通过 `getUserMedia()` 录音的“城市声音地图”。在 Student/Admin 页面内嵌预览中依次操作：BaaS 请求预检失败，本地存储失败或被 SDK 静默吞掉，录音权限不可用；点击“查看预览”顶层打开时又会成功并进入问题 1 的不安全同源环境。

**影响**

老师看到的“真实预览”不是正式作品的运行环境。旗舰路径最关键的上传、播放、存储、录音无法在发布闸门内验证，老师可能批准一个只在顶层才能运行、同时又没有隔离的版本。

**建议修法**

不要简单加入 `allow-same-origin`，否则 sandbox 在同源作品上基本失去隔离价值。把正式页和审核页统一到问题 1 的可信 shell + broker 协议；按作品声明显式委托麦克风/定位，并在审核页展示“当前获准能力”和真实失败。短期若做不到，审核 UI 必须醒目标注“此窗口不能验证数据、存储、录音与定位”，并要求从隔离的测试环境做人工验收，不能称“真实预览”。

**修复成本估计**

BaaS/存储 broker 8–16 小时；录音/定位委托和移动端验收 8–24 小时。

### 4. “自动处理子路径”覆盖不完整，SPA 深链还会回退到官网

**问题描述（事实）**

`server/src/services/unpack.js:113-161` 只改写 HTML 的 `href/src` 和 CSS `url()`，不会处理 `fetch('/x')`、动态 import、`srcset`、`form action`、manifest、BrowserRouter basename 或 Service Worker URL。传入的 `basePath` 没有被使用；注入 `<base>` 也不会改变以 `/` 开头的根相对 URL。

更严重的是，`infra/nginx/vibehub.conf:32-34` 的最终 fallback 是 URI `/index.html`。内部重定向后会落入主域 `location /` 与 `/var/www/supermind/index.html`，而不是当前项目的 index。预览 location 有同样问题。

诊断还会放过这一类失败：`collectFacts` 对 `clean.startsWith('/')` 直接跳过，HTTP probe 又拒绝探测 preview base path 之外的 URL。一个不存在的 `/missing.js` 因而可能完全不出现在失败项中。

**触发条件**

1. 发布含 `fetch('/data.json')` 或 `navigator.serviceWorker.register('/sw.js')` 的页面；请求会命中超脑官网根路径，而不是作品目录。
2. 发布 BrowserRouter 应用并访问 `/vibehub/u/p/settings`；项目没有该实体文件时，nginx 内部 fallback 到官网 `/index.html`。
3. 在首页写 `<script src="/missing.js"></script>`；解包器因目标不存在不改写，静态诊断跳过绝对路径，HTTP probe 也不离开预览目录，仍可把“引用文件都在”和“预览可访问”判为通过。

**影响**

常见 AI 生成的 SPA、动态数据请求和 PWA 在正式路径下随机串站或白屏；第 3 个触发条件还会同时制造“高分坏站”。这不是靠继续增加正则就能完全解决的通用代码转换问题。

**建议修法**

为 nginx 实现项目专属的 index fallback，不得内部跳转到官网根。把支持契约收窄为“相对资源 + HashRouter 或明确 basename”；部署前扫描根相对 URL、manifest、BrowserRouter 和 worker 注册，无法安全改写时直接给学员可操作的错误，不再承诺自动修复全部绝对路径。诊断必须把根相对引用按作品语义解析并探测。

**修复成本估计**

nginx fallback 与回归用例 3–5 小时；契约扫描、错误文案和主流构建产物验收 8–16 小时。

### 5. 诊断分数奖励少报能力，空页和坏版本都能拿 100%

**问题描述（事实）**

当前六项权重总和是 110，不是文档示例的 100。更关键的不是总和，而是谁决定适用性：

- 学员不传 `--flows`，核心路径就从分母删除；一旦诚实声明，P0 永远给该项 0/20。
- 是否使用 BaaS 由脆弱正则 `vibehub.(save|list|upload|counter|ai)` 和项目近 30 天调用决定。别名、解构、动态属性或直接 `fetch('/baas/...')` 可绕过正则。
- BaaS 证据按整个项目近 30 天及全部现存记录统计，不绑定待审版本；旧版本或攻击者制造的调用可给新坏版本加分。
- HTTP probe 不执行 JS，不验证可见内容、交互或 Content-Type。

界面又进一步消解了已采纳的安全语义：Student 类型与组件不展示 `stale`、报告版本、完成时间或醒目的 `blocked`；Admin 摘要只找第一个前端项与 BaaS 项，不展示总分、blocker 和完整失败。CLI 也不显示 stale/blocker。

**触发条件**

1. 只提交一个空的 `index.html`，不引用资源、不用 SDK、不传 flows、没有占位词。HTTP 返回 200 后得分为 `(20+20+20+10)/70 = 100%`，摘要是“已具备完整预览版本”。
2. 一个真实使用 BaaS 且有核心流程的新版本，在诊断前尚无运行时调用；诚实传 flows 时得 `(20+20+20+0+0+10)/110 = 64%`。删除 flows 并把 SDK 调用改成别名，可以把两项移出分母，反而接近或达到 100%。
3. v1 在过去 30 天已有成功 BaaS 调用和记录；提交 BaaS 已坏的 v2，但保留能命中正则的字符串。v2 会继承 v1 的项目级证据，BaaS 项最高拿满 20。
4. 提交问题 4 的 `/missing.js` 空壳页面；两个检查器都跳过该资源，仍可能给出高分。
5. v1 有完成报告，刚提交 v2 后立刻打开页面或运行 `vibehub status`；后端返回 `stale=true` 的旧报告，网页和 CLI 不显示 stale，用户会把 v1 分数当成 v2。

**影响**

分数不是“作品健康度”，而是“学员选择申报哪些维度后，检查器看到了多少容易验证的静态证据”。它对诚实申报形成逆向激励，且能在老师决策界面隐藏 blocker。把它叫“开发完成度”会误导学员和老师。

**建议修法**

开营止血方案是暂时隐藏百分比与“可提交/可发布”综合结论，只展示版本绑定的事实、未验证项和 blocker。

正式方案把“健康度”和“验证覆盖率”拆成两个值；适用性由课程模板/老师 policy 决定，客户端声明只能增加待验证项，不能删除分母。BaaS 台账增加 `served_version_id/preview_id/release_generation`，只采集当前版本证据。入口脚本、唯一主样式、根相对资源等关键失败直接 blocker。网页与 CLI 强制显示报告版本、生成时间、stale、blocked 和“诊断不是安全审核”的边界说明。

**修复成本估计**

隐藏误导性百分比并补 stale/blocker UI：3–6 小时；重做适用性、版本级证据和回归样例：12–24 小时。

### 6. `.env` 会被 CLI 打包并由正式网址直接公开

**问题描述（事实）**

`docs/specs/architecture.md:188-193` 承诺排除 `.env` 和 `*.log`，但 `skill/bin/vibehub:45-78` 的默认忽略集合不包含它们；服务端解包也不拒绝 `.env`，诊断没有 secret scan。nginx 会把版本目录作为静态文件直接提供。

此外，`bundle_sha` 是重写和 SDK 注入前的 tgz 哈希，真正被 serve 的目录随后发生变化；该哈希不能证明线上字节是什么，也无法支撑“版本产物不可变且可审计”的承诺。

**触发条件**

在含 `index.html` 和 `.env` 的普通项目根目录运行 `vibehub deploy`，其中 `.env` 写 `API_KEY=...`。部署后访问 `https://supermind-ai.cn/vibehub/<u>/<p>/.env`；nginx 不拒绝 dotfile，会返回文件字节。即使诊断得 100%，也没有任何检查项报警。

**影响**

上游 API key、数据库 URL、Webhook token 或个人信息会成为全网公开文件。手册又把作品挂在备案主体下，这同时是密钥泄露和运营/合规事件。

**建议修法**

CLI 默认排除 `.env*`、私钥、凭证目录、日志和常见云配置；服务端必须独立复检，不能信任客户端 ignore。命中高置信 secret 或敏感文件名时整包 quarantine 并提示立即轮换，不能只是跳过后继续发布。nginx 增加 dotfile deny（保留必要的 well-known 例外）。在所有重写和注入后重新计算 served artifact manifest/hash，并把原包 hash 与 served hash 分开保存。

可参考 OWASP 对上传文件的扩展名/内容校验、授权、大小限制和隔离存储要求。[OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)。

**修复成本估计**

CLI/服务端敏感文件阻断、nginx deny 和测试：4–8 小时；基础 secret scanner、隔离与双 hash：8–16 小时。

### 7. 解包仍可被“全是目录”的归档绕过 5000 条上限

**问题描述（事实）**

当前锁定 `tar 7.5.22`，`preservePaths:false` 且 filter 拒绝 link/device，不能把旧版 node-tar 的通用路径逃逸当成当前漏洞。该版本默认还有最大深度 1024、meta entry 1 MB、解压比 1000 的保护。[node-tar README](https://github.com/isaacs/node-tar#readme)。

剩余问题在 VibeHub 自己的规则：`safeExtract` 只对 `entry.type === 'File'` 增加 `fileCount` 和 `totalBytes`，Directory 条目不计数。文档要求的是“条目数 > 5000”与“压缩比 > 100:1”，实现却依赖库默认 1000，且不限制总路径字节、单路径长度、大小写/Unicode 归一化碰撞。危险特殊条目被静默过滤后整包仍成功，也和“含危险条目即 bundle_invalid”契约不一致。

**触发条件**

制作一个含数十万空目录、一个正常 `index.html` 的高压缩率 tar.gz；空目录不会增加 VibeHub 的 `fileCount` 或 `totalBytes`，node-tar 会逐一 mkdir，直到库的更宽松解压比/深度保护或宿主资源先触发。另一个可复现差异是加入 hardlink/device 条目和正常首页：危险条目被记入 `rejected`，但调用方丢弃该字段，版本仍可发布。

**影响**

已绑定学员可以用很小上传包制造大量 inode、磁盘操作和 CPU 消耗，拖慢同机官网与 VibeHub。静默接收部分被篡改的包还会让学员以为提交内容完整。

**建议修法**

在写盘前做一次只读 manifest pass，统计所有条目、header 展开字节、路径深度/长度、规范化后的冲突和压缩比；任一特殊条目或碰撞直接整包失败。把 node-tar 的 `maxDecompressionRatio` 显式设为文档承诺的 100，并把目录也计入 5000 条。再保留当前落盘时的第二层检查。

**修复成本估计**

4–8 小时，另加 2–4 小时构造目录炸弹、超长路径、Unicode/大小写碰撞和特殊条目的回归样例。

### 8. 邀请码只有约 20 bit，且兑换入口无限流

**问题描述（事实）**

邀请码后缀是 31 字符字母表中的 4 位，即 `31^4 = 923,521` 种，约 19.8 bit。课程前缀由公开 camp slug 的字母生成，通常可知。`POST /api/skill/bind` 没有 IP、前缀或全局限流，且不存在/撤销/过期/设备已满返回不同错误。

绑定成功会立即返回长期 token；token 默认没有 `expires_at`。因此“邀请码即身份”在实现上等于一个可在线穷举的短密码。

**触发条件**

对已知前缀（如 `CAMP-`）遍历 4 位后缀并 POST `/api/skill/bind`。假设有 30 个有效码，随机请求平均约 `923,521/30 ≈ 30,784` 次即可撞中一个；成功响应直接包含该学员的 token、项目和课程信息，无需第二因素。

另一个开营故障：同一学员在同一浏览器登录/退出三次，或重复执行三次 bind。每次都会新建 token，`countDevices` 实际数的是未撤销 token 行，logout 只清 cookie、不撤销 token；第四次会永久触发设备上限。当前又没有单设备撤销接口。

**影响**

攻击者可冒名提交或覆盖学员待审版本；正常学员也会因重复登录在开营当天被锁死。给“新邀请码”会创建新的身份/项目，原作品归属无法自动恢复。

**建议修法**

邀请码至少使用 128 bit 随机值；若必须人可读，可显示更长分组码或用一次性短码换高熵链接。bind 加每 IP、每前缀、失败指数退避和告警，但限流不能替代熵。设备使用稳定 device ID 做 upsert；Web session 不占 Skill 设备配额；logout 撤销当前 Web token；补设备列表、单设备撤销和邀请码轮换但保留原 user/project 的恢复流程。

**修复成本估计**

高熵码、限流与兼容迁移 4–8 小时；设备/session 生命周期 8–16 小时。

### 9. 老师控制面存在长期 token 泄露、同站 CSRF 和跨课程 IDOR

**问题描述（事实）**

有三条独立触发路径：

1. `server/src/seed.js:22-36` 生成无过期老师 token；`web/src/pages/AdminPage.tsx:11-22` 从 `?token=` 读取它，再由 JavaScript 写成缺少 HttpOnly/Secure 的 cookie。第一次访问的完整 query 会进入 nginx access log、浏览器历史/诊断系统；任何读到日志的人都得到长期老师身份。这和 API 文档承诺的 HttpOnly/Secure cookie 相反。
2. Cookie 是 host-only + SameSite=Lax，但作品与 hub 仍属于同一个 schemeful site。CORS 只禁止恶意页面读取响应，不会阻止 simple mutation 请求到达服务端；代码没有 Origin 校验或 CSRF token。SameSite 的 site 边界不是 origin 边界，存在不可信兄弟子域/主域时不能替代 CSRF 防护。[OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#samesite-cookie-attribute)。
3. `PATCH /api/projects/:id` 和 `GET /api/projects/:id/versions` 把任意 teacher/admin 当作全局老师，未校验目标 `project.camp_id === token.camp_id`；同文件的 GET 项目接口反而有 camp 校验，说明这是实现遗漏。

**触发条件**

- 老师按预期打开 `/admin?token=vhs_...`；检查 nginx 默认 access log，可以看到完整 token。复制该 URL 或日志中的 token 到另一浏览器即可取得老师权限。
- 老师登录 hub 后顶层打开恶意作品；作品对一个已知邀请码或项目 ID 发送 `fetch('https://hub.supermind-ai.cn/api/...',{method:'POST',mode:'no-cors',credentials:'include'})`。响应不可读，但撤销、下线等 mutation 已执行。已知 ID 可来自学员自己的 bind/deploy 记录或老师误发链接。
- 持课程 A 的 teacher token，枚举或从日志得到课程 B 的 project ID，调用 `PATCH /api/projects/<B>` 修改标题/封面，或读取 `<B>/versions`；当前条件允许。

**影响**

老师身份一旦泄露可以审核发布、下线、导出全部邀请码；跨课程授权边界形同虚设。作品挂在备案主体下时，这会直接变成未授权发布和内容处置责任。

**建议修法**

取消 query token 和 seed token 作为生产登录方式；用一次性、短时、从 URL 立即兑换为 `__Host-` HttpOnly/Secure cookie 的 bootstrap，长期 token 只存 hash 并支持老师级吊销。所有 cookie 鉴权的非安全方法同时校验 `Origin === https://hub.supermind-ai.cn` 和 CSRF token；Bearer/CLI 走独立策略。把 camp membership 校验做成统一授权函数并为所有 teacher 路由建立授权矩阵负向测试。

**修复成本估计**

Origin/CSRF 与两处 IDOR 止血 4–8 小时；可靠老师登录、一次性兑换与吊销 12–24 小时。

### 10. 五维状态机会进入“已停用却重新公开”和“审核通过却没有发布”的坏状态

**问题描述（事实）**

五个维度在文档中是分开的，但实现把它们互相覆盖：

- 项目被 suspend 后，只要学员提交新版本，`server/src/routes/skill.js:156-160` 就把 `publish_status` 改成 `published_with_pending`；驳回又改成 `published`，批准会切真实内容并改成 `published`。普通提交/审核流程绕过了显式 resume。
- 提交成功立即把 `dev_status` 设为 `submittable`，但领域模型要求“部署成功且诊断非 blocked”；后续 blocked 不会收回这个状态。
- approve 先把 review 写成终态 approved，再切 symlink，最后才更新 project 和 deployment，没有事务、`publishing/publish_failed` 或启动对账。
- 诊断完成后、`createReviewAfterDiagnosis` 之前进程崩溃，启动恢复只扫描 `status='running'`；该版本会永久没有 review。
- DB 没有 live/pending version 必须属于本项目的复合约束，也没有“一项目最多一个 pending review”的部分唯一索引。审批也不验证 `review.version_id === project.pending_version_id`。

**触发条件**

1. 老师下线一个已有正式版的项目；学员再 deploy。集合 API 会因状态变成 `published_with_pending` 再次列出项目，但 symlink 仍指向下线页；若老师批准，新内容直接公开，无需 resume。
2. 让待发布版本目录缺失或不可读，再点击 approve。review 已变成 approved，`publishVersion` 抛错，线上仍是旧版；再次点击得到 409，接口无法重试。
3. symlink 切换成功后模拟 SQLite I/O/磁盘错误。访客看到新版，但 DB/集合页仍认为旧版，部署记录也不存在。
4. 在 `runDiagnosis` 已把 diagnosis 改成 healthy、finally 尚未创建 review 的窗口杀进程；重启不会补该 review。
5. 人工修库、故障补偿或未来新写路径制造两个 pending review；两个审批都未对 project.pending 做 compare-and-set，旧版本可以覆盖新版本。

**影响**

紧急下架不是独立安全闸门；审核、实际对外内容和台账会互相矛盾，且部分状态不能从公开 API 恢复。对投诉处置和老师审核来说，这是法律与运营风险，不只是 UI 状态错。

**建议修法**

把 `serving_state` 与“是否有待审版本”彻底分开，任何 submit/reject/approve 都不得改变 suspended，只有显式 resume 能恢复服务。发布改为持久化 intent/job：`approved → publishing → published|publish_failed`，保存 desired version/generation，symlink 后探活；启动时对账 DB、intent 和 symlink，失败可幂等重试/回滚。

审批用同一事务 compare-and-set `review.status=pending AND project.pending_version_id=review.version_id`。补项目级 pending review 唯一索引、version/project/camp 复合约束和孤儿版本/review 启动扫描。`dev_status` 只在诊断完成后按规则迁移。

**修复成本估计**

停用状态止血和 CAS：5–8 小时；完整可恢复发布协议、约束迁移和故障注入测试：16–32 小时。

### 11. 未审核预览只是永久 bearer URL，泄露后任何人都能访问

**问题描述（事实）**

预览 nginx location 只加 `noindex/no-store`，没有鉴权、过期或撤销校验。16 位随机 ID 能防枚举，但不能防链接通过聊天、截图、访问日志或误转发泄露；`noindex` 也不是访问控制。当前清理逻辑只在产物被 prune 时删除预览，不以审核结束、课程结束或 token 吊销为安全生命周期。

**触发条件**

学员把 deploy 返回的 preview URL 发到群里求助，或老师把审核页截图/链接转发给同事；在版本等待诊断和审核的整个窗口内，任何未登录浏览器打开该 URL 都能看到未审核内容，且 URL 本身没有独立过期时间。

**影响**

未审核、可能含真实姓名、录音、位置或不当内容的页面可以绕过老师审核公开传播。随机 URL 降低猜中概率，不降低链接持有者权限，和“访客只能访问已审核正式作品”冲突。

**建议修法**

预览使用短期签名 claim 或 nginx `auth_request`，只允许 owner/本课程老师；访问记录脱敏，页面强制 no-referrer/noindex。版本 superseded、rejected、课程结束或成员/token 被撤销时使 grant 失效。若 7 月 29 日来不及做完整 claim，至少把预览代理回 Node 做会话/项目 scope 校验，不能继续裸静态公开。

**修复成本估计**

会话鉴权代理止血 4–8 小时；短期 claim、撤销与审计 8–16 小时。

### 12. 7 月 29 日黄金路径仍有多个确定性断点

**问题描述（事实）**

以下不是“功能还不丰富”，而是按现有文档操作会直接失败：

| 断点 | 具体触发 |
|---|---|
| 学员 CLI 指向本机 | 学员照 `skill/SKILL.md` 只运行 `vibehub bind`，CLI 默认请求 `http://127.0.0.1:4300`；只有部署手册给老师看的命令要求手工 export `VIBEHUB_API` |
| 文件上传 URL 永远 404 | `vibehub.upload(file)` 的 POST 返回 `/baas/v1/files/<project>/<file>`，但服务端没有对应 GET；把 URL 放到 `<audio src>` 或 `<img src>` 即 404 |
| AI 能力不存在 | 架构/API 承诺 `/baas/v1/ai` 与 `vibehub.ai`，当前 route 和 SDK 都没有；任何依赖 AI 的样例直接报不存在 |
| 老师无法从 UI 建营和发码 | 前端只有 login/student/admin review/collection 四个路由；课程总览、项目列表、邀请码管理、设备撤销没有页面。生产只能靠一次性 seed/API 手工操作 |
| 异步状态不刷新 | Admin/Student 查询没有 `refetchInterval`；老师在诊断完成前打开“空队列”，页面不会在 review 创建后自动出现；学员旧诊断也不会自动刷新 |
| deploy 打印 `undefined%` | 服务端返回 `{diagnosis:{id,status:'running'}}`，CLI 却立即读 `score/summary`，任意成功 deploy 都会显示 `undefined% — undefined` |
| 审核无法验证旗舰能力 | 问题 3 的 sandbox 使录音/BaaS/存储在审核 iframe 失败 |
| 30 人提交积压 | 队列串行执行最多 15 秒 HTTP probe，再等待最多约 15 秒模型翻译后才创建 review。模型网关接近超时时，30 份理论上约 15 分钟才全部进入老师队列（推断，取现有超时上限） |
| 30 人先解包再查项目额度 | 每个请求可先在 staging 展开到 200 MB，之后才 `assertProjectedQuota`；30 人并发可在额度拒绝前写出约 6 GB 临时内容（上界推算），当前没有全局解包 semaphore |

**触发条件**

在一台从未配置过 VibeHub 的学员电脑上，完全照 Skill 文档执行 bind/deploy；同时让 30 名学员提交一个带录音上传的作品，老师提前打开审核页并保持不刷新。上表断点会依次出现，不依赖恶意输入。

**影响**

首场最关键的“接入 → 提交 → 诊断 → 老师看到 → 验证录音上传 → 发布”无法闭环。学员看到 undefined，老师看到空队列或功能失效，运营只能临场使用数据库/命令行救火。

**建议修法**

若只剩 4 天，必须明确砍范围：

1. 如果首场必须做城市声音地图，则文件 GET、Range/MIME、录音审核环境和 BaaS 隔离都是 P0，不能把 BaaS/上传临时降级。
2. 如果无法在剩余时间完成问题 1–3 的隔离，则把首场交付改成无敏感权限、无公开写入的展示型静态站，并明确延期 BaaS；不能一边保留录音作业，一边把安全边界推到 P1。
3. 诊断先只显示事实与“未验证”，隐藏百分比和模型翻译；部署 ready 后立即创建 review，模型翻译脱离审核入队。
4. CLI 内置生产 API 或由安装包配置，running 状态只提示稍后 status；网页对 running/queue 做 2–5 秒有界轮询。
5. 提供最小老师 bootstrap：已有课程的邀请码生成/导出、项目列表、设备撤销；其余运营页可后补。

**修复成本估计**

不含同源/BaaS安全重构，修复本节确定性断点并做 30 人演练约 20–36 小时。若首场保留录音+BaaS，需再计入问题 1–3 的 64 小时以上工作。

### 13. 生产基础设施、备份和回滚仍没有可执行闭环

**问题描述（事实）**

`docs/handbook/deployment.md:13-20` 和 `docs/research/infra-facts.md:23-25,49-57` 仍把 443、证书、hub DNS、腾讯云账号归属、投诉/下架负责人列为待办。Node 服务要求 `>=22` 且使用 `node:sqlite`，手册没有安装或验证 Node 22，基础设施事实也没记录生产 Node 版本。

备份命令写入 `/var/lib/vibehub/backup/`，但目录初始化没有创建 backup；没有定时器、异机复制、加密或恢复演练。回滚要求在 `/opt/vibehub` 执行 `git checkout`，但部署用 rsync 且显式排除 `.git`，该命令在目标机不可用。手册又说正式站是 `sites/<user>/<project>/current`，当前实现的 symlink 实际就是 `sites/<user>/<project>`。

**触发条件**

1. 在当前南京机照手册部署：若 `/usr/bin/node` 低于 22，服务在导入 `node:sqlite` 或引擎能力处失败。
2. 执行备份命令时 backup 目录不存在，sqlite `.backup` 无法创建目标文件；即使手工建目录，机器磁盘损坏时同机备份一起丢失。
3. 发布坏版本后按第 7 节回滚，`/opt/vibehub/.git` 不存在，`git checkout` 失败；按手册切 `current` 也找不到与当前实现一致的链接布局。
4. 443/DNS/证书任一项在 7 月 29 日仍未完成，录音与定位黄金路径直接不可用。

**影响**

上线可能在启动、HTTPS 或 nginx 合并阶段才首次失败；数据库或发布版本损坏后没有经过验证的恢复办法。同机还承载超脑官网，VibeHub 故障可能扩大为官网事故。

**建议修法**

把外部阻塞项设明确 owner 和最晚完成时间，7 月 26 日前完成 443/DNS/证书/Node 22 预检。部署改为带 release 目录或产出包的可回滚流程，不依赖不存在的 Git 仓库。创建 backup 目录，配置定时一致性备份、异机复制、保留策略和一次实做恢复演练；对 symlink、DB live_version 和公开 URL 联合核验。磁盘告警必须由外部监控定时拉取，不能只在有人请求 healthz 时写日志。

**修复成本估计**

仓库内 runbook/脚本与一次演练 8–16 小时；DNS、证书、账号和投诉负责人需要外部 owner，耗时无法从仓库判断。

### 14. 核心设计文档仍描述被否决的子域名架构，会指导实现和运维走错方向

**问题描述（事实）**

已接受决策明确使用主域路径 + `hub`，但：

- `docs/specs/architecture.md:12,30-33,118-167,510-525` 仍以 console/api/`*.works`、Host 推导、通配证书和独立作品 origin 为正式架构。
- `docs/specs/api.md:11,24-28,46,80,173-187` 仍写 console 基址、Host/project key、子域预览，并承诺未实现的 GET 单条与 AI。
- `docs/research/infra-facts.md:49-57` 仍把 wildcard DNS/DNS-01 列作 P0，和已接受的普通证书方案冲突。
- `docs/specs/domain-model.md:334` 仍用 `voice-map.vibe.page`，发布原子序列与当前 symlink/状态写入顺序不同。
- `docs/specs/PRD.md:169-183` 仍把已拍板问题列为开放项。

**触发条件**

让一名未参与决策过程的工程师只读 architecture + API 实施 BaaS/nginx：他会按 Host 判项目、申请 wildcard 证书、部署 `*.works`，并认为作品已经独立 origin。让运维只读 infra-facts 又会去找 DNSPod API；按 deployment 则申请普通证书。三者不能同时成立。

**影响**

剩余 4 天会被浪费在错误证书、错误路由和两套安全假设上；更危险的是，评审者可能因为 architecture 写着“作品独立 origin”而误判问题 1 已解决。

**建议修法**

指定 `decisions-r1.md` 为决策真源，在 architecture/api/domain/infra/handbook 顶部加 superseded 标识或一次性同步为路径方案；删除所有 Host 作为 project authority 的文字，补上“作品之间仍同源、SDK namespace 不是安全边界”的威胁模型。API 只记录当前真实契约，未来接口单列 planned，不能混在可调用表里。

**修复成本估计**

6–10 小时；必须在任何生产部署或新实现继续前完成。

## 值得修但不阻塞上线

这里的“不阻塞”以严重问题已止血、首场范围被明确收窄为前提；若首场直接依赖对应能力，条目应升级为阻塞项。

### 1. 模型翻译不应串行阻塞审核入队

**问题描述（事实）**：确定性诊断完成后，队列仍等待模型翻译，finally 才创建 review。诊断和审核在产品上声称独立，执行上却有前置依赖。

**触发条件**：配置模型 token，让网关每次接近 15 秒超时；连续提交 30 份。部署都已 ready，但 review 要等各自模型调用结束才逐个出现。

**影响**：审核队列延迟；模型故障被误放大为老师看不到提交。
**建议修法**：deployment ready 后立即创建 review；确定性报告和模型摘要分别异步更新 review detail，模型永不控制是否入队。
**修复成本估计**：2–4 小时。

### 2. CLI 与异步诊断响应契约不一致

**问题描述（事实）**：提交响应只有 diagnosis id/status，CLI 却读取 score/summary/next_steps。status 在 running 且无历史报告时也可能输出 `null% (0/0)`。

**触发条件**：任意成功运行一次 `vibehub deploy`；随后立刻运行 `vibehub status`。
**影响**：出现 PRD 明令禁止的 undefined/null 状态，零基础学员会认为提交失败。
**建议修法**：running 只输出“诊断中”；要等待就轮询 operation，不能混用同步和异步结构。
**修复成本估计**：1–2 小时。

### 3. BaaS 文件读取即使补上，也需要主动内容隔离

**问题描述（事实 + 推断）**：当前 GET 缺失是上线断点；未来若直接按返回 MIME 在主域 `/baas` serve，HTML/SVG 等主动内容会形成同源存储型脚本入口。OWASP 建议上传文件用 allowlist、内容校验、授权、大小限制，并优先放在不同主机或 webroot 外。[OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)。

**触发条件**：增加一个“按数据库 MIME 原样返回”的 GET 后，上传 `text/html` 或带脚本 SVG，再让用户顶层打开返回 URL。
**影响**：平台为攻击者托管持久主动内容；在当前同源模型下进一步扩大问题 1。
**建议修法**：文件放独立 asset origin；MIME allowlist + magic byte 校验，未知内容强制 attachment，设置 nosniff，图片/音频按需转码，支持 Range 但限制响应资源。
**修复成本估计**：6–12 小时。

### 4. 版本指纹不能标识真正被服务的字节

**问题描述（事实）**：服务端保存上传 tgz 的 SHA，随后改写 HTML/CSS/JS 并注入 SDK；`versions` 没有 served manifest/hash。
**触发条件**：同一 tgz 在两版平台重写器上提交；bundle SHA 相同，但最终 HTML 不同，preflight 仍可能把它当相同内容。
**影响**：无法证明老师审核与访客看到的是同一字节，也不能可靠复算历史诊断。
**建议修法**：分别保存 source bundle hash、规范化重写 policy/version、served tree manifest hash；诊断唯一键绑定后三者。
**修复成本估计**：4–8 小时。

### 5. policy 与模型摘要仍不可审计

**问题描述（事实）**：policy 只是代码常量；数据库没保存规范化 policy、analyzer/evidence hash。模型摘要只校验格式长度，不要求结论引用 `check_key`，之后会覆盖确定性 summary。
**触发条件**：改分值但忘记改 `POLICY_VERSION`；或模型返回格式合法但与 items 无关的“可以发布”。
**影响**：同一 policy_version 可产生不同算法结果；老师看到的主结论可能脱离证据。
**建议修法**：保存 policy 内容 hash、analyzer version、evidence hash；确定性 readiness 不允许模型覆盖，模型每条文案必须引用现有 check_key。
**修复成本估计**：4–6 小时。

### 6. 邀请码和角色生命周期与文档不一致

**问题描述（事实）**：文档说完整邀请码只显示/导出一次，实现可反复导出全量明码；创建接口接受任意 role，teacher 可写入 `admin`；`reviewer` 在领域/API 中存在，但 `isTeacher` 不承认。课程 archived、成员删除也不会使旧 token 失效。
**触发条件**：老师重复请求 export 可再次拿到所有码；POST invites 传 `role:"admin"` 会生成 admin 邀请；给用户 reviewer 身份后访问审核接口返回 404；归档课程后使用旧 token 仍可提交/审批。
**影响**：审计语义、最小权限和退营生命周期不可信。
**建议修法**：role 服务端 allowlist；明确 teacher/admin/reviewer 能力；export 使用一次性批次或重新生成而非永久明文；每次写操作校验 camp active 和 membership；定义退营后项目冻结/移交规则。
**修复成本估计**：6–12 小时。

### 7. 老师误操作和多老师冲突只有后端 409，没有 UI 恢复路径

**问题描述（事实）**：批准是一键立即发布，无版本确认、blocker 提示或 previous-live 回滚；第二位老师遇到 409 时，approve 错误没有展示区。
**触发条件**：两位老师打开同一 review，一人先处理，另一人再点批准；或老师误点一个待审版本。
**影响**：第二位老师只感到按钮无效；误发布只能下线，不能窄回滚到上一正式版。
**建议修法**：确认框显示待审/线上版本、blocker 与更新时间；mutation 统一展示冲突；增加“恢复上一已批准版本”的受审计回滚。
**修复成本估计**：4–8 小时。

### 8. 统计信标可伪造，当前数字不应叫真实浏览量

**问题描述（事实）**：`/vibehub/_hit` 接受匿名 body.path 并按路径累计，没有验证 Referer、IP 去重或服务端页面交付事实。
**触发条件**：循环 POST `{"path":"/vibehub/victim/project/"}` 到公开 `_hit`；无需打开作品即可增加浏览量。
**影响**：学员/集合页运营数字可被任意刷高，和文档所说 Umami/真实访问口径不一致。
**建议修法**：首场隐藏该统计或明确标“页面上报次数”；后续由 nginx 日志/Umami 统计并定义去重口径。
**修复成本估计**：隐藏 1 小时；真实统计接入 4–8 小时。

## 我认为设计得对、但理由和文档写的不一样的地方

### 1. 把 hub 移到独立 origin 是必要动作，但不是“路径方案的安全修订完成”

正确理由是把受信任控制平面从不可信作品执行面移开，保护 HttpOnly host-only 会话。文档当前把它写得像路径方案的主要同源问题已经解决；实际上它只保护 hub cookie，不保护作品之间、作品与官网之间的 DOM、存储和权限。应把它描述为“第一道控制面隔离”，不是“作品多租户隔离”。

### 2. 当前不执行学员 JavaScript 的 HTTP probe 比同机无头浏览器更符合现有部署边界

当前 `preview-probe.js` 只发 HTTP 请求，console/截图/交互都明确返回 unknown。它无法证明功能可用，但在尚未存在独立低权限 runner、网络命名空间和资源上限的情况下，比直接在持有 DB 与生产目录的 Node 进程里启动浏览器更安全。文档保留无头浏览器的理由是提高完成度判断；真正上线它之前，安全隔离应是前置条件，不能因评分需要降低边界。

### 3. `preservePaths:false` + 拒绝链接/特殊条目是正确的第二层防线，但文档夸大了实现的完整性

当前 node-tar 版本与 filter 已挡住常见绝对路径、`..`、symlink/hardlink/device 逃逸。问题不在“完全没有安全解包”，而在文档承诺 100:1、5000 条、路径冲突和“危险包整体拒绝”，实现只部分兑现。修复应补 manifest 预检和显式限额，不需要推翻 Node/tar 选型。

### 4. “分数由确定性检查器算、模型只翻译”是正确边界，但确定性不等于可信

禁止模型改分防止了不可复算和提示注入直接改分；真正的问题是适用性和证据来源可被学员输入/项目历史污染。文档把“算法确定性”当成“结果可信度”，少了一层 adversarial policy 设计。保留三段式可以，但第一、二段必须先修问题 5。

## 我不确定的地方

1. **生产 nginx 最终合并结果未知。** 部署手册明确说仓库配置不能直接启用，必须合并进现有 `supermind-ai` server；需要最终 `nginx -T`、对正式/预览深链的 curl 结果和主站回归，才能确认 alias/fallback 的线上实际行为。
2. **主域官网当前保存了哪些敏感客户端状态未知。** 需要列出 `supermind-ai.cn` 的 cookie（尤其 Path=/、非 HttpOnly）、localStorage、IndexedDB、Cache Storage 和 Service Worker；这决定问题 1 已经能读到什么，而不改变隔离缺口本身。
3. **首场作业是否硬依赖录音、定位、BaaS 上传和 AI 未得到单一答案。** 部署手册把城市声音地图写成旗舰阻塞项，架构又把部分能力写成 P1/待确认。需要课程负责人给出 7 月 29 日唯一验收作品；否则无法做可信的砍范围决策。
4. **生产 Node 版本、腾讯云账号 owner、DNS 托管方、证书签发和 443 防火墙 owner 未知。** 这些都需要生产只读核查或明确负责人，代码审查无法替代。
5. **模型网关是否会在生产启用、真实 p95 延迟未知。** 这决定 30 人提交积压是接近几分钟还是理论上约 15 分钟；无论实际延迟多少，模型位于 review 创建前的串行依赖仍是事实。
6. **退营后作品应该继续公开、冻结、归老师还是允许学员带走，文档没有产品裁决。** 在规则确定前，不能判断唯一正确迁移；至少应先禁止 archived camp 的旧 token 继续写。
7. **大小写/Unicode 冲突的目标平台语义未定义。** 生产是 Linux，但学员可能在 macOS/Windows 打包；需要明确是按原字节保留、NFC 规范化还是冲突即拒绝，随后才能写准确测试。
8. **没有发现针对以下威胁的现成负向测试证据**：跨项目 BaaS header、同站 CSRF、`.env` 公开、sandbox 内 BaaS/录音、同源 iframe/存储、目录炸弹、nginx 深链 fallback、发布故障注入、suspended 后再提交、老师跨 camp IDOR。需要这些测试或手工复现记录，才能把“修了”变成可验收结论。
