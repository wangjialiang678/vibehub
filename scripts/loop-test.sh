#!/usr/bin/env bash
# VibeHub 本机全自动闭环测试
#
# 一条命令验证整条黄金路径 + 安全回归，绿灯才算通过。
# 这是 VibeLoop「层2·确定性自动化测试」——跟 auto-merge 无关，只自动验证代码对不对。
# 把它接进 vibeloop.yaml 的 verify：verify 越硬，将来越敢开 auto-merge。
#
# 用法：bash scripts/loop-test.sh
# 退出码：0=全绿；非0=某关失败（打印在哪一步）。
#
# 全程用独立临时数据目录 + 独立端口 + 独立 HOME，不碰真实数据和你的 ~/.vibehub 凭证。
set -uo pipefail
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 随机端口，避免上一次残留 server 占着固定端口导致连错服务（曾踩过）
PORT="${LOOP_TEST_PORT:-$(( 43000 + (RANDOM % 2000) ))}"
API="http://localhost:${PORT}"
TMP="$(mktemp -d /tmp/vibehub-loop.XXXXXX)"
export VIBEHUB_DATA_DIR="$TMP/data"
export VIBEHUB_PORT="$PORT"
export VIBEHUB_API="$API"
export HOME="$TMP/home"          # 隔离 CLI 凭证，不污染真实 ~/.vibehub
mkdir -p "$HOME"
SRV_PID=""
PASS=0; FAIL=0

c_g=$'\e[32m'; c_r=$'\e[31m'; c_d=$'\e[2m'; c_x=$'\e[0m'
ok()   { echo "  ${c_g}✓${c_x} $1"; PASS=$((PASS+1)); }
bad()  { echo "  ${c_r}✗${c_x} $1"; FAIL=$((FAIL+1)); }
step() { echo "${c_d}── $1 ──${c_x}"; }
jqp()  { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

cli() { node "$ROOT/skill/bin/vibehub" "$@"; }
req() { curl -s --noproxy '*' -m 10 "$@"; }

# ── 0. 单元测试 ──────────────────────────────────────────────
step "单元测试"
# 单测用 app.inject 不需要真实端口；隔离本脚本的 VIBEHUB_* 以免污染测试用的 WORKS_ORIGIN
if (cd "$ROOT/server" && env -u VIBEHUB_PORT -u VIBEHUB_API -u VIBEHUB_DATA_DIR npm test >/tmp/loop-unit.log 2>&1); then
  ok "server npm test 全绿（$(grep -oE 'tests [0-9]+' /tmp/loop-unit.log | tail -1)）"
else
  bad "server npm test 失败，见 /tmp/loop-unit.log"; exit 1
fi

# ── 1. 起服务 + 种子 ─────────────────────────────────────────
step "起服务 + 种子数据"
SEED="$(cd "$ROOT/server" && node src/seed.js 2>/tmp/loop-seed.log)"
TEACHER_TOKEN="$(echo "$SEED" | jqp "d['teacher_token']")"
CODE="$(echo "$SEED" | jqp "d['student_invite_codes'][0]")"
[ -n "$TEACHER_TOKEN" ] && ok "种子：老师 token + 邀请码 $CODE" || { bad "种子失败"; exit 1; }

# 不用子 shell，SRV_PID 要是 node 本身的 PID，cleanup 才能真正杀掉它（残留会占端口）
( cd "$ROOT/server" && exec node src/index.js ) >/tmp/loop-server.log 2>&1 &
SRV_PID=$!
for i in $(seq 1 20); do req "$API/healthz" | grep -q '"ok":true' && break; sleep 0.5; done
req "$API/healthz" | grep -q '"ok":true' && ok "服务已启动 :${PORT}（pid ${SRV_PID}）" || { bad "服务起不来"; cat /tmp/loop-server.log; exit 1; }

# ── 2. 造展示型作品（首场形态：不碰 BaaS）────────────────────
step "学员接入与提交"
WORK="$TMP/work"; mkdir -p "$WORK/assets"
cat > "$WORK/index.html" <<'HTML'
<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>我的作品</title>
<link rel="stylesheet" href="/style.css"></head>
<body><h1>聆听城市的声音</h1><p>发现、记录并分享你身边的声音故事</p>
<img src="/assets/cover.svg" width="120"><button>探索</button></body></html>
HTML
printf 'body{font-family:system-ui;background:#fbf9f5;color:#242321;padding:40px}' > "$WORK/style.css"
printf '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#dde8f5"/></svg>' > "$WORK/assets/cover.svg"

cli bind "$CODE" >/tmp/loop-bind.log 2>&1 && ok "bind 成功" || { bad "bind 失败"; cat /tmp/loop-bind.log; exit 1; }
DEPLOY="$(cd "$WORK" && cli deploy --summary "闭环测试" --flows "探索" 2>&1)"
echo "$DEPLOY" | grep -q "已提交" && ok "deploy 成功" || { bad "deploy 失败"; echo "$DEPLOY"; exit 1; }
echo "$DEPLOY" | grep -q "undefined" && bad "deploy 输出含 undefined（异步契约回归）" || ok "deploy 无 undefined"
echo "$DEPLOY" | grep -qE 'claim=|preview-secret' && bad "deploy 输出泄露预览 bearer claim" || ok "deploy 不回显预览 bearer claim"

# ── 3. 诊断异步完成 ──────────────────────────────────────────
step "诊断异步完成"
STOK="$(python3 -c "import json;print(json.load(open('$HOME/.vibehub/credentials.json'))['token'])")"
DSTATUS=""
for i in $(seq 1 30); do
  DSTATUS="$(req -H "Authorization: Bearer $STOK" "$API/api/skill/project" | jqp "(d.get('latest_diagnosis') or {}).get('status','')")"
  case "$DSTATUS" in healthy|needs_work|blocked) break;; esac
  sleep 0.5
done
SCORE="$(req -H "Authorization: Bearer $STOK" "$API/api/skill/project" | jqp "(d.get('latest_diagnosis') or {}).get('score','?')")"
case "$DSTATUS" in
  healthy|needs_work|blocked) ok "诊断完成（${DSTATUS}，完成度 ${SCORE}%）";;
  *) bad "诊断没在超时内完成（status=${DSTATUS}）";;
esac

# ── 3b. 未审核预览访问控制 ─────────────────────────────────────
step "预览访问控制"
PREV_URL="$(req -H "Authorization: Bearer $STOK" "$API/api/skill/project" | jqp "d['pending_version']['preview_url']")"
PREV="$(echo "$PREV_URL" | grep -oE '_preview/[a-z0-9]+' | head -1 | cut -d/ -f2)"
ANON_PREVIEW="$(req -o /dev/null -w '%{http_code}' "$API/vibehub/_preview/$PREV/")"
if [ "$ANON_PREVIEW" = "404" ] || [ "$ANON_PREVIEW" = "401" ]; then
  ok "匿名访问未审核预览被拒（${ANON_PREVIEW}）"
else
  bad "匿名访问未审核预览返回 ${ANON_PREVIEW}（应 404/401）"
fi
OWNER_PREVIEW="$(req -X POST -H "Authorization: Bearer $STOK" "$API/api/previews/$PREV/grant" | jqp "d.get('preview_url','')")"
OWNER_CLAIM="$(python3 -c "import sys,urllib.parse;print(urllib.parse.parse_qs(urllib.parse.urlsplit(sys.argv[1]).query).get('claim',[''])[0])" "$OWNER_PREVIEW")"
OWNER_EXCHANGE="$(req -D "$TMP/owner-preview.headers" -c "$TMP/owner-preview.cookies" -o "$TMP/owner-preview.body" -w '%{http_code}' "$OWNER_PREVIEW")"
OWNER_LOCATION="$(awk '/^[Ll]ocation:/{sub(/^[^:]*:[[:space:]]*/,""); sub(/\r$/,""); print; exit}' "$TMP/owner-preview.headers")"
if [ "$OWNER_EXCHANGE" = "303" ] && [ -n "$OWNER_LOCATION" ] && ! echo "$OWNER_LOCATION" | grep -q 'claim=' && ! grep -q '聆听城市的声音' "$TMP/owner-preview.body"; then
  ok "owner claim 只换 cookie，并 303 到无 claim 地址"
else
  bad "owner claim 交换不安全（HTTP ${OWNER_EXCHANGE}，Location=${OWNER_LOCATION}）"
fi
OWNER_HC="$(req -b "$TMP/owner-preview.cookies" -o /dev/null -w '%{http_code}' "$API$OWNER_LOCATION")"
[ "$OWNER_HC" = "200" ] && ok "owner 可访问未审核预览" || bad "owner 预览返回 ${OWNER_HC}（应 200）"
TEACHER_PREVIEW="$(req -X POST -H "Authorization: Bearer $TEACHER_TOKEN" "$API/api/previews/$PREV/grant" | jqp "d.get('preview_url','')")"
TEACHER_HC="$(req -L -c "$TMP/teacher-preview.cookies" -o /dev/null -w '%{http_code}' "$TEACHER_PREVIEW")"
[ "$TEACHER_HC" = "200" ] && ok "同课程老师可访问未审核预览" || bad "老师预览返回 ${TEACHER_HC}（应 200）"
if [ -n "$OWNER_CLAIM" ] && ! grep -Fq "$OWNER_CLAIM" /tmp/loop-server.log; then
  ok "服务日志不记录明文 preview claim"
else
  bad "服务日志出现明文 preview claim"
fi

# ── 4. 老师审核 → 发布 → 正式地址可访问 ──────────────────────
step "审核发布"
RID="$(req -H "Authorization: Bearer $TEACHER_TOKEN" "$API/api/reviews?status=pending" | jqp "d['items'][0]['id']")"
[ -n "$RID" ] && ok "审核队列出现待处理项" || bad "审核队列为空（回归）"
MSG="$(req -X POST -H "Authorization: Bearer $TEACHER_TOKEN" -H "content-type: application/json" -H "Origin: http://localhost:5173" -d '{"comment":"通过"}' "$API/api/reviews/$RID/approve" | jqp "d.get('message','')")"
echo "$MSG" | grep -q "已发布" && ok "审核通过并发布" || bad "审核失败: $MSG"
# 重复 approve 应 409 不二次发布
CODE2="$(req -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TEACHER_TOKEN" -H "content-type: application/json" -H "Origin: http://localhost:5173" -d '{}' "$API/api/reviews/$RID/approve")"
[ "$CODE2" = "409" ] && ok "重复 approve 返回 409（不二次发布）" || bad "重复 approve 返回 ${CODE2}（应 409）"

UNAME="$(req -H "Authorization: Bearer $STOK" "$API/api/me" | jqp "d['user']['username']")"
SLUG="$(req -H "Authorization: Bearer $STOK" "$API/api/skill/project" | jqp "d['project']['slug']")"
HC="$(req -o /dev/null -w '%{http_code}' "$API/vibehub/$UNAME/$SLUG/")"
[ "$HC" = "200" ] && ok "正式地址 HTTP 200" || bad "正式地址 HTTP $HC"

# ── 5. 安全回归（Sol 审查发现的真漏洞，必须保持堵死）──────────
step "安全回归"
# #6 .env 泄露：造一个带 .env 的包重新 deploy，.env 不得可访问
printf 'API_KEY=sk-loop-secret\n' > "$WORK/.env"
(cd "$WORK" && cli deploy --summary "带env" >/dev/null 2>&1)
ENVHC="$(req -o /dev/null -w '%{http_code}' "$API/vibehub/_preview/$PREV/.env")"
[ "$ENVHC" = "404" ] && ok "#6 .env 不落盘（404）" || bad "#6 .env 泄露！HTTP $ENVHC"
rm -f "$WORK/.env"

# #2 BaaS 伪造 header 跨项目：应认不出项目 → 400
FORGE="$(req -o /dev/null -w '%{http_code}' -H "x-vibehub-project: /vibehub/$UNAME/$SLUG/" "$API/baas/v1/x")"
[ "$FORGE" = "400" ] && ok "#2 伪造 x-vibehub-project 被拒（400）" || bad "#2 伪造 header 返回 ${FORGE}（应 400）"

# #9 越权：无凭证读项目应 401（未登录）；已登录读别人项目应 404
IDOR="$(req -o /dev/null -w '%{http_code}' "$API/api/projects/p_nonexistent")"
if [ "$IDOR" = "401" ] || [ "$IDOR" = "404" ]; then
  ok "#9 未授权访问被拒（${IDOR}）"
else
  bad "#9 未授权访问返回 ${IDOR}（应 401/404）"
fi
# 已登录学员读一个不属于自己的项目 id，必须 404（不泄露存在性）
IDOR2="$(req -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $STOK" "$API/api/projects/p_someoneelse")"
[ "$IDOR2" = "404" ] && ok "#9 越权读他人项目返回 404" || bad "#9 越权读他人项目返回 ${IDOR2}（应 404）"

# ── 汇总 ─────────────────────────────────────────────────────
echo
if [ "$FAIL" -eq 0 ]; then
  echo "${c_g}闭环全绿：$PASS 项通过${c_x}"
  exit 0
else
  echo "${c_r}闭环失败：$FAIL 项未通过（$PASS 项通过）${c_x}"
  exit 1
fi
