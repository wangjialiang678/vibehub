import { nanoid } from 'nanoid';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { db, now } from '../lib/db.js';
import { authRequired } from '../lib/auth.js';
import { paths, LIMITS } from '../lib/config.js';
import { projectSnapshot } from './_shared.js';
import { browserSubmissionGuard } from '../services/submission-guard.js';
import {
  findActiveDuplicateVersion,
  SubmissionError,
  submitVersion,
  validateSubmissionMeta,
} from '../services/version-submission.js';
import { bindInvite, normalizeInviteCode } from '../services/invite-access.js';

const err = (reply, code, status, message, hint, extra = {}) =>
  reply.code(status).send({ error: { code, message, ...(hint ? { hint } : {}), ...extra } });

export async function handleSkillSubmissionRequest(req, reply, {
  diagnosisQueue,
  multipartErrors,
  submissionGuard = browserSubmissionGuard,
}) {
  const projectId = req.auth.project_id;
  if (!projectId) return err(reply, 'no_project', 404, '这个身份没有绑定项目。');

  // 必须在读取上传体前占用与网页入口共享的项目槽，先挡住并发的网络、
  // 临时磁盘和解包开销。共享提交服务不 acquire 此 guard，避免同锁重入。
  const permit = submissionGuard.acquire(projectId);
  if (!permit.ok) {
    if (permit.retryAfterSeconds) reply.header('retry-after', permit.retryAfterSeconds);
    return err(reply, permit.code, permit.status, permit.message, null,
      permit.retryAfterSeconds ? { retry_after_seconds: permit.retryAfterSeconds } : {});
  }

  let meta = {};
  let metaSeen = false;
  let tmpFile = null;
  let filename = null;
  let delegated = false;
  mkdirSync(paths.tmp, { recursive: true });

  try {
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'bundle') {
        if (tmpFile) {
          part.file.resume();
          throw new SubmissionError('multiple_bundles', '一次只能提交一个内容包。', 400);
        }
        tmpFile = join(paths.tmp, `up_${nanoid(10)}.upload`);
        filename = part.filename;
        await pipeline(part.file, createWriteStream(tmpFile));
        if (part.file.truncated) {
          throw new SubmissionError(
            'bundle_too_large',
            `上传包超过 ${Math.round(LIMITS.bundleBytes / 1024 / 1024)} MB。`,
            413,
            '大图片、音频请用平台的文件上传接口，不要打进网页包',
          );
        }
      } else if (part.type === 'file') {
        part.file.resume();
      } else if (part.type === 'field' && part.fieldname === 'meta') {
        if (metaSeen) throw new SubmissionError('invalid_meta', '提交说明只能提供一次。', 400);
        metaSeen = true;
        try { meta = JSON.parse(part.value); }
        catch { throw new SubmissionError('invalid_meta', '提交说明格式不正确，请重新填写。', 400); }
      }
    }
    if (!tmpFile) throw new SubmissionError('missing_bundle', '没有收到上传的内容包。', 400);

    // 与网页入口保持同一记账边界：唯一 bundle 完整落盘且 meta 合法才计次。
    meta = validateSubmissionMeta(meta);
    permit.recordAttempt();
    req.log.info({ project_id: projectId, submitted_via: 'skill' }, 'Skill 提交已接收');

    delegated = true;
    const result = await submitVersion({
      projectId,
      userId: req.auth.user_id,
      auth: req.auth,
      source: tmpFile,
      filename,
      meta,
      submittedVia: 'skill',
      diagnosisQueue,
    });
    req.log.info({ project_id: projectId, version_id: result.version_id, result: 'created' }, 'Skill 提交完成');
    return reply.code(201).send(result);
  } catch (error) {
    if (error instanceof SubmissionError) {
      req.log.info({ project_id: projectId, result: error.code }, 'Skill 提交未完成');
      return err(reply, error.code, error.status, error.message, error.hint);
    }
    if (multipartErrors?.RequestFileTooLargeError && error instanceof multipartErrors.RequestFileTooLargeError) {
      return err(reply, 'bundle_too_large', 413,
        `上传包超过 ${Math.round(LIMITS.bundleBytes / 1024 / 1024)} MB。`,
        '大图片、音频请用平台的文件上传接口，不要打进网页包');
    }
    req.log.error({ error, project_id: projectId }, 'Skill submit failed');
    return err(reply, 'bundle_invalid', 400, '这个内容包没法解开，可能损坏了。', '重新运行一次 vibehub deploy');
  } finally {
    permit.release();
    // 委托后由共享服务统一清理；multipart 解析中断时由路由收尾。
    if (!delegated && tmpFile) rmSync(tmpFile, { force: true });
  }
}

export default async function skillRoutes(app, {
  diagnosisQueue,
  inviteLimiter,
  submissionGuard = browserSubmissionGuard,
}) {
  // ── 绑定：邀请码换凭证。入口，无需鉴权 ────────────────────────────
  app.post('/api/skill/bind', async (req, reply) => {
    const { code, device_name, real_name, display_name } = req.body || {};
    if (!code) return err(reply, 'missing_code', 400, '请提供邀请码。', '用法：vibehub bind <邀请码>');
    const normalized = normalizeInviteCode(code);
    if (inviteLimiter.isBlocked(req.ip, normalized)) {
      return err(reply, 'invite_rate_limited', 429, '尝试次数太多，请 10 分钟后再试。');
    }
    const result = bindInvite(normalized, { kind: 'skill', deviceName: device_name || '未命名设备', realName: real_name, displayName: display_name });
    if (result.error) {
      if (result.error[0] !== 'profile_required') inviteLimiter.recordFailure(req.ip, normalized);
      return err(reply, ...result.error);
    }
    return result;
  });

  // ── 项目状态 ─────────────────────────────────────────────────────
  app.get('/api/skill/project', { preHandler: authRequired() }, async (req, reply) => {
    if (!req.auth.project_id) return err(reply, 'no_project', 404, '这个身份没有绑定项目。');
    return projectSnapshot(req.auth.project_id);
  });

  // ── 预检：内容没变就别重复上传 ────────────────────────────────────
  app.post('/api/skill/versions/preflight', { preHandler: authRequired() }, async (req) => {
    const { sha256 } = req.body || {};
    const dup = findActiveDuplicateVersion(req.auth.project_id, sha256);
    return dup
      ? { duplicate: true, version_id: dup.id, message: `内容和 ${dup.label} 完全一样，没有需要提交的改动。` }
      : { duplicate: false };
  });

  // ── 提交版本 ─────────────────────────────────────────────────────
  app.post('/api/skill/versions', { preHandler: authRequired() }, async (req, reply) =>
    handleSkillSubmissionRequest(req, reply, {
      diagnosisQueue,
      multipartErrors: app.multipartErrors,
      submissionGuard,
    }));
}
