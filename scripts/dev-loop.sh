#!/usr/bin/env bash
# VibeHub 全自动闭环开发工作流
#
#   codex 开发  →  测试（loop-test）  →  codex sol 代码审核
#        ↑                                        │
#        └──────── 红了：把失败/审核意见回灌 ──────┘
#
# codex 写代码；测试和审核任一不过，就把具体失败拼回 prompt 让 codex 修；
# 直到「测试全绿 且 审核 PASS」，或达到最大轮次停下交给人。
#
# 这对应 VibeLoop 的开发期闭环：AI 开发 + 确定性验证 + 独立审核。
# 注意：它不自动 commit/push（决策 6：合并仍由人点头）——只把代码改到「可交付」状态。
#
# 用法：
#   bash scripts/dev-loop.sh <任务描述文件.md> [最大轮次=4]
#
# 环境：需要 tcd（codex 驱动）。开发用 terra，审核用 sol。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_FILE="${1:?用法: dev-loop.sh <任务描述文件.md> [最大轮次]}"
MAX="${2:-4}"
DL="$ROOT/.devloop"
mkdir -p "$DL"
[ -f "$TASK_FILE" ] || { echo "任务文件不存在: $TASK_FILE"; exit 1; }

c_g=$'\e[32m'; c_r=$'\e[31m'; c_y=$'\e[33m'; c_d=$'\e[2m'; c_x=$'\e[0m'
log()  { echo "${c_d}[dev-loop]${c_x} $*"; }
head() { echo; echo "${c_y}══ $* ══${c_x}"; }

# 等一个 tcd job 到达稳定空闲（连续 2 次采样都不在 Working，去抖）。
# 完成判定不信单次 state（会在 idle/working 抖动），用「连续空闲」+ 超时。
wait_codex() {
  local job="$1" max_s="${2:-2400}" waited=0 idle=0
  while [ "$waited" -lt "$max_s" ]; do
    local working
    working="$(tcd check "$job" --json 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); t=(d.get('pane_tail') or '')+' '.join(d.get('activity') or [])
    print('W' if 'Working (' in t else 'I')
except: print('W')" 2>/dev/null)"
    if [ "$working" = "I" ]; then
      idle=$((idle+1))
      [ "$idle" -ge 2 ] && return 0
    else
      idle=0
    fi
    sleep 30; waited=$((waited+30))
  done
  log "${c_r}codex job $job 超时（${max_s}s）${c_x}"
  return 1
}

run_codex() {   # provider-model  prompt-file  → job id
  local model="$1" pf="$2"
  tcd start -p codex --model "$model" -m "$(cat "$pf")" -d "$ROOT" --timeout 60 2>/dev/null \
    | grep -oE 'Job started: [a-f0-9]+' | awk '{print $3}'
}

BASE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo '(no-git)')"
log "任务：$TASK_FILE"
log "基线 commit：$BASE"
FEEDBACK=""

for ROUND in $(seq 1 "$MAX"); do
  head "第 $ROUND / $MAX 轮 · 开发（codex terra）"

  # 拼开发 prompt：任务 + 上轮反馈（若有）
  {
    echo "严格按下面的任务实现。只改必要文件，保持既有测试全绿，遵守 CLAUDE.md 的硬约束。"
    echo
    echo "## 任务"; cat "$TASK_FILE"
    if [ -n "$FEEDBACK" ]; then
      echo; echo "## 上一轮没通过，必须修复以下问题"; echo "$FEEDBACK"
    fi
    echo; echo "完成后确保 bash scripts/loop-test.sh 能全绿。不要自己 git commit。"
  } > "$DL/dev-prompt.md"

  JOB="$(run_codex gpt-5.6-terra "$DL/dev-prompt.md")"
  [ -n "$JOB" ] && log "开发 job=$JOB" || { log "${c_r}派发失败${c_x}"; exit 1; }
  wait_codex "$JOB" 3000 || exit 1

  head "第 $ROUND 轮 · 测试（loop-test）"
  if bash "$ROOT/scripts/loop-test.sh" > "$DL/test-$ROUND.log" 2>&1; then
    log "${c_g}测试全绿${c_x}"
  else
    log "${c_r}测试失败${c_x}（见 $DL/test-$ROUND.log）"
    FEEDBACK="【测试失败】以下闭环测试没通过，请修复：
$(grep -E '✗|失败|Error|assert' "$DL/test-$ROUND.log" | head -30)"
    continue
  fi

  head "第 $ROUND 轮 · 代码审核（codex sol）"
  cat > "$DL/review-prompt.md" <<EOF
你是独立代码审核者。审核从 $BASE 到当前工作区的改动（git diff $BASE -- . 以及未跟踪文件），针对本次任务：

$(cat "$TASK_FILE")

只找**会导致缺陷、安全问题或明显偏离任务**的问题，不挑风格。逐条写：文件:行 → 问题 → 为什么。
读 CLAUDE.md 的硬约束核对有没有被违反。
把结论写到文件 $DL/review-$ROUND.md，最后一行必须是：
VERDICT: PASS   （没有必须修的问题）
或
VERDICT: FAIL   （有必须修的问题，上面已逐条列出）
只写这一个文件，不要改代码。
EOF
  RJOB="$(run_codex gpt-5.6-sol "$DL/review-prompt.md")"
  [ -n "$RJOB" ] && log "审核 job=$RJOB" || { log "${c_r}审核派发失败${c_x}"; exit 1; }
  wait_codex "$RJOB" 1800 || exit 1

  if [ ! -f "$DL/review-$ROUND.md" ]; then
    log "${c_y}审核没产出文件，视为需人工介入${c_x}"; exit 2
  fi
  VERDICT="$(grep -oE 'VERDICT:\s*(PASS|FAIL)' "$DL/review-$ROUND.md" | grep -oE 'PASS|FAIL' | tail -1)"
  if [ "$VERDICT" = "PASS" ]; then
    head "${c_g}闭环通过（$ROUND 轮）${c_x}"
    log "测试全绿 + 审核 PASS。改动已就绪，等你 review 后合并。"
    git -C "$ROOT" -c color.ui=always diff --stat "$BASE" 2>/dev/null | tail -20
    log "审核报告：$DL/review-$ROUND.md"
    exit 0
  else
    log "${c_r}审核 FAIL${c_x}，把意见回灌下一轮"
    FEEDBACK="【审核未通过】审核者指出以下问题，请修复：
$(sed '/VERDICT:/d' "$DL/review-$ROUND.md" | head -40)"
  fi
done

head "${c_r}达到最大轮次（${MAX}）仍未通过闭环${c_x}"
log "最后一轮反馈见 ${DL}，请人工介入。"
exit 1
