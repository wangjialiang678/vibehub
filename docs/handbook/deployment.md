---
title: VibeHub 部署手册（南京机）
date: 2026-07-25
status: active
audience: tech
---

# 部署手册

本文记录南京生产环境的可复现部署方式。连接地址、密钥和公网 IP 不写入仓库；以下 `<deploy-user>`、`<server>` 与 `<server-public-ip>` 均在执行环境中替换。

## 1. 首次部署：DNS 与证书

先为控制台添加 `hub.supermind-ai.cn` 的 A 记录。DNSPod 使用 `tccli`：

```bash
tccli dnspod CreateRecord \
  --Domain supermind-ai.cn \
  --SubDomain hub \
  --RecordType A \
  --RecordLine 默认 \
  --Value <server-public-ip>
```

确认解析已生效后，为控制台子域单独申请证书：

```bash
sudo certbot certonly --nginx -d hub.supermind-ai.cn
```

该命令生成的证书路径与 `infra/nginx/vibehub-hub.conf` 一致：`/etc/letsencrypt/live/hub.supermind-ai.cn/`。

## 2. 目录与运行用户

```bash
sudo mkdir -p /var/lib/vibehub/{versions,sites,previews,uploads,tmp,backup}
sudo mkdir -p /var/www/vibehub-console /opt/vibehub-releases
sudo useradd -r -s /usr/sbin/nologin vibehub || true
sudo chown -R vibehub:vibehub /var/lib/vibehub /opt/vibehub-releases
sudo chmod 755 /var/lib/vibehub
```

## 3. 发布服务端与 systemd

每次发布使用一个时间戳 release，`/opt/vibehub` 软链指向当前 release。先在部署端生成 release 路径并同步服务端：

```bash
REL=/opt/vibehub-releases/$(date +%Y%m%d-%H%M%S)
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude test \
  ./server/ <deploy-user>@<server>:"$REL"/
```

同时同步 systemd 单元：

```bash
rsync -az infra/systemd/ <deploy-user>@<server>:/tmp/vibehub-systemd/
```

在服务器上安装依赖并原子切换软链：

```bash
cd "$REL" && npm ci --omit=dev
sudo ln -sfn "$REL" /opt/vibehub.tmp
sudo mv -Tf /opt/vibehub.tmp /opt/vibehub
```

把仓库的 systemd 单元安装为 `/etc/systemd/system/vibehub.service`，然后加载并启动：

```bash
sudo install -m 0644 /tmp/vibehub-systemd/vibehub.service /etc/systemd/system/vibehub.service
sudo systemctl daemon-reload
sudo systemctl enable --now vibehub
sudo systemctl is-active vibehub
```

该单元固定使用 `WorkingDirectory=/opt/vibehub`，因而始终启动当前 release。

## 4. 构建并发布控制台

控制台必须把 API 基址编入产物：

```bash
cd web
npm ci
VITE_API_BASE=https://hub.supermind-ai.cn npm run build
rsync -az --delete ./dist/ <deploy-user>@<server>:/tmp/vibehub-console/
```

在服务器上将产物放到 nginx 的实际根目录：

```bash
sudo rsync -a --delete /tmp/vibehub-console/ /var/www/vibehub-console/
```

## 5. 安装 nginx 配置

仓库中的 nginx 文件与生产布局一一对应：

| 仓库文件 | 生产位置与作用 |
|---|---|
| `infra/nginx/vibehub-locations.conf` | `/etc/nginx/vibehub-locations.conf`；被官网 `supermind-ai` 的 443 server 引入，提供作品、SDK、BaaS 与浏览量接口。 |
| `infra/nginx/vibehub-hub.conf` | `/etc/nginx/sites-enabled/vibehub-hub`；控制台独立的 `hub.supermind-ai.cn` server 块。 |

从部署端同步并安装它们：

```bash
rsync -az infra/nginx/ <deploy-user>@<server>:/tmp/vibehub-nginx/
```

```bash
sudo install -m 0644 /tmp/vibehub-nginx/vibehub-locations.conf /etc/nginx/vibehub-locations.conf
sudo install -m 0644 /tmp/vibehub-nginx/vibehub-hub.conf /etc/nginx/sites-enabled/vibehub-hub
```

在现有 `supermind-ai` 的 **443 server 块**中、其 `location /` 之前只添加这一行：

```nginx
include /etc/nginx/vibehub-locations.conf;
```

安装上述两个文件后检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

> ⚠️ `location ~` 的路径正则中包含 `{}` 量词时，整个正则必须加双引号。`vibehub-locations.conf` 中的预览路径 `[a-z0-9]{16}` 已按此规则写成 `location ~ "..."`；去掉引号会让 nginx 解析失败。

## 6. 初始化数据与外部验收

首次部署在当前 release 上执行 seed：

```bash
sudo -u vibehub VIBEHUB_DATA_DIR=/var/lib/vibehub node /opt/vibehub/src/seed.js
```

从生产机之外的网络检查已发布作品的官网地址，预期 HTTP 状态为 `200`：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://supermind-ai.cn/vibehub/<username>/<project>/
```

同时打开 `https://hub.supermind-ai.cn/` 确认控制台 SPA 和 API 入口可用。

## 7. 回滚与备份

代码回滚只需把 `/opt/vibehub` 指向上一个 release，再重启服务：

```bash
ls -dt /opt/vibehub-releases/*/ | head -3
PREV=/opt/vibehub-releases/<previous-release>
sudo ln -sfn "$PREV" /opt/vibehub.tmp
sudo mv -Tf /opt/vibehub.tmp /opt/vibehub
sudo systemctl restart vibehub
sudo systemctl is-active vibehub
```

数据库备份保存在 `/var/lib/vibehub/backup/`：

```bash
sudo -u vibehub sqlite3 /var/lib/vibehub/db.sqlite ".backup /var/lib/vibehub/backup/db-$(date +%F).sqlite"
```
