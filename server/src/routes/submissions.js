import { nanoid } from 'nanoid';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db } from '../lib/db.js';
import { assertProjectAccess, authRequired, hasAllowedCookieOrigin } from '../lib/auth.js';
import { LIMITS, paths } from '../lib/config.js';
import { browserSubmissionGuard } from '../services/submission-guard.js';
import { SubmissionError, submitVersion, validateSubmissionMeta } from '../services/version-submission.js';

const sendError = (reply, code, status, message, hint, extra = {}) =>
  reply.code(status).send({ error: { code, message, ...(hint ? { hint } : {}), ...extra } });

function submissionError(reply, error) {
  return sendError(reply, error.code, error.status, error.message, error.hint);
}

export async function receiveBrowserSubmissionParts(parts, { tmpDir = paths.tmp } = {}) {
  let meta = {};
  let metaSeen = false;
  let tmpFile = null;
  let filename = null;
  mkdirSync(tmpDir, { recursive: true });

  try {
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'bundle') {
        if (tmpFile) {
          part.file.resume();
          throw new SubmissionError('multiple_bundles', '一次只能提交一个内容包。', 400);
        }
        tmpFile = join(tmpDir, `web_${nanoid(10)}.upload`);
        filename = part.filename;
        await pipeline(part.file, createWriteStream(tmpFile));
        if (part.file.truncated) {
          throw new SubmissionError(
            'bundle_too_large',
            `上传包超过 ${Math.round(LIMITS.bundleBytes / 1024 / 1024)} MB。`,
            413,
            '请压缩图片、音频和视频后再试。',
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
    return { meta, tmpFile, filename };
  } catch (error) {
    if (tmpFile) rmSync(tmpFile, { force: true });
    throw error;
  }
}

export async function handleBrowserSubmissionRequest(req, reply, {
  diagnosisQueue,
  multipartErrors,
  submissionGuard = browserSubmissionGuard,
}) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (req.authSource !== 'cookie' || !hasAllowedCookieOrigin(req) ||
      req.params.id !== req.auth.project_id || !assertProjectAccess(project, req.auth)) {
    return sendError(reply, 'not_found', 404, '找不到这个项目。');
  }

  const permit = submissionGuard.acquire(project.id);
  if (!permit.ok) {
    if (permit.retryAfterSeconds) reply.header('retry-after', permit.retryAfterSeconds);
    return sendError(reply, permit.code, permit.status, permit.message, null,
      permit.retryAfterSeconds ? { retry_after_seconds: permit.retryAfterSeconds } : {});
  }

  let upload = null;
  let delegated = false;
  try {
    upload = await receiveBrowserSubmissionParts(req.parts());
    // 频率从「唯一 bundle 已完整落盘且 meta 合法，即将调用共享提交服务」开始计数；
    // 缺文件、重复文件、截断、multipart 中断和非法 meta 都不会消耗次数。
    validateSubmissionMeta(upload.meta);
    permit.recordAttempt();
    req.log.info({
      project_id: project.id,
      format: extname(upload.filename || '').toLowerCase() || 'unknown',
      bundle_size: statSync(upload.tmpFile).size,
    }, '网页提交已接收');

    delegated = true;
    const result = await submitVersion({
      projectId: project.id,
      userId: req.auth.user_id,
      auth: req.auth,
      source: upload.tmpFile,
      filename: upload.filename,
      meta: upload.meta,
      submittedVia: 'web',
      diagnosisQueue,
    });
    req.log.info({ project_id: project.id, version_id: result.version_id, result: 'created' }, '网页提交完成');
    return reply.code(201).send(result);
  } catch (error) {
    if (error instanceof SubmissionError) {
      req.log.info({ project_id: project.id, result: error.code }, '网页提交未完成');
      return submissionError(reply, error);
    }
    if (multipartErrors?.RequestFileTooLargeError && error instanceof multipartErrors.RequestFileTooLargeError) {
      return sendError(reply, 'bundle_too_large', 413,
        `上传包超过 ${Math.round(LIMITS.bundleBytes / 1024 / 1024)} MB。`,
        '请压缩图片、音频和视频后再试。');
    }
    if (multipartErrors?.FilesLimitError && error instanceof multipartErrors.FilesLimitError) {
      return sendError(reply, 'multiple_bundles', 400, '一次只能提交一个内容包。');
    }
    req.log.info({ project_id: project.id, result: 'multipart_invalid' }, '网页提交未完成');
    return sendError(reply, 'multipart_invalid', 400, '上传没有完整收到，请重新选择文件后再试。');
  } finally {
    permit.release();
    if (!delegated && upload?.tmpFile) rmSync(upload.tmpFile, { force: true });
  }
}

export default async function submissionRoutes(app, { diagnosisQueue }) {
  app.post('/api/projects/:id/versions', { preHandler: authRequired(['student']) }, async (req, reply) =>
    handleBrowserSubmissionRequest(req, reply, { diagnosisQueue, multipartErrors: app.multipartErrors }));
}
