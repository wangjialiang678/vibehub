---
title: VibeHub 部署手册（南京机）
date: 2026-07-25
status: draft
audience: tech
---

# 部署手册

目标环境：腾讯云南京 Lighthouse，`supermind-ai.cn`（已备案）。
连接参数见 `~/.claude/server-vault.env` 的 `TC_NANJING_*`，**本仓库公开，不记录任何连接参数**。

## 0. 前置阻塞项（必须先做完）

| # | 事项 | 为什么阻塞 | 状态 |
|---|---|---|---|
| 1 | **开放 443 端口** | 录音 `getUserMedia`、定位等浏览器 API 只在 HTTPS 下可用。原型的旗舰作品「城市声音地图」要录音——**没有 HTTPS，一半作品做不出来** | ⬜ 待办。需先确认南京机归属哪个腾讯云账号（不在本机 `tccli` 默认与 `lemo` profile 可见范围内） |
| 2 | 申请普通证书 | 同上 | ⬜ 为 `supermind-ai.cn`（可含 `www`）和 `hub.supermind-ai.cn` 配置普通证书，HTTP-01 即可（80 已通）；不需要通配证书或 DNS-01 |
| 3 | 配置 `hub.supermind-ai.cn` A 记录 | 控制台必须与作品不同 origin | ⬜ 一条 A 记录，指向同一台机器 |
| 4 | 落实投诉与下架负责人 | 作品挂在已备案主体下，内容责任在超脑 | ⬜ 这是运营缺口，产品设计替代不了一个具体的人 |

```bash
# 1 完成后：
sudo certbot --nginx -d supermind-ai.cn -d www.supermind-ai.cn -d hub.supermind-ai.cn
```

## 1. 目录与权限

```bash
sudo mkdir -p /var/lib/vibehub/{versions,sites,previews,uploads,tmp,backup}
sudo mkdir -p /var/www/vibehub-console
sudo mkdir -p /opt/vibehub-releases              # 每次部署一个带时间戳的 release，回滚靠它
sudo useradd -r -s /usr/sbin/nologin vibehub || true
sudo chown -R vibehub:vibehub /var/lib/vibehub /opt/vibehub-releases
sudo chmod 755 /var/lib/vibehub                 # nginx 要能读作品文件
```

> **生产环境已核实（2026-07-25 SSH 预检）**：Node `v22.23.1`（满足 node:sqlite 所需 ≥22）、
> npm 10.9.8、磁盘 79G 用 12%、certbot 2.9.0、pm2 已装、nginx `supermind-ai` 站点在（主域 root `/var/www/supermind`）。
> **唯一硬阻塞：443 未监听**——需在腾讯云控制台放行防火墙 443（先确认南京机归属哪个账号）。

> **诊断用的无头浏览器要用另一个更低权限的用户跑**（见 architecture.md §5.3b）：
> 不给它 DB、SSH key、云凭证的读权限；15 秒硬超时；禁止访问内网段与 `169.254.169.254`。
> 这一条在 P0 只跑静态分析时可以先不落，**一旦开启浏览器探测必须同时落地**。

## 2. 部署服务端

```bash
# 每次部署推到一个带时间戳的 release 目录，/opt/vibehub 软链指向当前 release —— 回滚只需改软链
REL=/opt/vibehub-releases/$(date +%Y%m%d-%H%M%S)
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude 'test' \
  -e "ssh -p <端口> -i <密钥>" \
  ./server/ <账号>@<南京机>:"$REL"/

# 服务器上
cd "$REL" && npm ci --omit=dev
sudo ln -sfn "$REL" /opt/vibehub.tmp && sudo mv -Tf /opt/vibehub.tmp /opt/vibehub   # 原子切换
sudo -u vibehub VIBEHUB_DATA_DIR=/var/lib/vibehub node /opt/vibehub/src/seed.js   # 只跑一次（首次部署）
```

> systemd 的 `WorkingDirectory=/opt/vibehub`（软链）不变，`ExecStart` 始终跑当前 release。

`/etc/systemd/system/vibehub.service`：

```ini
[Unit]
Description=VibeHub
After=network.target

[Service]
Type=simple
User=vibehub
WorkingDirectory=/opt/vibehub
Environment=NODE_ENV=production
Environment=VIBEHUB_DATA_DIR=/var/lib/vibehub
Environment=VIBEHUB_PORT=4300
Environment=VIBEHUB_HOST=127.0.0.1
Environment=VIBEHUB_CONSOLE_ORIGIN=https://hub.supermind-ai.cn
Environment=VIBEHUB_WORKS_ORIGIN=https://supermind-ai.cn
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
# 服务只该碰自己的数据目录
ProtectSystem=strict
ReadWritePaths=/var/lib/vibehub
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now vibehub
sudo systemctl is-active vibehub
```

## 3. 部署控制台前端

```bash
cd web && VITE_API_BASE=https://hub.supermind-ai.cn npm run build
rsync -az --delete -e "ssh -p <端口> -i <密钥>" \
  ./web/dist/ <账号>@<南京机>:/tmp/vibehub-console/
ssh ... 'sudo rsync -a --delete /tmp/vibehub-console/ /var/www/vibehub-console/'
```

## 4. nginx

```bash
sudo cp infra/nginx/vibehub.conf /etc/nginx/sites-available/vibehub
sudo ln -sf /etc/nginx/sites-available/vibehub /etc/nginx/sites-enabled/vibehub
sudo nginx -t && sudo systemctl reload nginx
```

> ⚠️ 现有的 `supermind-ai` 站点配置也监听主域的 80，**两者会冲突**。
> 正确做法是把本配置**合并进**现有的 `supermind-ai` 配置，而不是新加一个 server 块。
> 上线前务必 `nginx -t` 并确认超脑官网首页仍然正常。

## 5. 验收：黄金路径

```bash
# 老师端
open https://hub.supermind-ai.cn/admin

# 学员端（在任意一个网页项目目录里）
export VIBEHUB_API=https://hub.supermind-ai.cn
node /path/to/skill/bin/vibehub bind <邀请码>
node /path/to/skill/bin/vibehub deploy --summary "第一次提交"
# → 拿到预览地址，老师在队列里看到它，审核通过
# → https://supermind-ai.cn/vibehub/<username>/<project>/ 能打开
# → 手机扫码能打开（HTTPS 生效后）
```

**从新加坡机验证外网视角**（绕开本机 Clash TUN 的干扰）：
```bash
ssh <新加坡机> "curl -s -o /dev/null -w '%{http_code}\n' https://supermind-ai.cn/vibehub/<u>/<p>/"
```

## 6. 备份

单机部署，没有第二份数据。

```bash
# 每天备份数据库与版本产物元信息
sudo -u vibehub sqlite3 /var/lib/vibehub/db.sqlite ".backup /var/lib/vibehub/backup/db-$(date +%F).sqlite"
# versions/ 体积会涨，按保留策略清理（见 architecture.md §4.4）
```

**必须配的三件事**（否则一台机器被学员的图片塞满，超脑官网会一起挂）：
1. 每项目磁盘配额
2. 定时清理 `tmp/` 与超出保留数的历史产物
3. 磁盘使用率 80% 告警

## 7. 回滚

代码回滚 = 把 `/opt/vibehub` 软链指回上一个 release（部署机上不放 `.git`，别用 git checkout）：

```bash
ls -dt /opt/vibehub-releases/*/ | head -3          # 看有哪些 release，第 2 个通常是上一版
PREV=/opt/vibehub-releases/<上一个时间戳>
sudo ln -sfn "$PREV" /opt/vibehub.tmp && sudo mv -Tf /opt/vibehub.tmp /opt/vibehub
sudo systemctl restart vibehub && systemctl is-active vibehub
```

数据库回滚（如需）从每日备份恢复：
```bash
sudo systemctl stop vibehub
sudo -u vibehub cp /var/lib/vibehub/backup/db-<日期>.sqlite /var/lib/vibehub/db.sqlite
sudo systemctl start vibehub
```

作品本身不需要回滚——`sites/<user>/<project>` 本身就是直接指向
`versions/<id>/` 的软链。用同样的临时软链 + 原子 `rename` 指回上一个版本，
秒级生效且无 404 窗口；不存在 `current` 子链接。
