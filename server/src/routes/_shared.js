import { db } from '../lib/db.js';
import { worksUrl, previewUrl } from '../lib/config.js';
import { projectDiskUsage } from '../services/storage.js';

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
  return {
    id: d.id, version_id: d.version_id, status: d.status, score: d.score,
    policy_version: d.policy_version,
    items,
    facts: j(d.facts, {}),
    model_items: j(d.model_items, []),
    // 分数可复算：把分母也给出去，前端能自己加一遍
    applicable_earned: items.filter((i) => i.applicability === 'applicable').reduce((s, i) => s + i.earned_points, 0),
    applicable_max: items.filter((i) => i.applicability === 'applicable').reduce((s, i) => s + i.max_points, 0),
    blocked: items.some((i) => i.is_blocker),
    summary: d.summary, next_steps: j(d.next_steps, []),
    finished_at: d.finished_at,
  };
}

function latestCompletedDiagnosis(projectId) {
  const row = db.prepare(`SELECT d.version_id FROM diagnoses d JOIN versions v ON v.id=d.version_id
                          WHERE v.project_id=? AND d.status <> 'running'
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

  const pendingDiagnosis = pending ? diagnosisView(pending.id) : null;
  const diagnosisRunning = pendingDiagnosis?.status === 'running';
  const latestDiagnosis = diagnosisRunning
    ? { ...(latestCompletedDiagnosis(projectId) || pendingDiagnosis), stale: true, pending_version_id: pending.id }
    : pendingDiagnosis || (live ? diagnosisView(live.id) : null);

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
