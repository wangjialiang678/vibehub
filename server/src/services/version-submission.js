import { nanoid } from 'nanoid';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db, now } from '../lib/db.js';
import { paths, previewUrl, worksPath } from '../lib/config.js';
import { flattenSingleRoot, injectSdk, rewriteAbsolutePaths, sha256File, UnpackError } from './unpack.js';
import { normalizeUpload, UploadFormatError } from './archive-input.js';
import { makePreview, previewLink, versionDir } from './publish.js';
import { createRunningDiagnosis, runDiagnosis, scanArtifactSecrets } from './diagnosis.js';
import { assertProjectedQuota, ProjectQuotaError, pruneProjectArtifacts } from './storage.js';
import { createPreviewGrant } from './preview-access.js';

const activeSubmissions = new Set();
const allowedSubmissionSources = new Set(['web', 'skill']);

export class SubmissionError extends Error {
  constructor(code, message, status = 400, hint) {
    super(message);
    this.name = 'SubmissionError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

function invalidMeta(message) {
  throw new SubmissionError('invalid_meta', message, 400);
}

export function validateSubmissionMeta(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalidMeta('提交说明必须是一个对象。');
  }
  const summary = input.summary == null ? '' : input.summary;
  const flows = input.flows == null ? [] : input.flows;
  const hasLabel = input.label != null;
  const label = hasLabel ? input.label : undefined;
  const hasProjectTitle = input.project_title != null;
  const projectTitle = hasProjectTitle ? input.project_title : undefined;
  const hasTagline = input.tagline != null;
  const tagline = hasTagline ? input.tagline : undefined;

  if (typeof summary !== 'string') invalidMeta('更新说明必须是字符串，最多 500 字。');
  if (summary.length > 500) invalidMeta('更新说明最多 500 字。');
  if (!Array.isArray(flows)) invalidMeta('核心玩法必须是字符串数组，最多 5 条。');
  if (flows.length > 5) invalidMeta('核心玩法最多 5 条。');
  if (flows.some((item) => typeof item !== 'string')) invalidMeta('每条核心玩法都必须是字符串。');
  // 先检查原始值再 trim，避免用两端空白绕过 80 字限制。
  if (flows.some((item) => item.length > 80)) invalidMeta('每条核心玩法最多 80 字。');
  if (hasLabel && typeof label !== 'string') invalidMeta('版本标签必须是字符串，最多 80 字。');
  if (hasLabel && label.length > 80) invalidMeta('版本标签最多 80 字。');
  if (hasProjectTitle && typeof projectTitle !== 'string') invalidMeta('作品名称必须是字符串，最多 80 字。');
  if (hasProjectTitle && projectTitle.length > 80) invalidMeta('作品名称最多 80 字。');
  if (hasTagline && typeof tagline !== 'string') invalidMeta('作品简介必须是字符串，最多 160 字。');
  if (hasTagline && tagline.length > 160) invalidMeta('作品简介最多 160 字。');

  const normalized = {
    summary: summary.trim(),
    flows: flows.map((item) => item.trim()).filter(Boolean),
  };
  if (hasLabel) normalized.label = label.trim();
  if (hasProjectTitle && projectTitle.trim()) normalized.project_title = projectTitle.trim();
  if (hasTagline && tagline.trim()) normalized.tagline = tagline.trim();
  return normalized;
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const codePoint = entity[1].toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    try { return String.fromCodePoint(codePoint); } catch { return match; }
  });
}

export function extractDocumentTitle(indexPath) {
  try {
    const html = readFileSync(indexPath, 'utf8').slice(0, 1024 * 1024);
    const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (!match) return null;
    const title = decodeHtmlEntities(match[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    return title ? title.slice(0, 80) : null;
  } catch {
    return null;
  }
}

function latestReviewStatus(versionId) {
  return db.prepare('SELECT status FROM reviews WHERE version_id=? ORDER BY created_at DESC LIMIT 1').get(versionId)?.status ?? null;
}

/** 只有仍能提供完整产物的当前待审版或正式版才可阻止同内容重复提交。 */
export function findActiveDuplicateVersion(projectId, sha256) {
  if (!projectId || !sha256) return null;
  const project = db.prepare('SELECT pending_version_id,live_version_id FROM projects WHERE id=?').get(projectId);
  if (!project) return null;
  const candidates = [...new Set([project.pending_version_id, project.live_version_id].filter(Boolean))];
  for (const versionId of candidates) {
    const version = db.prepare(`SELECT * FROM versions
                                WHERE id=? AND project_id=? AND bundle_sha=? AND artifact_pruned=0`)
      .get(versionId, projectId, sha256);
    if (!version || !existsSync(join(versionDir(version.id), 'index.html'))) continue;
    const status = latestReviewStatus(version.id);
    if (version.id === project.pending_version_id && (status === null || status === 'pending')) return version;
    if (version.id === project.live_version_id && (status === null || status === 'approved')) return version;
  }
  return null;
}

export function submissionMetadataDiffers(projectId, version, normalizedMeta = {}) {
  const project = db.prepare('SELECT title,tagline FROM projects WHERE id=?').get(projectId);
  if (!project || !version) return false;
  const currentTitle = version.project_title || project.title;
  const currentTagline = version.tagline || project.tagline || null;
  return Boolean(
    (normalizedMeta.project_title && normalizedMeta.project_title !== currentTitle)
    || (normalizedMeta.tagline && normalizedMeta.tagline !== currentTagline),
  );
}

function mappedSubmissionError(error) {
  if (error instanceof SubmissionError) return error;
  if (error instanceof UnpackError || error instanceof UploadFormatError) {
    return new SubmissionError(error.code, error.message, 400, error.hint);
  }
  if (error instanceof ProjectQuotaError) {
    return new SubmissionError(
      'project_disk_quota_exceeded',
      '这个项目的磁盘空间快用完了，暂时不能再提交这么大的版本。',
      413,
      '删除或压缩大图片、音频和视频后再试；大文件请改用平台文件上传',
    );
  }
  return new SubmissionError(
    'bundle_invalid',
    '这个内容包没法处理，可能已经损坏。',
    400,
    '重新选择文件，或重新运行一次 vibehub deploy',
  );
}

function restoreFailedSubmission({ project, versionId, previewId, pendingReviewIds }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE projects SET pending_version_id=?,dev_status=?,publish_status=?,updated_at=? WHERE id=?`)
      .run(project.pending_version_id, project.dev_status, project.publish_status, project.updated_at, project.id);
    const restoreReview = db.prepare(`UPDATE reviews SET status='pending' WHERE id=? AND status='superseded'`);
    for (const reviewId of pendingReviewIds) restoreReview.run(reviewId);
    db.prepare('DELETE FROM reviews WHERE version_id=?').run(versionId);
    db.prepare('DELETE FROM diagnoses WHERE version_id=?').run(versionId);
    db.prepare('DELETE FROM deployments WHERE version_id=?').run(versionId);
    db.prepare('DELETE FROM versions WHERE id=?').run(versionId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN 失败时没有事务可回滚 */ }
    throw error;
  }
  try { unlinkSync(previewLink(previewId)); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  rmSync(versionDir(versionId), { recursive: true, force: true });
}

export async function submitVersion({
  projectId,
  userId,
  auth,
  source,
  filename,
  meta,
  submittedVia,
  diagnosisQueue,
}) {
  let acquired = false;
  let vid = null;
  let staging = null;
  let dir = null;
  let finalized = false;
  let persisted = false;
  let completed = false;
  let preserveRejectedRecord = false;
  let project = null;
  let previewId = null;
  let pendingReviewIds = [];
  let previewGrant = null;

  try {
    if (!allowedSubmissionSources.has(submittedVia)) {
      throw new SubmissionError('invalid_submission_source', '提交来源必须是网页或 Skill。', 400);
    }
    if (!projectId) throw new SubmissionError('no_project', '这个身份没有绑定项目。', 404);
    project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!project) throw new SubmissionError('no_project', '这个身份没有绑定项目。', 404);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(project.owner_user_id);
    if (!user) throw new SubmissionError('no_project_owner', '这个项目暂时无法提交，请联系老师。', 409);
    if (activeSubmissions.has(projectId)) {
      throw new SubmissionError('submission_in_progress', '这个项目正在提交，请等待当前检查完成。', 409);
    }
    activeSubmissions.add(projectId);
    acquired = true;

    const normalizedMeta = validateSubmissionMeta(meta);
    vid = 'v_' + nanoid(12);
    dir = versionDir(vid);
    staging = join(paths.tmp, `stage_${vid}`);

    const { totalBytes, fileCount, rejected } = await normalizeUpload({ source, filename, staging });
    flattenSingleRoot(staging);
    if (!existsSync(join(staging, 'index.html'))) {
      throw new SubmissionError(
        'missing_index_html',
        '没找到 index.html，你的网页需要有一个首页文件。',
        400,
        '确认打包的是网页目录；如果用了构建工具，先 build 再提交',
      );
    }
    const inferredTitle = project.title === '我的作品' ? extractDocumentTitle(join(staging, 'index.html')) : null;
    const nextTitle = normalizedMeta.project_title || inferredTitle || project.title;
    const nextTagline = normalizedMeta.tagline || project.tagline;

    // 新提交替换旧待审产物，因此额度按最终保留集合预估。
    assertProjectedQuota(projectId, totalBytes);
    const sha = sha256File(source);
    const duplicate = findActiveDuplicateVersion(projectId, sha);
    if (duplicate && !submissionMetadataDiffers(projectId, duplicate, normalizedMeta)) {
      throw new SubmissionError(
        'duplicate_version',
        `内容和 ${duplicate.label} 完全一样，没有需要提交的改动。`,
        409,
        '修改作品内容后再提交',
      );
    }
    const seq = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM versions WHERE project_id=?').get(projectId).m + 1;
    const label = normalizedMeta.label || `v0.${seq}.0`;
    previewId = nanoid(16).toLowerCase().replace(/[^a-z0-9]/g, 'x');

    const rewrites = rewriteAbsolutePaths(staging, worksPath(user.username, project.slug));
    injectSdk(staging, '/vibehub/_sdk/vibehub.js');

    mkdirSync(paths.versions, { recursive: true });
    renameSync(staging, dir);
    finalized = true;

    db.prepare(`INSERT INTO versions
      (id,project_id,label,seq,summary,project_title,tagline,flows,bundle_sha,bundle_size,file_count,rewrites,rejected,preview_id,submitted_by,submitted_via,submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(vid, projectId, label, seq, normalizedMeta.summary, nextTitle, nextTagline,
        JSON.stringify(normalizedMeta.flows), sha, totalBytes, fileCount,
        JSON.stringify(rewrites.slice(0, 50)), JSON.stringify(rejected.slice(0, 50)), previewId, userId, submittedVia, now());
    persisted = true;

    const secretFindings = scanArtifactSecrets(dir, { rejected });
    if (secretFindings.length) {
      runDiagnosis({
        versionId: vid,
        projectId,
        versionDir: dir,
        flows: normalizedMeta.flows,
        previewProbe: null,
      });
      // 被安全扫描拒绝的新包从未成为 pending，不能撤销此前仍有效的待审版本。
      db.prepare(`UPDATE projects SET dev_status='needs_revision',
                  publish_status=CASE WHEN live_version_id IS NULL THEN 'unpublished' ELSE 'published' END,
                  updated_at=? WHERE id=? AND pending_version_id IS NULL`).run(now(), projectId);
      rmSync(dir, { recursive: true, force: true });
      db.prepare('UPDATE versions SET artifact_pruned=1 WHERE id=?').run(vid);
      preserveRejectedRecord = true;
      throw new SubmissionError(
        'secret_detected',
        '你的作品里包含了不该公开的密钥文件，请删除后重新提交',
        422,
        '检查 .env、密钥文件和代码中的 sk-、AKIA、PRIVATE KEY 后重新部署',
      );
    }

    makePreview({ previewId, versionId: vid });
    db.prepare(`INSERT INTO deployments (id,version_id,target,status,url,started_at,finished_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('dp_' + nanoid(10), vid, 'preview', 'ready', previewUrl(previewId), now(), now());

    pendingReviewIds = db.prepare(`SELECT id FROM reviews WHERE project_id=? AND status='pending'`).all(projectId)
      .map((row) => row.id);
    let diagnosisId;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE reviews SET status='superseded' WHERE project_id=? AND status='pending'`).run(projectId);
      db.prepare(`UPDATE projects SET pending_version_id=?, dev_status='submittable',
                  publish_status=CASE WHEN live_version_id IS NULL THEN publish_status ELSE 'published_with_pending' END,
                  updated_at=? WHERE id=?`).run(vid, now(), projectId);
      // pending 切换、预览授权验证和可恢复的 running 诊断必须作为一个持久化提交点。
      // 进程若在随后入内存队列前退出，启动恢复会继续这条诊断。
      previewGrant = createPreviewGrant(previewId, auth);
      if (!previewGrant) {
        throw new SubmissionError('preview_unavailable', '预览授权创建失败，请重新提交。', 500);
      }
      diagnosisId = createRunningDiagnosis({ versionId: vid });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* BEGIN 失败时没有事务可回滚 */ }
      throw error;
    }
    const queued = diagnosisQueue.enqueue({
      diagnosisId,
      versionId: vid,
      projectId,
      campId: project.camp_id,
      versionDir: dir,
      previewUrl: () => createPreviewGrant(previewId, auth)?.preview_url,
      flows: normalizedMeta.flows,
    });
    // enqueue 是最后一个不可回滚提交点。此后清理只能减少冗余，绝不能让请求失败或回滚新版本。
    completed = true;
    try {
      const cleanup = pruneProjectArtifacts(projectId);
      if (cleanup.failures.length) {
        try {
          diagnosisQueue.log?.warn({ project_id: projectId, failures: cleanup.failures }, '版本产物清理未完全完成，稍后重试');
        } catch { /* 日志故障不能影响已经完成的提交 */ }
      }
    } catch (cleanupError) {
      try {
        diagnosisQueue.log?.warn({ err: cleanupError, project_id: projectId }, '版本产物清理失败，稍后重试');
      } catch { /* 日志故障不能影响已经完成的提交 */ }
    }
    return {
      version_id: vid,
      seq,
      label,
      preview_url: previewGrant.preview_url,
      preview_expires_at: previewGrant.expires_at,
      rewrites: rewrites.length,
      deployment: { status: 'ready' },
      diagnosis: { id: queued.diagnosisId, status: 'running' },
      review: { status: 'waiting_for_diagnosis' },
      message: '已生成预览版本，正在做诊断；完成后会自动进入老师的审核队列。审核通过后才会替换线上版本。',
    };
  } catch (error) {
    if (persisted && !completed && !preserveRejectedRecord && project && vid && previewId) {
      try {
        restoreFailedSubmission({ project, versionId: vid, previewId, pendingReviewIds });
        persisted = false;
        finalized = false;
      } catch {
        throw new SubmissionError(
          'submission_recovery_failed',
          '提交没有完成，服务端恢复状态失败，请联系老师处理。',
          500,
        );
      }
      if (!(error instanceof SubmissionError || error instanceof UnpackError || error instanceof UploadFormatError || error instanceof ProjectQuotaError)) {
        throw new SubmissionError('submission_failed', '提交没有完成，请稍后重试。', 500);
      }
    }
    // 迁入最终目录但尚未写入版本记录时，它还不是不可变版本，避免留下孤儿目录。
    if (finalized && !persisted && dir) rmSync(dir, { recursive: true, force: true });
    throw mappedSubmissionError(error);
  } finally {
    if (acquired) activeSubmissions.delete(projectId);
    if (source) rmSync(source, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
