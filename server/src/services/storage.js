import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../lib/db.js';
import { LIMITS, paths } from '../lib/config.js';
import { previewLink, versionDir } from './publish.js';

export class ProjectQuotaError extends Error {
  constructor(usedBytes, incomingBytes) {
    super('项目磁盘空间不足');
    this.usedBytes = usedBytes;
    this.incomingBytes = incomingBytes;
  }
}

function approvedVersionIds(projectId) {
  return db.prepare(`SELECT version_id FROM reviews WHERE project_id=? AND status='approved'
                     ORDER BY decided_at DESC, created_at DESC LIMIT 2`)
    .all(projectId).map((row) => row.version_id);
}

/** 当前正式版、上一正式版与当前待审版之外的产物都可删除。 */
export function retainedVersionIds(projectId, pendingVersionId = undefined) {
  const project = db.prepare('SELECT live_version_id,pending_version_id FROM projects WHERE id=?').get(projectId);
  if (!project) return new Set();
  const retained = new Set(approvedVersionIds(projectId));
  if (project.live_version_id) retained.add(project.live_version_id);
  const pending = pendingVersionId === undefined ? project.pending_version_id : pendingVersionId;
  if (pending) retained.add(pending);
  return retained;
}

function artifactBytes(projectId, retained = null) {
  const rows = db.prepare('SELECT id,bundle_size FROM versions WHERE project_id=? AND artifact_pruned=0').all(projectId);
  return rows.reduce((total, row) => (!retained || retained.has(row.id) ? total + Number(row.bundle_size || 0) : total), 0);
}

function uploadBytes(projectId) {
  return Number(db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM baas_files WHERE project_id=?').get(projectId)?.n || 0);
}

export function projectDiskUsage(projectId) {
  return {
    used_bytes: artifactBytes(projectId) + uploadBytes(projectId),
    quota_bytes: LIMITS.projectDiskBytes,
  };
}

/** 新版本会替换旧待审版本，因此预估时不把旧待审产物计入额度。 */
export function assertProjectedQuota(projectId, incomingBytes) {
  const retained = retainedVersionIds(projectId, null);
  const used = artifactBytes(projectId, retained) + uploadBytes(projectId);
  if (used + incomingBytes > LIMITS.projectDiskBytes) throw new ProjectQuotaError(used, incomingBytes);
  return { used_bytes: used, quota_bytes: LIMITS.projectDiskBytes };
}

export function pruneProjectArtifacts(projectId, { removeQuarantine = rmSync } = {}) {
  const retained = retainedVersionIds(projectId);
  const versions = db.prepare('SELECT id,preview_id FROM versions WHERE project_id=? AND artifact_pruned=0').all(projectId);
  let pruned = 0;
  const failures = [];
  for (const version of versions) {
    if (retained.has(version.id)) continue;
    const versionPath = versionDir(version.id);
    const previewPath = previewLink(version.preview_id);
    const quarantineId = randomUUID();
    const quarantine = join(paths.tmp, `prune_recovery_${quarantineId}`);
    const deleteQuarantine = join(paths.tmp, `prune_delete_${quarantineId}`);
    const quarantinedVersion = join(quarantine, 'version');
    const quarantinedPreview = join(quarantine, 'preview');
    let versionMoved = false;
    let previewMoved = false;
    let transactionStarted = false;
    try {
      mkdirSync(quarantine, { recursive: true });
      // lstat 能识别目标已丢失的断链；rename 移动的是链接本身，不会跟随目标。
      try { lstatSync(previewPath); renameSync(previewPath, quarantinedPreview); previewMoved = true; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      try { lstatSync(versionPath); renameSync(versionPath, quarantinedVersion); versionMoved = true; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }

      // 文件均已可恢复地隔离后，才提交数据库清理标记。
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      db.prepare('UPDATE versions SET artifact_pruned=1 WHERE id=?').run(version.id);
      db.exec('COMMIT');
      transactionStarted = false;
      pruned += 1;
      // 提交后先把受保护隔离区改名为待删除；删除失败可由 cleanupTmp 安全收敛。
      try {
        renameSync(quarantine, deleteQuarantine);
        removeQuarantine(deleteQuarantine, { recursive: true, force: true });
      } catch { /* rename 失败仍保守保留 recovery；删除失败由 cleanupTmp 收敛 delete */ }
    } catch (error) {
      if (transactionStarted) {
        try { db.exec('ROLLBACK'); } catch { /* 记录原始清理错误 */ }
      }
      const recoveryErrors = [];
      // 先恢复链接目标，再恢复链接本身；两者均使用同文件系统原子 rename。
      if (versionMoved) {
        try { renameSync(quarantinedVersion, versionPath); }
        catch (recoveryError) { recoveryErrors.push(recoveryError); }
      }
      if (previewMoved) {
        try { renameSync(quarantinedPreview, previewPath); }
        catch (recoveryError) { recoveryErrors.push(recoveryError); }
      }
      let recoveryPath = null;
      if (recoveryErrors.length) {
        // 隔离区里仍有唯一副本时绝不能删除，保留受保护名称等待人工/后续恢复。
        recoveryPath = quarantine;
      } else {
        try { rmSync(quarantine, { recursive: true, force: true }); } catch { /* 没有唯一副本，可由 cleanupTmp 回收 */ }
      }
      failures.push({ version_id: version.id, error, recovery_errors: recoveryErrors, recovery_path: recoveryPath });
    }
  }
  return { pruned, failures };
}

export function cleanupTmp(maxAgeMs = 60 * 60 * 1000) {
  if (!existsSync(paths.tmp)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of readdirSync(paths.tmp, { withFileTypes: true })) {
    // 清理恢复失败时，这里可能保存着 artifact 的唯一副本，不能按普通临时文件删除。
    if (entry.name.startsWith('prune_recovery_')) continue;
    const target = join(paths.tmp, entry.name);
    try {
      if (statSync(target).mtimeMs >= cutoff) continue;
      rmSync(target, { recursive: entry.isDirectory(), force: true });
      removed += 1;
    } catch {
      // 临时文件可能正由上传请求写入，下一轮再清理即可。
    }
  }
  return removed;
}

export function diskHealth() {
  try {
    const stats = statfsSync(paths.versions);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const available = Number(stats.bavail) * Number(stats.bsize);
    const usedPercent = total ? Math.round((100 * (total - available)) / total) : 0;
    return { used_percent: usedPercent, warning: usedPercent >= 80 };
  } catch {
    return { used_percent: null, warning: false };
  }
}
