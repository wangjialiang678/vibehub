import { nanoid } from 'nanoid';
import { createWriteStream, mkdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { db, now } from '../lib/db.js';
import { issueToken, authRequired, countDevices } from '../lib/auth.js';
import { paths, LIMITS, worksUrl, previewUrl, worksPath } from '../lib/config.js';
import { safeExtract, flattenSingleRoot, rewriteAbsolutePaths, injectSdk, sha256File, UnpackError } from '../services/unpack.js';
import { makePreview, versionDir } from '../services/publish.js';
import { runDiagnosis } from '../services/diagnosis.js';
import { projectSnapshot } from './_shared.js';

const err = (reply, code, status, message, hint) =>
  reply.code(status).send({ error: { code, message, hint } });

export default async function skillRoutes(app) {
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
    const dup = db.prepare('SELECT id,label FROM versions WHERE project_id=? AND bundle_sha=? ORDER BY seq DESC LIMIT 1')
      .get(req.auth.project_id, sha256);
    return dup
      ? { duplicate: true, version_id: dup.id, message: `内容和 ${dup.label} 完全一样，没有需要提交的改动。` }
      : { duplicate: false };
  });

  // ── 提交版本 ─────────────────────────────────────────────────────
  app.post('/api/skill/versions', { preHandler: authRequired() }, async (req, reply) => {
    const projectId = req.auth.project_id;
    if (!projectId) return err(reply, 'no_project', 404, '这个身份没有绑定项目。');

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(project.owner_user_id);

    let meta = {};
    let tmpFile = null;
    mkdirSync(paths.tmp, { recursive: true });

    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'bundle') {
        tmpFile = join(paths.tmp, `up_${nanoid(10)}.tgz`);
        await pipeline(part.file, createWriteStream(tmpFile));
        if (part.file.truncated) {
          rmSync(tmpFile, { force: true });
          return err(reply, 'bundle_too_large', 413,
            `上传包超过 ${Math.round(LIMITS.bundleBytes / 1024 / 1024)} MB。`,
            '大图片、音频请用平台的文件上传接口，不要打进网页包');
        }
      } else if (part.type === 'field' && part.fieldname === 'meta') {
        try { meta = JSON.parse(part.value); } catch { meta = {}; }
      }
    }
    if (!tmpFile) return err(reply, 'missing_bundle', 400, '没有收到上传的内容包。');

    const vid = 'v_' + nanoid(12);
    const dir = versionDir(vid);
    const staging = join(paths.tmp, `stage_${vid}`);

    try {
      const sha = sha256File(tmpFile);
      const { totalBytes, fileCount } = await safeExtract(tmpFile, staging);
      flattenSingleRoot(staging);

      if (!existsSync(join(staging, 'index.html'))) {
        rmSync(staging, { recursive: true, force: true });
        return err(reply, 'missing_index_html', 400,
          '没找到 index.html，你的网页需要有一个首页文件。',
          '确认打包的是网页目录；如果用了构建工具，先 build 再提交');
      }

      const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM versions WHERE project_id=?').get(projectId).m) + 1;
      const label = meta.label || `v0.${seq}.0`;
      const previewId = nanoid(16).toLowerCase().replace(/[^a-z0-9]/g, 'x');

      // 决策 2 是路径式网址 → 作品跑在子目录，必须处理绝对路径
      const rewrites = rewriteAbsolutePaths(staging, worksPath(user.username, project.slug));
      injectSdk(staging, '/vibehub/_sdk/vibehub.js');

      mkdirSync(paths.versions, { recursive: true });
      renameSync(staging, dir);

      db.prepare(`INSERT INTO versions
        (id,project_id,label,seq,summary,flows,bundle_sha,bundle_size,file_count,rewrites,preview_id,submitted_by,submitted_via,submitted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(vid, projectId, label, seq, meta.summary ?? null,
          JSON.stringify(meta.flows || []), sha, totalBytes, fileCount,
          JSON.stringify(rewrites.slice(0, 50)), previewId, req.auth.user_id, 'skill', now());

      makePreview({ previewId, versionId: vid });
      const depId = 'dp_' + nanoid(10);
      db.prepare(`INSERT INTO deployments (id,version_id,target,status,url,started_at,finished_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(depId, vid, 'preview', 'ready', previewUrl(previewId), now(), now());

      // 诊断（P0 同步跑确定性部分，很快；模型翻译留给 P1）
      let diag = null;
      try {
        diag = runDiagnosis({ versionId: vid, projectId, versionDir: dir, flows: meta.flows, previewOk: true });
      } catch (e) { req.log.error({ e }, 'diagnosis failed'); }

      // 部署成功才创建审核任务；同项目更早的 pending 置为 superseded
      db.prepare(`UPDATE reviews SET status='superseded' WHERE project_id=? AND status='pending'`).run(projectId);
      const rid = 'r_' + nanoid(10);
      db.prepare(`INSERT INTO reviews (id,version_id,project_id,camp_id,status,created_at) VALUES (?,?,?,?,?,?)`)
        .run(rid, vid, projectId, project.camp_id, 'pending', now());

      db.prepare(`UPDATE projects SET pending_version_id=?, dev_status='submittable',
                  publish_status = CASE WHEN live_version_id IS NULL THEN publish_status ELSE 'published_with_pending' END,
                  updated_at=? WHERE id=?`).run(vid, now(), projectId);

      return reply.code(201).send({
        version_id: vid, seq, label,
        preview_url: previewUrl(previewId),
        rewrites: rewrites.length,
        deployment: { status: 'ready' },
        diagnosis: diag ? { status: diag.status, score: diag.score, summary: diag.summary, next_steps: diag.next_steps } : null,
        review: { status: 'pending' },
        message: '已生成预览版本，并进入老师的审核队列。审核通过后才会替换线上版本。',
      });
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
      if (e instanceof UnpackError) return err(reply, e.code, 400, e.message, e.hint);
      req.log.error({ e }, 'submit failed');
      return err(reply, 'bundle_invalid', 400, '这个内容包没法解开，可能损坏了。', '重新运行一次 vibehub deploy');
    } finally {
      if (tmpFile) rmSync(tmpFile, { force: true });
    }
  });
}
