import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { listFiles } from './unpack.js';
import { db, now } from '../lib/db.js';
import { nanoid } from 'nanoid';

export const POLICY_VERSION = 'p1-2026-07-25';

/**
 * 诊断的三段式（见 docs/specs/architecture.md §5）：
 *   ① 确定性事实采集（不花钱）
 *   ② 确定性评分——分数由检查器算，模型不许碰
 *   ③ 模型翻译成人话（P0 先用模板文案兜底）
 *
 * 硬规则（需求文档 §9.1.3 / §14.6）：
 *   - 不适用的项不进分母，不记 0 分
 *   - 适用但没证据 → unknown，得 0 分，显示「未验证」
 *   - is_blocker 独立于分数，不偷偷封顶
 *   - 每项都带 evidence_level，客户端上报的不得标为 verified
 */

// ① 事实采集
export function collectFacts(versionDir, projectId) {
  const files = listFiles(versionDir);
  const htmlFiles = files.filter((f) => ['.html', '.htm'].includes(extname(f).toLowerCase()));
  const hasIndex = files.includes('index.html');
  const fileSet = new Set(files.map((f) => f.split('\\').join('/')));

  const missingRefs = [];
  const fetchTargets = new Set();
  let usesSdk = false;
  let placeholders = 0;

  for (const rel of files) {
    const ext = extname(rel).toLowerCase();
    if (!['.html', '.htm', '.css', '.js', '.mjs'].includes(ext)) continue;
    let text;
    try { text = readFileSync(join(versionDir, rel), 'utf8'); } catch { continue; }

    if (/\bvibehub\s*\.\s*(save|list|upload|counter|ai)\b/.test(text)) usesSdk = true;
    placeholders += (text.match(/TODO|Lorem ipsum|示例文本|待补充|placeholder/gi) || []).length;

    for (const m of text.matchAll(/(?:href|src)=["']([^"'#][^"']*)["']/g)) {
      const url = m[1];
      if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('mailto:')) continue;
      const clean = url.split('?')[0].split('#')[0].replace(/^\.\//, '');
      if (!clean || clean.startsWith('/')) continue;
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
      const resolved = normalize(dir + clean);
      if (resolved && !fileSet.has(resolved) && !resolved.endsWith('/')) {
        missingRefs.push({ file: rel, ref: url });
      }
    }
    for (const m of text.matchAll(/fetch\(\s*["'`]([^"'`]+)/g)) fetchTargets.add(m[1]);
  }

  // 运行时台账：作品实际调过哪些平台接口（这是事实，不是猜）
  const calls = db.prepare(
    `SELECT kind, SUM(ok) AS ok, COUNT(*) AS total FROM baas_calls
     WHERE project_id = ? AND at > datetime('now','-30 days') GROUP BY kind`
  ).all(projectId);
  const totalCalls = calls.reduce((s, c) => s + Number(c.total), 0);
  const okCalls = calls.reduce((s, c) => s + Number(c.ok), 0);
  const records = db.prepare('SELECT COUNT(*) AS n FROM baas_records WHERE project_id = ?').get(projectId);

  return {
    file_count: files.length,
    html_count: htmlFiles.length,
    has_index: hasIndex,
    missing_refs: missingRefs.slice(0, 20),
    missing_ref_count: missingRefs.length,
    fetch_targets: [...fetchTargets].slice(0, 20),
    uses_sdk: usesSdk,
    placeholder_hits: placeholders,
    baas_calls_total: totalCalls,
    baas_calls_ok: okCalls,
    baas_records: Number(records?.n || 0),
  };
}

function normalize(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// ② 确定性评分
export function score(facts, { declaredFlows = [], previewOk = null } = {}) {
  const items = [];
  const add = (o) => items.push({ evidence_level: 'verified', is_blocker: false, ...o });

  add({
    check_key: 'artifact_entry',
    label: '网页有首页文件',
    applicability: 'applicable',
    max_points: 20,
    earned_points: facts.has_index ? 20 : 0,
    result: facts.has_index ? 'pass' : 'fail',
    is_blocker: !facts.has_index,
    evidence: { has_index: facts.has_index, file_count: facts.file_count },
  });

  add({
    check_key: 'refs_resolve',
    label: '页面引用的文件都在',
    applicability: 'applicable',
    max_points: 20,
    earned_points: facts.missing_ref_count === 0 ? 20 : Math.max(0, 20 - facts.missing_ref_count * 5),
    result: facts.missing_ref_count === 0 ? 'pass' : 'fail',
    is_blocker: facts.missing_ref_count > 3,
    evidence: { missing: facts.missing_refs, count: facts.missing_ref_count },
  });

  // 预览可访问：没探到就是 unknown，不能猜
  add({
    check_key: 'preview_reachable',
    label: '预览地址能打开',
    applicability: 'applicable',
    max_points: 20,
    earned_points: previewOk === true ? 20 : 0,
    result: previewOk === true ? 'pass' : previewOk === false ? 'fail' : 'unknown',
    evidence_level: previewOk === null ? 'human_required' : 'verified',
    is_blocker: previewOk === false,
    evidence: { probed: previewOk },
  });

  // 服务端维度：**没用到平台数据能力的作品，这一项不适用，不进分母**
  // （这是我原设计的缺陷，纯展示型作品会永远卡在 70 分）
  const usesBackend = facts.uses_sdk || facts.baas_calls_total > 0;
  if (usesBackend) {
    const rate = facts.baas_calls_total ? facts.baas_calls_ok / facts.baas_calls_total : 0;
    add({
      check_key: 'baas_connected',
      label: '数据接口已连接',
      applicability: 'applicable',
      max_points: 20,
      earned_points: (facts.baas_calls_total > 0 ? 10 : 0) + (rate >= 0.9 ? 5 : 0) + (facts.baas_records > 0 ? 5 : 0),
      result: facts.baas_calls_total > 0 ? 'pass' : 'unknown',
      evidence: { calls: facts.baas_calls_total, ok_rate: Number(rate.toFixed(2)), records: facts.baas_records },
    });
  } else {
    add({
      check_key: 'baas_connected',
      label: '数据接口已连接',
      applicability: 'not_applicable',
      max_points: 20, earned_points: 0, result: 'not_applicable',
      evidence: { reason: '这个作品没有用到平台的数据能力，本项不计入完成度' },
    });
  }

  // 核心路径：学员声明了才适用；P0 没有自动验证手段 → unknown + 需人工确认
  if (declaredFlows.length) {
    add({
      check_key: 'core_flows',
      label: '核心操作路径可完成',
      applicability: 'applicable',
      max_points: 20, earned_points: 0, result: 'unknown',
      evidence_level: 'human_required',
      evidence: { flows: declaredFlows, note: '需要人工或后续自动化验证' },
    });
  } else {
    add({
      check_key: 'core_flows',
      label: '核心操作路径可完成',
      applicability: 'not_applicable',
      max_points: 20, earned_points: 0, result: 'not_applicable',
      evidence: { reason: '学员没有声明核心操作路径（deploy 时可用 --flows 声明）' },
    });
  }

  add({
    check_key: 'content_ready',
    label: '没有明显的占位内容',
    applicability: 'applicable',
    max_points: 10,
    earned_points: facts.placeholder_hits === 0 ? 10 : facts.placeholder_hits <= 3 ? 5 : 0,
    result: facts.placeholder_hits === 0 ? 'pass' : 'fail',
    evidence: { placeholder_hits: facts.placeholder_hits },
  });

  // 一致性守卫：结论是 unknown 就不能标成「已验证」，否则老师会误以为查过了
  for (const i of items) {
    if (i.result === 'unknown' && i.evidence_level === 'verified') i.evidence_level = 'human_required';
  }

  const applicable = items.filter((i) => i.applicability === 'applicable');
  const earned = applicable.reduce((s, i) => s + i.earned_points, 0);
  const max = applicable.reduce((s, i) => s + i.max_points, 0);
  const percent = max ? Math.round((100 * earned) / max) : 0;
  const blocked = items.some((i) => i.is_blocker);

  return { items, percent, earned, max, blocked };
}

// ③ 结论（P0 用模板；P1 换模型翻译，模型不许改分数）
export function summarize({ items, percent, blocked }) {
  const fails = items.filter((i) => i.applicability === 'applicable' && i.result === 'fail');
  const unknowns = items.filter((i) => i.applicability === 'applicable' && i.result === 'unknown');
  const next = [];
  for (const f of fails) {
    if (f.check_key === 'artifact_entry') next.push('你的网页缺少 index.html 首页文件，先补一个再提交');
    if (f.check_key === 'refs_resolve') next.push(`有 ${f.evidence.count} 个引用的文件找不到，页面可能显示不全`);
    if (f.check_key === 'preview_reachable') next.push('预览打不开，检查一下首页文件是不是能正常加载');
    if (f.check_key === 'content_ready') next.push('页面里还有占位文字没替换');
  }
  for (const u of unknowns) {
    if (u.check_key === 'core_flows') next.push('核心功能还没验证过，建议自己走一遍主要流程');
  }
  let summary;
  if (blocked) summary = '有阻塞问题，先修好再提交审核。';
  else if (percent >= 85) summary = '已具备完整预览版本，可以提交老师审核了。';
  else if (percent >= 60) summary = '主要部分能用了，还有一些地方可以继续打磨。';
  else summary = '还在早期阶段，先把首页和主要内容做出来。';

  return { summary, next_steps: next.slice(0, 3) };
}

export function runDiagnosis({ versionId, projectId, versionDir, flows, previewOk }) {
  const facts = collectFacts(versionDir, projectId);
  const scored = score(facts, { declaredFlows: flows || [], previewOk });
  const { summary, next_steps } = summarize(scored);
  const status = scored.blocked ? 'blocked' : scored.percent >= 85 ? 'healthy' : 'needs_work';
  const id = 'd_' + nanoid(12);
  const ts = now();
  db.prepare(
    `INSERT INTO diagnoses (id,version_id,status,score,policy_version,facts,items,summary,next_steps,model,created_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, versionId, status, scored.percent, POLICY_VERSION,
    JSON.stringify(facts), JSON.stringify(scored.items), summary,
    JSON.stringify(next_steps), null, ts, ts);
  return { id, status, score: scored.percent, items: scored.items, summary, next_steps, facts };
}
