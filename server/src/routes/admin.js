import { nanoid, customAlphabet } from 'nanoid';
import { db, now } from '../lib/db.js';
import { authRequired, assertProjectAccess, isTeacher, revokeTokensForInvite } from '../lib/auth.js';
import { publishVersion, suspendSite } from '../services/publish.js';
import { projectSnapshot, versionView, diagnosisView } from './_shared.js';
import { pruneProjectArtifacts } from '../services/storage.js';

// 邀请码去掉易混字符 0/O/1/I/L
const codeGen = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 4);

const err = (reply, code, status, message, hint) =>
  reply.code(status).send({ error: { code, message, hint } });

const teacherOnly = [authRequired(), async (req, reply) => {
  if (!isTeacher(req.auth.role)) return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个内容。' } });
}];

export default async function adminRoutes(app) {
  // ── 课程总览（需求文档 §7.7）──────────────────────────────────────
  app.get('/api/camps/:campId/overview', { preHandler: teacherOnly }, async (req, reply) => {
    const { campId } = req.params;
    if (campId !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这个课程。');
    const camp = db.prepare('SELECT * FROM camps WHERE id=?').get(campId);

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM camp_members WHERE camp_id=$c) AS members,
        (SELECT COUNT(*) FROM invites WHERE camp_id=$c AND status='bound') AS invites_bound,
        (SELECT COUNT(*) FROM invites WHERE camp_id=$c) AS invites_total,
        (SELECT COUNT(*) FROM projects WHERE camp_id=$c) AS projects,
        (SELECT COUNT(*) FROM projects WHERE camp_id=$c AND dev_status='not_started') AS not_started,
        (SELECT COUNT(*) FROM projects WHERE camp_id=$c AND dev_status='developing') AS developing,
        (SELECT COUNT(*) FROM projects WHERE camp_id=$c AND dev_status='needs_revision') AS needs_revision,
        (SELECT COUNT(*) FROM reviews WHERE camp_id=$c AND status='pending') AS pending_review,
        (SELECT COUNT(*) FROM projects WHERE camp_id=$c AND publish_status IN ('published','published_with_pending')) AS published
    `).get({ c: campId });

    // 长期没动静的项目
    const stale = db.prepare(`
      SELECT p.id, p.title, p.updated_at, u.display_name AS owner
      FROM projects p JOIN users u ON u.id = p.owner_user_id
      WHERE p.camp_id = ? AND p.updated_at < datetime('now', ?)
      ORDER BY p.updated_at ASC LIMIT 20
    `).all(campId, `-${camp.stale_days} days`);

    const recent = db.prepare(`
      SELECT p.id, p.title, p.dev_status, p.publish_status, p.updated_at, u.display_name AS owner
      FROM projects p JOIN users u ON u.id = p.owner_user_id
      WHERE p.camp_id = ? ORDER BY p.updated_at DESC LIMIT 20
    `).all(campId);

    return { camp: { id: camp.id, name: camp.name, slug: camp.slug, kind: camp.kind }, counts, stale, recent };
  });

  app.get('/api/camps/:campId/projects', { preHandler: teacherOnly }, async (req, reply) => {
    if (req.params.campId !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这个课程。');
    return {
      items: db.prepare(`
        SELECT p.*, u.display_name AS owner_name, u.username AS owner_username
        FROM projects p JOIN users u ON u.id=p.owner_user_id
        WHERE p.camp_id=? ORDER BY p.updated_at DESC`).all(req.params.campId),
    };
  });

  // ── 邀请码 ───────────────────────────────────────────────────────
  app.post('/api/camps/:campId/invites', { preHandler: teacherOnly }, async (req, reply) => {
    if (req.params.campId !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这个课程。');
    const { count = 1, role = 'student', max_devices = 3, expires_at = null } = req.body || {};
    const n = Math.min(Math.max(Number(count) || 1, 1), 200);
    const camp = db.prepare('SELECT slug FROM camps WHERE id=?').get(req.params.campId);
    const prefix = (camp.slug || 'CAMP').replace(/[^a-zA-Z]/g, '').slice(0, 6).toUpperCase() || 'CAMP';
    const created = [];
    for (let i = 0; i < n; i++) {
      let code;
      do { code = `${prefix}-${codeGen()}`; }
      while (db.prepare('SELECT 1 FROM invites WHERE code=?').get(code));
      db.prepare(`INSERT INTO invites (code,camp_id,role,status,max_devices,expires_at,created_at)
                  VALUES (?,?,?,'unused',?,?,?)`)
        .run(code, req.params.campId, role, max_devices, expires_at, now());
      created.push(code);
    }
    // 明码只在这里出现一次
    return reply.code(201).send({ codes: created, message: `已生成 ${created.length} 个邀请码。明码只显示这一次，请立刻导出保存。` });
  });

  app.get('/api/camps/:campId/invites', { preHandler: teacherOnly }, async (req, reply) => {
    if (req.params.campId !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这个课程。');
    // 列表脱敏：只回显后 4 位
    const rows = db.prepare(`
      SELECT i.code, i.status, i.role, i.max_devices, i.created_at, i.bound_at,
             u.display_name AS bound_user, p.title AS bound_project
      FROM invites i
      LEFT JOIN users u ON u.id=i.bound_user_id
      LEFT JOIN projects p ON p.id=i.bound_project_id
      WHERE i.camp_id=? ORDER BY i.created_at DESC`).all(req.params.campId);
    return {
      items: rows.map((r) => ({
        code_masked: '····-' + r.code.slice(-4),
        status: r.status, role: r.role, max_devices: r.max_devices,
        bound_user: r.bound_user, bound_project: r.bound_project,
        created_at: r.created_at, bound_at: r.bound_at,
        devices: db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE invite_code=? AND revoked_at IS NULL').get(r.code).n,
      })),
    };
  });

  app.get('/api/camps/:campId/invites/export', { preHandler: teacherOnly }, async (req, reply) => {
    if (req.params.campId !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这个课程。');
    const rows = db.prepare(`SELECT code,role,status,max_devices,expires_at,created_at FROM invites
                             WHERE camp_id=? ORDER BY created_at DESC`).all(req.params.campId);
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = ['邀请码,角色,状态,设备上限,过期时间,创建时间', ...rows.map((row) =>
      [row.code, row.role, row.status, row.max_devices, row.expires_at, row.created_at].map(quote).join(','))].join('\r\n');
    db.prepare(`INSERT INTO audit_logs (id,camp_id,actor_user_id,action,target_type,target_id,detail,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run('audit_' + nanoid(12), req.params.campId, req.auth.user_id, 'invite_export', 'camp', req.params.campId,
        JSON.stringify({ count: rows.length }), now());
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="vibehub-invites.csv"')
      .send(`\uFEFF${csv}`);
  });

  app.post('/api/invites/:code/revoke', { preHandler: teacherOnly }, async (req, reply) => {
    const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(req.params.code);
    if (!inv || inv.camp_id !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这个邀请码。');
    db.prepare(`UPDATE invites SET status='revoked', revoked_at=? WHERE code=?`).run(now(), inv.code);
    const revoked = revokeTokensForInvite(inv.code);   // 级联吊销该码签发的全部凭证
    return { ok: true, revoked_tokens: revoked, message: `邀请码已撤销，${revoked} 台设备的连接已同时失效。` };
  });

  // ── 审核队列 ─────────────────────────────────────────────────────
  app.get('/api/reviews', { preHandler: teacherOnly }, async (req) => {
    const status = req.query.status || 'pending';
    const rows = db.prepare(`
      SELECT r.*, v.label, v.summary, v.preview_id, v.submitted_at AS v_submitted_at,
             p.title AS project_title, p.slug AS project_slug,
             u.display_name AS owner_name, u.username AS owner_username, u.avatar_url
      FROM reviews r
      JOIN versions v ON v.id=r.version_id
      JOIN projects p ON p.id=r.project_id
      JOIN users u ON u.id=p.owner_user_id
      WHERE r.camp_id=? AND r.status=?
      ORDER BY r.created_at DESC LIMIT 100`).all(req.auth.camp_id, status);

    const publishedCount = db.prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE camp_id=? AND publish_status IN ('published','published_with_pending')`
    ).get(req.auth.camp_id).n;

    return {
      items: rows.map((r) => ({
        id: r.id, version_id: r.version_id, project_id: r.project_id,
        project_title: r.project_title, owner_name: r.owner_name,
        owner_username: r.owner_username, avatar_url: r.avatar_url,
        label: r.label, summary: r.summary,
        created_at: r.created_at, status: r.status,
      })),
      counts: { pending: status === 'pending' ? rows.length : undefined, published: publishedCount },
    };
  });

  app.get('/api/reviews/:id', { preHandler: teacherOnly }, async (req, reply) => {
    const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
    if (!r || r.camp_id !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这条审核记录。');
    const v = db.prepare('SELECT * FROM versions WHERE id=?').get(r.version_id);
    const snap = projectSnapshot(r.project_id);
    return {
      review: { id: r.id, status: r.status, comment: r.comment, created_at: r.created_at, decided_at: r.decided_at },
      version: versionView(v),
      diagnosis: diagnosisView(v.id),
      project: snap.project, owner: snap.owner,
      live_version: snap.live_version,
    };
  });

  app.post('/api/reviews/:id/approve', { preHandler: teacherOnly }, async (req, reply) => {
    const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
    if (!r || r.camp_id !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这条审核记录。');
    const diagnosis = diagnosisView(r.version_id);
    if (diagnosis?.status === 'blocked') {
      return err(reply, 'diagnosis_blocked', 409, '这个版本有必须先修复的问题，暂时不能发布。', '请让学员按诊断提示修改后重新提交');
    }
    // 乐观锁：重复点击不会二次发布
    const changed = db.prepare(`UPDATE reviews SET status='approved', reviewer_id=?, comment=?, decided_at=?
                                WHERE id=? AND status='pending'`)
      .run(req.auth.user_id, req.body?.comment ?? null, now(), r.id).changes;
    if (!changed) return err(reply, 'already_decided', 409, '这个版本已经处理过了。');

    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(r.project_id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.owner_user_id);
    publishVersion({ username: u.username, slug: p.slug, versionId: r.version_id });

    db.prepare(`UPDATE projects SET live_version_id=?, pending_version_id=NULL,
                publish_status='published', dev_status='developing', updated_at=? WHERE id=?`)
      .run(r.version_id, now(), p.id);
    db.prepare(`INSERT INTO deployments (id,version_id,target,status,url,started_at,finished_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('dp_' + nanoid(10), r.version_id, 'live', 'ready', null, now(), now());
    pruneProjectArtifacts(p.id);

    return { ok: true, message: '已发布，作品网址现在指向这个版本。' };
  });

  app.post('/api/reviews/:id/reject', { preHandler: teacherOnly }, async (req, reply) => {
    const comment = (req.body?.comment || '').trim();
    if (!comment) return err(reply, 'comment_required', 400, '退回时必须写清楚原因，学员要看到它。');
    const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
    if (!r || r.camp_id !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这条审核记录。');
    const changed = db.prepare(`UPDATE reviews SET status='rejected', reviewer_id=?, comment=?, decided_at=?
                                WHERE id=? AND status='pending'`)
      .run(req.auth.user_id, comment, now(), r.id).changes;
    if (!changed) return err(reply, 'already_decided', 409, '这个版本已经处理过了。');

    // 线上旧版本保持不变（需求文档 §7.6）
    db.prepare(`UPDATE projects SET pending_version_id=NULL, dev_status='needs_revision',
                publish_status = CASE WHEN live_version_id IS NULL THEN 'unpublished' ELSE 'published' END,
                updated_at=? WHERE id=?`).run(now(), r.project_id);
    pruneProjectArtifacts(r.project_id);
    return { ok: true, message: '已退回，学员会看到你的修改意见。线上旧版本不受影响。' };
  });

  // ── 项目管理：这些接口只影响已发布作品的对外呈现，不改变版本历史。 ──
  app.post('/api/projects/:id/suspend', { preHandler: teacherOnly }, async (req, reply) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!assertProjectAccess(project, req.auth)) return err(reply, 'not_found', 404, '找不到这个项目。');
    if (!project.live_version_id) return err(reply, 'not_published', 400, '这个项目还没有正式发布，暂时不能下线。', '先审核通过一个版本后再操作');
    const owner = db.prepare('SELECT username FROM users WHERE id=?').get(project.owner_user_id);
    suspendSite({ username: owner.username, slug: project.slug });
    db.prepare(`UPDATE projects SET publish_status='suspended',updated_at=? WHERE id=?`).run(now(), project.id);
    return { ok: true, message: '作品已下线，访客会看到说明页面。' };
  });

  app.post('/api/projects/:id/resume', { preHandler: teacherOnly }, async (req, reply) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!assertProjectAccess(project, req.auth)) return err(reply, 'not_found', 404, '找不到这个项目。');
    if (!project.live_version_id) return err(reply, 'not_published', 400, '这个项目还没有正式发布，暂时不能恢复。', '先审核通过一个版本后再操作');
    const owner = db.prepare('SELECT username FROM users WHERE id=?').get(project.owner_user_id);
    publishVersion({ username: owner.username, slug: project.slug, versionId: project.live_version_id });
    db.prepare(`UPDATE projects SET publish_status='published',updated_at=? WHERE id=?`).run(now(), project.id);
    return { ok: true, message: '作品已恢复公开访问。' };
  });

  app.patch('/api/projects/:id/visibility', { preHandler: teacherOnly }, async (req, reply) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!assertProjectAccess(project, req.auth)) return err(reply, 'not_found', 404, '找不到这个项目。');
    const visibility = req.body?.visibility;
    if (visibility !== null && !['nickname', 'realname', 'camp_only'].includes(visibility)) {
      return err(reply, 'invalid_visibility', 400, '可见性设置不正确。', '可选 nickname、realname、camp_only，或传 null 恢复课程默认值');
    }
    db.prepare('UPDATE projects SET visibility=?,updated_at=? WHERE id=?').run(visibility, now(), project.id);
    return { ok: true, visibility, message: visibility === null ? '已恢复课程默认可见性。' : '作品可见性已更新。' };
  });

  app.post('/api/camps/:campId/collection', { preHandler: teacherOnly }, async (req, reply) => {
    if (req.params.campId !== req.auth.camp_id) return err(reply, 'not_found', 404, '找不到这个课程。');
    const items = req.body?.items;
    if (!Array.isArray(items)) return err(reply, 'invalid_collection', 400, '集合页排序数据格式不正确。', '传入 items 数组，每项包含 project_id、order 和 recommended');
    try {
      db.exec('BEGIN');
      for (const [index, item] of items.entries()) {
        const project = db.prepare('SELECT id FROM projects WHERE id=? AND camp_id=?').get(item?.project_id, req.params.campId);
        if (!project) throw new Error('invalid_project');
        const order = Number.isInteger(item.order) ? item.order : index;
        db.prepare(`UPDATE projects SET collection_order=?,collection_recommended=?,updated_at=? WHERE id=?`)
          .run(order, item.recommended ? 1 : 0, now(), project.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 未开启事务时无需回滚 */ }
      return err(reply, 'invalid_collection', 400, '集合页里包含不属于本课程的作品。', '只传入当前课程下的项目 ID');
    }
    return { ok: true, updated: items.length, message: '集合页排序和推荐位已保存。' };
  });
}
