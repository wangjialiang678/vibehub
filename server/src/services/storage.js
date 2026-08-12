import { existsSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
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

export function pruneProjectArtifacts(projectId, additionalRetainedIds = []) {
  const retained = retainedVersionIds(projectId);
  for (const versionId of additionalRetainedIds) if (versionId) retained.add(versionId);
  const versions = db.prepare('SELECT id,preview_id FROM versions WHERE project_id=? AND artifact_pruned=0').all(projectId);
  let pruned = 0;
  for (const version of versions) {
    if (retained.has(version.id)) continue;
    // 只删除版本快照和指向它的预览链接；元数据和内容哈希仍留在数据库。
    rmSync(previewLink(version.preview_id), { force: true });
    rmSync(versionDir(version.id), { recursive: true, force: true });
    db.prepare('UPDATE versions SET artifact_pruned=1 WHERE id=?').run(version.id);
    pruned += 1;
  }
  return pruned;
}

export function cleanupTmp(maxAgeMs = 60 * 60 * 1000) {
  if (!existsSync(paths.tmp)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of readdirSync(paths.tmp, { withFileTypes: true })) {
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
