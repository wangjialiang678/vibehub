---
title: VibeHub 部署手册（南京机）
date: 2026-07-25
status: active
audience: tech
---

# 部署手册

本文记录南京生产环境的可复现部署方式。连接地址、密钥和公网 IP 不写入仓库；以下 `<deploy-user>`、`<server>` 与 `<server-public-ip>` 均在执行环境中替换。

## 1. 首次部署：DNS 与证书

先为控制台添加 `hub.supermind-ai.cn` 的 A 记录，并为隔离预览添加 `*.preview.supermind-ai.cn` 泛解析。DNSPod 使用 `tccli` 时，第二条记录的 `SubDomain` 为 `*.preview`：

```bash
tccli dnspod CreateRecord \
  --Domain supermind-ai.cn \
  --SubDomain hub \
  --RecordType A \
  --RecordLine 默认 \
  --Value <server-public-ip>

tccli dnspod CreateRecord \
  --Domain supermind-ai.cn \
  --SubDomain '*.preview' \
  --RecordType A \
  --RecordLine 默认 \
  --Value <server-public-ip>
```

确认解析已生效后，为控制台子域申请普通证书。预览通配证书通常不能使用 HTTP-01，必须按 DNS 提供商能力走 DNS-01；不要把 DNS API 密钥写进仓库或命令历史：

```bash
sudo certbot certonly --nginx -d hub.supermind-ai.cn
# 按已确认的 DNS-01 插件/流程签发；下行仅表达证书名与域名，不是可直接执行的完整命令。
# certbot certonly <dns-01-options> -d '*.preview.supermind-ai.cn'
```

普通证书路径与 `infra/nginx/vibehub-hub.conf` 一致：`/etc/letsencrypt/live/hub.supermind-ai.cn/`。预览配置模板默认引用 `/etc/letsencrypt/live/preview.supermind-ai.cn/`；实际签发的 certificate name 不同时，安装前必须修改 `infra/nginx/vibehub-preview-server.conf` 中两条证书路径。先用 `dig` 与证书链实测确认泛解析和通配证书，再继续部署。

## 2. 目录与运行用户

```bash
sudo mkdir -p /var/lib/vibehub/{versions,sites,previews,uploads,tmp,backup}
sudo mkdir -p /var/www/vibehub-console/releases /opt/vibehub-releases
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

首次部署先生成预览 claim 的 HMAC 密钥。密钥只放在服务器配置文件，不进仓库；生产启动时缺失或少于 32 字符会直接失败：

```bash
sudo install -d -m 0750 -o root -g vibehub /etc/vibehub
PREVIEW_SECRET="$(openssl rand -hex 32)"
sudo sh -c "umask 027; printf 'VIBEHUB_PREVIEW_CLAIM_SECRET=%s\n' '$PREVIEW_SECRET' > /etc/vibehub/vibehub.env"
unset PREVIEW_SECRET
sudo chown root:vibehub /etc/vibehub/vibehub.env
sudo chmod 0640 /etc/vibehub/vibehub.env
```

后续发布必须保留 `/etc/vibehub/vibehub.env`；随意轮换该值会让所有尚未到期的预览 claim 立即失效。

把仓库的 systemd 单元安装为 `/etc/systemd/system/vibehub.service`，然后加载并启动：

```bash
sudo install -m 0644 /tmp/vibehub-systemd/vibehub.service /etc/systemd/system/vibehub.service
sudo systemctl daemon-reload
sudo systemctl enable --now vibehub
sudo systemctl is-active vibehub
```

该单元固定使用 `WorkingDirectory=/opt/vibehub`，因而始终启动当前 release。

## 4. 构建并发布控制台

控制台必须把 API 基址和老师转发给学员的公开地址编入产物。前端的 `prebuild` 会把 Skill 的固定白名单文件、SHA-256 清单和在线安装器生成到 `dist/downloads/vibehub-skill/`；不需要 npm 登录、npm 包发布、SkillHub 凭证或额外的安装命令环境变量：

```bash
cd web
npm ci
VITE_API_BASE=https://hub.supermind-ai.cn \
VITE_PUBLIC_APP_URL=https://hub.supermind-ai.cn \
npm run build
release_id="$(date -u +%Y%m%d-%H%M%S)"
rsync -az --delete ./dist/ <deploy-user>@<server>:/tmp/vibehub-console-${release_id}/
```

构建后、同步前确认分发产物齐全：

```bash
test -f dist/downloads/vibehub-skill/install.mjs
test -f dist/downloads/vibehub-skill/manifest.json
node -e "const m=require('./dist/downloads/vibehub-skill/manifest.json'); if (!m.files?.length) process.exit(1)"
```

在服务器上把整套控制台产物写入新的时间戳目录，完成后再原子切换 nginx 使用的 `current` 软链接。`infra/nginx/vibehub-hub.conf` 的 root 固定为 `/var/www/vibehub-console/current`，因此不会尝试用软链接覆盖控制台父目录。`manifest.json` 与它列出的 Skill 文件会随整套控制台一次生效：

```bash
release_id=<与上传时相同的时间戳>
sudo install -d -m 0755 /var/www/vibehub-console/releases
sudo mv /tmp/vibehub-console-${release_id} /var/www/vibehub-console/releases/${release_id}
sudo ln -sfn /var/www/vibehub-console/releases/${release_id} /var/www/vibehub-console/current.next
sudo mv -Tf /var/www/vibehub-console/current.next /var/www/vibehub-console/current
```

首次从旧的 `/var/www/vibehub-console` 实目录迁移时，先把原有文件（排除新建的 `releases` 目录）移动到 `/var/www/vibehub-console/releases/legacy-<时间戳>`，再按上面的命令建立 `current`，最后安装并校验新的 nginx 配置。这个一次性迁移会有一个很短的维护窗口；以后发布只切换 `current`。

发布后保留当前版和至少一个上一版。需要回滚时，对上一版目录重复 `ln -sfn` 与 `mv -Tf` 两步即可；确认线上探针全部通过后再清理更旧的静态 release。不要再向 `/var/www/vibehub-console/` 原地 `rsync --delete`。

## 5. 安装 nginx 配置

仓库中的 nginx 文件与生产布局一一对应：

| 仓库文件 | 生产位置与作用 |
|---|---|
| `infra/nginx/vibehub-locations.conf` | `/etc/nginx/vibehub-locations.conf`；被官网 `supermind-ai` 的 443 server 引入。正式作品仍由 nginx 直出，主域上的未审核预览路径固定 404。 |
| `infra/nginx/vibehub-preview-server.conf` | `/etc/nginx/sites-enabled/vibehub-preview`；`*.preview.supermind-ai.cn` 的独立 443 server，只有预览、SDK 与 BaaS 路由回源 Node。 |
| `infra/nginx/vibehub-hub.conf` | `/etc/nginx/sites-enabled/vibehub-hub`；控制台独立的 `hub.supermind-ai.cn` server 块，静态 root 指向 `/var/www/vibehub-console/current`。 |

从部署端同步并安装它们：

```bash
rsync -az infra/nginx/ <deploy-user>@<server>:/tmp/vibehub-nginx/
```

```bash
sudo install -m 0644 /tmp/vibehub-nginx/vibehub-locations.conf /etc/nginx/vibehub-locations.conf
sudo install -m 0644 /tmp/vibehub-nginx/vibehub-preview-server.conf /etc/nginx/sites-enabled/vibehub-preview
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

> ⚠️ `location ~` 的路径正则中包含 `{}` 量词时，整个正则必须加双引号。两个 VibeHub nginx 文件中的预览路径均已加引号；去掉会让 nginx 解析失败。预览虚拟主机刻意关闭 access log，并把 error log 设为 `/dev/null crit`，防止 claim query 因 upstream 错误落盘；预览可用性改由 `/healthz`、应用日志和外部探针监控。

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

同时打开 `https://hub.supermind-ai.cn/` 确认控制台 SPA 和 API 入口可用。老师登录管理端的邀请码页后，应能看到“发给学员的使用说明”：通用说明分别覆盖 `/login` 网页直传和 `/install` AI 部署；新生成学员邀请码后，每份完整说明只能包含对应学员自己的明码，老师角色邀请码的生成结果不生成绑定该码的学员转发文案。

控制台发布后必须检查 Skill 自托管链路。`/install`、安装器和清单都应返回 200；清单中的每个文件都应可下载，且下载内容的字节数和 SHA-256 与清单一致：

```bash
curl -fsS -o /dev/null https://hub.supermind-ai.cn/install
curl -fsS -o /dev/null https://hub.supermind-ai.cn/downloads/vibehub-skill/install.mjs
curl -fsS https://hub.supermind-ai.cn/downloads/vibehub-skill/manifest.json | \
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const manifest = JSON.parse(text);
    const root = "https://hub.supermind-ai.cn/downloads/vibehub-skill/files/";
    for (const entry of manifest.files) {
      const response = await fetch(new URL(entry.path, root));
      if (!response.ok) process.exit(1);
      const body = Buffer.from(await response.arrayBuffer());
      const hash = createHash("sha256").update(body).digest("hex");
      if (body.byteLength !== entry.bytes || hash !== entry.sha256) process.exit(1);
    }
    console.log(`已验证 ${manifest.files.length} 个 Skill 文件`);
  '
```

这组探针只验证公开静态分发，不会写入真实学员数据，也不需要安装 SkillHub 或登录 npm。

最后用真实待审版本验证隔离预览：主域预览路径必须为 404；带 claim 的逐 preview 地址第一次只返回 303 且 Location 不含 claim，随后同一 host 的 cookie 请求返回 200。不要把完整 claim 写入终端日志或工单。

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://supermind-ai.cn/vibehub/_preview/<pid16>/
curl -sS -I https://<pid16>.preview.supermind-ai.cn/vibehub/_preview/<pid16>/
```

第二条裸请求预期 404；作者或老师通过控制台/`vibehub open` 完成授权后的浏览器访问才应成功。

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
