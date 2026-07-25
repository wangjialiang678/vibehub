# Codex 任务：把实际部署配置同步回仓库（纯本地文件，无生产风险）

VibeHub 已实际部署到南京机生产环境。实际用的 nginx/systemd 配置与仓库里的 `infra/nginx/vibehub.conf` 有出入（实际用了「一行 include + 独立 hub server 块」方式，且正则 location 加了引号）。把仓库更新成与生产一致，保证可复现。**只改仓库文件，不碰服务器。**

## 实际生产配置（照抄进仓库）

### `/etc/nginx/vibehub-locations.conf`（被官网 supermind-ai 443 server `include`）
```nginx
# VibeHub 作品与 BaaS —— 由 supermind-ai 443 server include。含 {} 的正则必须加引号。
location = /vibehub/_hit { proxy_pass http://127.0.0.1:4300; }
location ^~ /vibehub/_sdk/ { proxy_pass http://127.0.0.1:4300; add_header Cache-Control "public, max-age=300" always; }
location ^~ /baas/ {
    proxy_pass http://127.0.0.1:4300;
    proxy_set_header Host $host;
    proxy_set_header Referer $http_referer;
    proxy_set_header X-Vibehub-Project "";
    client_max_body_size 25m;
}
location ~ "^/vibehub/_preview/(?<vh_pid>[a-z0-9]{16})(?<vh_prest>/.*)?$" {
    alias /var/lib/vibehub/previews/$vh_pid;
    try_files $vh_prest $vh_prest/index.html /index.html =404;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Cache-Control "no-store" always;
}
location ~ "^/vibehub/(?<vh_user>[a-z0-9][a-z0-9_-]*)/(?<vh_proj>[a-z0-9][a-z0-9_-]*)(?<vh_rest>/.*)?$" {
    alias /var/lib/vibehub/sites/$vh_user/$vh_proj;
    try_files $vh_rest $vh_rest/index.html /index.html =404;
    add_header Content-Security-Policy "frame-ancestors 'self' https://hub.supermind-ai.cn" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control "public, max-age=60" always;
}
```

### `/etc/nginx/sites-enabled/vibehub-hub`（控制台独立 server 块）
```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name hub.supermind-ai.cn;
    ssl_certificate /etc/letsencrypt/live/hub.supermind-ai.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.supermind-ai.cn/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    root /var/www/vibehub-console;
    index index.html;
    location /api/ { proxy_pass http://127.0.0.1:4300; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; client_max_body_size 35m; proxy_read_timeout 120s; }
    location /healthz { proxy_pass http://127.0.0.1:4300; }
    location / { try_files $uri $uri/ /index.html; }
}
server { listen 80; listen [::]:80; server_name hub.supermind-ai.cn; return 301 https://$host$request_uri; }
```
官网 `supermind-ai` 443 server 块里只加了一行 `include /etc/nginx/vibehub-locations.conf;`（在 `location /` 之前）。

### `/etc/systemd/system/vibehub.service`
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
ProtectSystem=strict
ReadWritePaths=/var/lib/vibehub
PrivateTmp=true
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
```

## 要做

1. 把 `infra/nginx/vibehub.conf` 拆/改为两个文件反映实际：`infra/nginx/vibehub-locations.conf` 和 `infra/nginx/vibehub-hub.conf`，内容如上（含引号正则、include 方式）。原 `vibehub.conf` 可保留为「参考全量版」或删除，你判断，但仓库要能对应实际部署。
2. 新增 `infra/systemd/vibehub.service`，内容如上。
3. 更新 `docs/handbook/deployment.md`，让步骤与实际部署一致：DNS 用 `tccli dnspod` 加 hub 记录 → `certbot certonly --nginx -d hub.supermind-ai.cn` → rsync 到 release 目录 + `npm ci` + 软链 → 构建 web(`VITE_API_BASE=https://hub.supermind-ai.cn`)传 `/var/www/vibehub-console` → nginx 加一行 include + 放 hub 块 → seed → 外部 curl 验证官网 200。强调「含 `{}` 的正则 location 必须加引号」这个坑。
4. 记一条已知不一致到 `docs/specs/domain-model.md`（或一个 P1 备注文件）：**`collection_entries` 表在设计文档里有，但 `server/src/lib/db.js` 实际未建**——集合页排序实际用 `projects` 上的字段（核对 `server/src/routes/public.js` 与 db.js 确认真实机制），把文档改成与实现一致，或明确标注为未实现。

## 交付
- 只改仓库文件，不 ssh、不碰服务器、不碰数据库
- 报告改了哪些文件、collection_entries 的真实机制是什么
