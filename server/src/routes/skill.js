import { nanoid } from 'nanoid';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { db, now } from '../lib/db.js';
import { issueToken, authRequired, countDevices } from '../lib/auth.js';
import { paths, LIMITS } from '../lib/config.js';
import { projectSnapshot } from './_shared.js';
import { findActiveDuplicateVersion, SubmissionError, submitVersion } from '../services/version-submission.js';

const err = (reply, code, status, message, hint) =>
  reply.code(status).send({ error: { code, message, hint } });

export default async function skillRoutes(app, { diagnosisQueue }) {
  // ── 绑定：邀请码换凭证。入口，无需鉴权 ────────────────────────────
  app.post('/api/skill/bind', async (req, reply) => {
    const { code, device_name } = req.body || {};
    if (!code) return err(reply, 'missing_code', 400, '请提供邀请码。', '用法：vibehub bind <邀请码>');

    const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(String(code).trim().toUpperCase());
    if (!invite) return err(reply, 'invite_not_found', 404, '这个邀请码不存在，检查一下有没有输错。', '注意区分数字 0 和字母 O');
    if (invite.status === 'revoked') return err(reply, 'invite_revoked', 403, '这个邀请码已经被撤销了。', '找老师要一个新的');
    if (invite.expires_at && invite.expires_at < now()) return err(reply, 'invite_expired', 403, '这个邀请码已经过期了。', '找老师要一个新的');
    if (countDevices(invite.code) >= invite.max_devices)
      return err(reply, 'invite_device_limit', 403,
        `这个邀请码最多绑定 ${invite.max_devices} 台设备，已经用完了。`, '让老师撤销旧设备，或者要一个新码');

    const camp = db.prepare('SELECT * FROM camps WHERE id = ?').get(invite.camp_id);
    let user = invite.bound_user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(invite.bound_user_id) : null;
    let project = invite.bound_project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(invite.bound_project_id) : null;

    if (!user) {
      const uid = 'u_' + nanoid(10);
      const uname = `student-${nanoid(6).toLowerCase()}`;
      db.prepare('INSERT INTO users (id,username,display_name,created_at) VALUES (?,?,?,?)')
        .run(uid, uname, '新学员', now());
      db.prepare('INSERT OR IGNORE INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
        .run(camp.id, uid, invite.role, now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    }
    if (!project && invite.role === 'student') {
      const pid = 'p_' + nanoid(10);
      const slug = `project-${nanoid(6).toLowerCase()}`;
      db.prepare(`INSERT INTO projects (id,camp_id,owner_user_id,slug,title,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(pid, camp.id, user.id, slug, '我的作品', now(), now());
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    }

    db.prepare(`UPDATE invites SET status='bound', bound_user_id=?, bound_project_id=?, bound_at=COALESCE(bound_at,?) WHERE code=?`)
      .run(user.id, project?.id ?? null, now(), invite.code);

    const token = issueToken({
      kind: 'skill', userId: user.id, campId: camp.id, projectId: project?.id,
      role: invite.role, inviteCode: invite.code, deviceName: device_name || '未命名设备',
    });

    return {
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name },
      camp: { id: camp.id, slug: camp.slug, name: camp.name },
      project: project ? { id: project.id, slug: project.slug, title: project.title } : null,
      message: `已连接到《${camp.name}》${project ? `，你的作品：${project.title}` : ''}`,
    };
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
  app.post('/api/skill/versions', { preHandler: authRequired() }, async (req, reply) => {
    const projectId = req.auth.project_id;
    if (!projectId) return err(reply, 'no_project', 404, '这个身份没有绑定项目。');

    let meta = {};
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
            return err(reply, 'bundle_too_large', 413,
              `上传包超过 ${Math.round(LIMITS.bundleBytes / 1024 / 1024)} MB。`,
              '大图片、音频请用平台的文件上传接口，不要打进网页包');
          }
        } else if (part.type === 'field' && part.fieldname === 'meta') {
          try { meta = JSON.parse(part.value); } catch { meta = {}; }
        }
      }
      if (!tmpFile) return err(reply, 'missing_bundle', 400, '没有收到上传的内容包。');

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
      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof SubmissionError) return err(reply, e.code, e.status, e.message, e.hint);
      req.log.error({ e }, 'submit failed');
      return err(reply, 'bundle_invalid', 400, '这个内容包没法解开，可能损坏了。', '重新运行一次 vibehub deploy');
    } finally {
      // 委托后由共享服务统一清理；multipart 解析中断时由路由收尾。
      if (!delegated && tmpFile) rmSync(tmpFile, { force: true });
    }
  });
}
