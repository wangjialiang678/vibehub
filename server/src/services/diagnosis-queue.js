import { nanoid } from 'nanoid';
import { db, now } from '../lib/db.js';
import { applyModelTranslation, createRunningDiagnosis, markDiagnosisFailed, runDiagnosis } from './diagnosis.js';
import { generateModelTranslation } from './model-summary.js';

function createReviewAfterDiagnosis({ versionId, projectId, campId }) {
  const project = db.prepare('SELECT pending_version_id FROM projects WHERE id=?').get(projectId);
  // 后续版本已经提交时，旧任务仍应留一条完整历史，但绝不能重新进入老师队列。
  const status = project?.pending_version_id === versionId ? 'pending' : 'superseded';
  const id = 'r_' + nanoid(10);
  // 诊断恢复与正常提交可能短暂重叠；单条条件 INSERT 避免「先查再插」的竞态。
  const inserted = db.prepare(`INSERT INTO reviews (id,version_id,project_id,camp_id,status,created_at)
                               SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM reviews WHERE version_id=?)`)
    .run(id, versionId, projectId, campId, status, now(), versionId).changes;
  return inserted ? id : db.prepare('SELECT id FROM reviews WHERE version_id=? ORDER BY created_at LIMIT 1').get(versionId)?.id;
}

function markBlockedVersion({ versionId, projectId }) {
  // 只处理当前待审版本，不能覆盖同项目随后提交的新版状态。
  db.prepare(`UPDATE projects SET pending_version_id=NULL, dev_status='needs_revision',
              publish_status=CASE WHEN live_version_id IS NULL THEN 'unpublished' ELSE 'published' END,
              updated_at=? WHERE id=? AND pending_version_id=?`)
    .run(now(), projectId, versionId);
}

/** 单进程串行队列：2 vCPU 上避免多份诊断、HTTP 探测和模型调用互相抢资源。 */
export class DiagnosisQueue {
  constructor({ probePreview, log }) {
    this.probePreview = probePreview;
    this.log = log;
    this.pending = new Set();
    this.tasks = [];
    this.running = false;
  }

  enqueue(task) {
    if (this.pending.has(task.versionId)) return { queued: false, diagnosisId: null };
    const diagnosisId = task.diagnosisId || createRunningDiagnosis({ versionId: task.versionId });
    this.pending.add(task.versionId);
    this.tasks.push({ ...task, diagnosisId });
    this.drain();
    return { queued: true, diagnosisId };
  }

  drain() {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => this.run().catch((error) => this.log?.error({ err: error }, '诊断队列异常退出')));
  }

  async run() {
    while (this.tasks.length) {
      const task = this.tasks.shift();
      let report = null;
      try {
        let probe;
        try {
          const previewUrl = typeof task.previewUrl === 'function' ? task.previewUrl() : task.previewUrl;
          if (!previewUrl) throw new Error('预览已不再开放');
          probe = await this.probePreview(previewUrl);
        } catch (error) {
          this.log?.warn({ err: error, version_id: task.versionId }, '预览探测失败，按未验证处理');
          probe = { status: 'unknown', entry_status: null, resource_failures: [], resource_checked: 0, checked_at: now() };
        }
        report = runDiagnosis({
          versionId: task.versionId, projectId: task.projectId, versionDir: task.versionDir,
          flows: task.flows, previewProbe: probe, diagnosisId: task.diagnosisId,
        });
        // blocker 的人话结论必须保持确定性，不能被模型写成“可以提交”。
        const translation = report.status === 'blocked'
          ? null
          : await generateModelTranslation({ ...report, projectId: task.projectId }, { log: this.log });
        if (translation) applyModelTranslation(report.id, translation);
      } catch (error) {
        this.log?.error({ err: error, version_id: task.versionId }, '诊断失败，保留预览供老师审核');
        markDiagnosisFailed(task.diagnosisId, error);
      } finally {
        // blocker 不是给老师的可选提示：它不能进入审核队列，更不能发布。
        // 诊断执行失败仍保留原有审核兜底，避免基础设施故障卡死正常作品。
        try {
          if (report?.status === 'blocked') markBlockedVersion(task);
          else createReviewAfterDiagnosis(task);
        } catch (error) { this.log?.error({ err: error, version_id: task.versionId }, '更新诊断后的审核状态失败'); }
        this.pending.delete(task.versionId);
      }
    }
    this.running = false;
    // drain 结束与新任务入队之间若恰好交错，再检查一次防止遗留任务。
    if (this.tasks.length) this.drain();
  }

  snapshot() {
    return { queued: this.tasks.length, running: this.running ? 1 : 0, dedupe_keys: this.pending.size };
  }
}
