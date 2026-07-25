import { db } from '../lib/db.js';
import { worksUrl, previewUrl } from '../lib/config.js';
import { projectDiskUsage } from '../services/storage.js';
import { calculateDiagnosisMetrics } from '../services/diagnosis.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function versionView(v) {
  if (!v) return null;
  const dep = db.prepare(`SELECT * FROM deployments WHERE version_id=? AND target='preview' ORDER BY started_at DESC LIMIT 1`).get(v.id);
  return {
    id: v.id, label: v.label, seq: v.seq, summary: v.summary,
    flows: j(v.flows, []), rewrites: j(v.rewrites, []),
    file_count: v.file_count, bundle_size: v.bundle_size,
    submitted_at: v.submitted_at,
    preview_url: dep?.url || previewUrl(v.preview_id),
  };
}

export function diagnosisView(versionId) {
  const d = db.prepare('SELECT * FROM diagnoses WHERE version_id=? ORDER BY created_at DESC LIMIT 1').get(versionId);
  if (!d) return null;
  const items = j(d.items, []);
  // 运行中/失败的诊断还没有检查器产出的 items，不能把空分母伪装为 0%。
  const hasComputedMetrics = ['healthy', 'needs_work', 'blocked'].includes(d.status);
  const metrics = hasComputedMetrics
    ? calculateDiagnosisMetrics(items)
    : {
        earned: null, max: null,
        applicable_earned: null, applicable_max: null,
        applicable_items: null, verified_applicable_items: null,
        completeness: null, verified_ratio: null,
      };
  return {
    id: d.id, version_id: d.version_id, status: d.status,
    // score 是旧客户端兼容字段，保持与检查器复算出的完成度完全相同。
    score: hasComputedMetrics ? metrics.completeness : null,
    policy_version: d.policy_version,
    items,
    facts: j(d.facts, {}),
    model_items: j(d.model_items, []),
    // 两项指标都能从返回的分子/分母确定性复算；score 保留给旧客户端。
    ...metrics,
    blocked: items.some((i) => i.is_blocker),
    summary: d.summary, next_steps: j(d.next_steps, []),
    finished_at: d.finished_at,
  };
}

function latestCompletedDiagnosis(projectId) {
  // 只回退到「真正算出了结果」的诊断。failed 没有检查器结论，不能当成上一份可展示报告，
  // 否则新版本诊断中时会被旧的 failed 伪装成「这次诊断失败」，掩盖 v2 正在正常诊断。
  const row = db.prepare(`SELECT d.version_id FROM diagnoses d JOIN versions v ON v.id=d.version_id
                          WHERE v.project_id=? AND d.status IN ('healthy','needs_work','blocked')
                          ORDER BY d.created_at DESC LIMIT 1`).get(projectId);
  return row ? diagnosisView(row.version_id) : null;
}

export function projectSnapshot(projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p) return null;
  const owner = db.prepare('SELECT * FROM users WHERE id=?').get(p.owner_user_id);
  const camp = db.prepare('SELECT * FROM camps WHERE id=?').get(p.camp_id);
  const live = p.live_version_id ? db.prepare('SELECT * FROM versions WHERE id=?').get(p.live_version_id) : null;
  const pending = p.pending_version_id ? db.prepare('SELECT * FROM versions WHERE id=?').get(p.pending_version_id) : null;
  const lastReview = db.prepare(`SELECT * FROM reviews WHERE project_id=? ORDER BY created_at DESC LIMIT 1`).get(projectId);
  const views = db.prepare('SELECT COALESCE(SUM(views),0) AS n FROM page_views WHERE project_id=?').get(projectId);
  const todayViews = db.prepare(`SELECT COALESCE(views,0) AS n FROM page_views WHERE project_id=? AND day=date('now')`).get(projectId);

  // 取「项目最新版本」的诊断，而不是只看 pending。
  // blocker 版本会被 markBlockedVersion 清空 pending_version_id（退回学员修改），
  // 若只从 pending/live 取，学员看板就看不到这份 blocked 诊断和修复原因了。
  const latestVersion = db.prepare('SELECT id FROM versions WHERE project_id=? ORDER BY seq DESC LIMIT 1').get(projectId);
  const latestVersionDiagnosis = latestVersion ? diagnosisView(latestVersion.id) : null;
  const diagnosisRunning = latestVersionDiagnosis?.status === 'running';
  const latestDiagnosis = diagnosisRunning
    ? { ...(latestCompletedDiagnosis(projectId) || latestVersionDiagnosis), stale: true, pending_version_id: latestVersion.id }
    : latestVersionDiagnosis;

  return {
    project: {
      id: p.id, slug: p.slug, title: p.title, tagline: p.tagline, category: p.category,
      dev_status: p.dev_status, publish_status: p.publish_status,
      visibility: p.visibility || camp.visibility_default,
      live_url: p.live_version_id ? worksUrl(owner.username, p.slug) : null,
      updated_at: p.updated_at,
    },
    owner: { id: owner.id, username: owner.username, display_name: owner.display_name },
    camp: { id: camp.id, slug: camp.slug, name: camp.name, kind: camp.kind },
    live_version: versionView(live),
    pending_version: versionView(pending),
    latest_diagnosis: latestDiagnosis,
    last_review: lastReview ? {
      status: lastReview.status, comment: lastReview.comment,
      decided_at: lastReview.decided_at, version_id: lastReview.version_id,
    } : null,
    stats: { total_views: Number(views?.n || 0), today_views: Number(todayViews?.n || 0) },
    storage: projectDiskUsage(projectId),
    timeline: timeline(projectId),
  };
}

/** 「最近发生了什么」：提交 / 部署 / 审核三类事件按时间合并 */
export function timeline(projectId, limit = 12) {
  const events = [];
  for (const v of db.prepare('SELECT * FROM versions WHERE project_id=? ORDER BY seq DESC LIMIT 20').all(projectId)) {
    events.push({ at: v.submitted_at, kind: 'submit', title: `提交 ${v.label}`, detail: v.summary || '新版本已提交' });
  }
  for (const r of db.prepare('SELECT * FROM reviews WHERE project_id=? AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 20').all(projectId)) {
    const v = db.prepare('SELECT label FROM versions WHERE id=?').get(r.version_id);
    events.push({
      at: r.decided_at,
      kind: r.status === 'approved' ? 'publish' : 'reject',
      title: r.status === 'approved' ? `发布 ${v?.label || ''}` : `退回 ${v?.label || ''}`,
      detail: r.comment || (r.status === 'approved' ? '当前线上版本' : '等待修改'),
    });
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}
