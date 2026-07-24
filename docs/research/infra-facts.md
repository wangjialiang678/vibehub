---
title: VibeHub 基础设施事实核查
date: 2026-07-25
status: active
audience: both
---

# 基础设施事实核查

本文只记录**已经实测验证过的事实**和**明确标注的待验证项**。设计决策请引用本文，不要重新猜测。

## 1. 生产服务器（南京）

| 项 | 值 | 核查方式 |
|---|---|---|
| 公网 IP | `<南京机 IP，见 server-vault TC_NANJING_*>` | server-vault `TC_NANJING_*` |
| 厂商/机型 | 腾讯云 Lighthouse，机器名 `supermind-cn` | deploy-to-nanjing skill |
| 系统 | Ubuntu 24.04.4 LTS | `lsb_release -ds` |
| CPU / 内存 | **2 vCPU / 7.4 GiB** | `nproc` / `free -h` |
| 磁盘 | 79 GB，已用 8.7 GB（12%） | `df -h /` |
| 负载 | `0.00 0.00 0.00`，开机 11 天，**几乎空载** | `uptime` |
| SSH | 端口 `<非标准端口，见 server-vault>`，非 root 用户 | server-vault |
| 已监听端口 | **80、8080**（均为 nginx） | `ss -ltnp` |
| **443** | **未监听** | `ss -ltnp` + `nc -z` 均确认关闭 |
| certbot | `/usr/bin/certbot` 已安装 | `which certbot` |
| 现有站点 | `/var/www/sites/` 下 4 个（demo / hello / waic / index.html） | `ls` |
| nginx 站点配置 | `default`、`nanjing-default`、`supermind-ai` | `ls /etc/nginx/sites-enabled/` |

**容量判断**：2 vCPU 上用 nginx 直接 serve 静态文件，几百到几千个作品站点毫无压力（nginx 静态文件吞吐与站点数量近似无关，只与并发请求相关）。但**同一台机器跑几十上百个学员后端进程不可行**——每个 Node 进程常驻内存 40–80 MB，7.4 GB 内存扣掉系统和平台自身，理论上限也就几十个，且 2 核无法调度。

## 2. 域名与备案

| 项 | 值 | 核查方式 |
|---|---|---|
| `supermind-ai.cn` A 记录 | `<南京机 IP，见 server-vault TC_NANJING_*>` | `dig +short @223.5.5.5` |
| `www.supermind-ai.cn` | 同上 | `dig` |
| HTTP（80） | **200 OK**，返回「超脑 AI 孵化器」官网 | `curl -I` |
| HTTPS（443） | **连接失败** | `curl` + `nc -z` |
| ICP 备案状态 | **已备案**（推定，证据充分） | 见下 |

**备案推定的依据**：中国大陆境内服务器上，未完成 ICP 备案的域名访问 80/443 会被接入商拦截。`supermind-ai.cn` 指向境内腾讯云机器且 80 端口正常返回内容，因此该域名已完成备案且接入商为腾讯云。

> 待验证：备案主体名称、备案号、是否为非经营性备案。建议在腾讯云控制台确认后补录此处。

**子域名是否需要单独备案**：不需要。阿里云官方口径为「备案仅针对顶级域名，二级域名及多级域名无法备案；顶级域名备案成功后，对应二级及多级域名访问内地节点服务器无需再备案」。来源：https://developer.aliyun.com/ask/524435 · https://developer.aliyun.com/ask/16233

因此 `<slug>.supermind-ai.cn` 形态的作品网址在合规上成立，**前提是备案接入商与实际承载服务器一致**（当前一致，都是腾讯云）。

## 3. 需要开通的运维项（P0 待办）

| 待办 | 说明 | 阻塞点 |
|---|---|---|
| 开放 443 端口 | 腾讯云防火墙放行 + nginx 增加 443 server 块 | **<南京机 IP，见 server-vault TC_NANJING_*> 不在本机 `tccli` 默认 profile 与 `lemo` profile 的可见范围内**，需确认该机归属哪个腾讯云账号后在控制台操作 |
| 申请 `*.supermind-ai.cn` 通配证书 | Let's Encrypt 通配证书必须走 **DNS-01** 验证，需要 DNS 服务商 API 凭证（腾讯云 DNSPod） | 需确认 `supermind-ai.cn` 的 DNS 托管在哪（当前解析生效，需确认是否 DNSPod） |
| 配置泛解析 `*.supermind-ai.cn` → `<南京机 IP，见 server-vault TC_NANJING_*>` | DNS A 记录 | 同上 |

> 这三项互相依赖，建议一次性打包处理，预计半天。**在 443 打通前，作品网址只能是 http，不影响功能但影响观感与部分浏览器 API（如地理位置、麦克风录音需要 HTTPS）**——注意原型里的「城市声音地图」要录音，**这意味着 HTTPS 不是可选项而是功能前提**。

## 4. 已有的多租户部署机制（可直接复用）

南京机上已有一套免 sudo 的三档部署机制：

- **静态站**：用 static 档账号 `rsync` 到 `/var/www/sites/<name>/` → `http://<机器>:8080/<name>/`，服务端 `webperms-watch` 自动修权限
- **后端**：用 backend 档账号 `rsync` 到 `~/apps/<name>/` + pm2 + 自助反代（`/etc/nginx/nanjing-apps/*.conf`）

> 三档账号（admin / static / backend）的具体用户名、端口与密钥路径见 `~/.claude/server-vault.env` 的 `TC_NANJING_*`，本仓库公开，不记录连接参数。
- **反代包含机制**：`nanjing-default` 站点配置中 `include /etc/nginx/nanjing-apps/*.conf`，新增后端不需要改主配置

VibeHub 的部署管道可以复用这套目录约定与权限机制，但**需要独立的 nginx server 块**（因为要走域名而非 8080 路径）。

## 5. 统计能力

已有自托管 umami：`https://statistics.superbrain-ai.com`，凭证在 server-vault 的 `UMAMI_*`。超脑官网已接入（`data-website-id=8096d31a-...`）。

需求文档 §9.3 的「网页浏览量 / 今日浏览 / 独立访客 / 近 7 天趋势」四个指标，umami 全部原生支持，且有 API 可取。**不需要自建统计。**

> 待验证：umami 是否支持按 website 动态创建（每个学员作品一个 website id），以及 API 配额。

## 6. VibeLoop 中台现状

| 组件 | 位置 | 状态 |
|---|---|---|
| Vibe Workbench（人机交互层） | 代码 `~/projects/AI 工作流/vibecoding 工作台`；生产 `https://workbench.superbrain-ai.com`（`<workbench 主机 IP，见 server-vault>`） | 在线（返回 403 = 需要口令，符合预期）。459 项自动化测试全绿 |
| user-vibeloop（闭环框架） | `~/projects/AI 工作流/user-vibeloop` | 代码就绪，Node ≥20 纯 ESM，唯一运行时依赖 `yaml`，数据为本地 JSON/JSONL |
| 常驻 worker | 生产机 systemd `vibeloop-workbench.service` + `resident-worker.service` | 已启用自动重启；**已知缺口**：worker 在推进游标后、回执前崩溃的事件不会自动重试；不支持多开 worker |

## 7. 其他可复用凭证

- 腾讯云 COS 子账号 `cos-agent`（`COS_AGENT_*`）——学员作品的图片/音频存储可直接用
- 阿里云 OSS（`OSS_*`）——备选对象存储
- 营地部署管理员 token 体系（`CAMP_DEPLOY_ADMIN_TOKEN_*`，已为 8 位老师分配）——邀请码/角色体系可参考其分发模型
