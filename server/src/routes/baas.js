import { nanoid } from 'nanoid';
import { mkdirSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { db, now } from '../lib/db.js';
import { paths, LIMITS, WORKS_PREFIX } from '../lib/config.js';

/**
 * 最小 BaaS。学员作品是公开静态页 → **作品里没有秘密**。
 * 项目身份由作品 URL 路径推导，不接受前端自报的 project 参数。
 * 保护来自服务端配额、限流与大小限制。
 * P1 会换成 PocketBase 作为引擎（见 docs/specs/decisions-r1.md 附加要求 A）。
 */

const buckets = new Map();               // 简易令牌桶：项目级 60 req/min
function rateOk(projectId) {
  const t = Date.now();
  const b = buckets.get(projectId) || { n: 0, reset: t + 60_000 };
  if (t > b.reset) { b.n = 0; b.reset = t + 60_000; }
  b.n += 1; buckets.set(projectId, b);
  return b.n <= 60;
}

function logCall(projectId, kind, ok) {
  db.prepare('INSERT INTO baas_calls (project_id,kind,ok,at) VALUES (?,?,?,?)')
    .run(projectId, kind, ok ? 1 : 0, now());
}

/** 从 Referer / Origin 里的作品路径反查项目 */
function resolveProject(req) {
  const src = String(req.headers['x-vibehub-project'] || req.headers.referer || '');

  // 预览路径必须先判——否则下面的正式路径正则会把 `_preview` 当成用户名匹配掉
  const pm = src.match(new RegExp(`${WORKS_PREFIX}/_preview/([a-z0-9]+)/`, 'i'));
  if (pm) {
    const row = db.prepare(`SELECT p.* FROM projects p JOIN versions v ON v.project_id=p.id
                            WHERE v.preview_id=?`).get(pm[1]);
    if (row) return row;
  }

  // 正式路径 /vibehub/<username>/<slug>/，用户名不允许以下划线开头（保留给平台）
  const m = src.match(new RegExp(`${WORKS_PREFIX}/([a-z0-9][a-z0-9_-]*)/([a-z0-9][a-z0-9_-]*)/`, 'i'));
  if (m) {
    const row = db.prepare(`SELECT p.* FROM projects p JOIN users u ON u.id=p.owner_user_id
                            WHERE u.username=? AND p.slug=?`).get(m[1], m[2]);
    if (row) return row;
  }
  return null;
}

export default async function baasRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/baas/')) return;
    const p = resolveProject(req);
    if (!p) return reply.code(400).send({ error: { code: 'unknown_project', message: '认不出这个请求来自哪个作品。' } });
    if (!rateOk(p.id)) {
      logCall(p.id, 'rate', false);
      return reply.code(429).send({ error: { code: 'rate_limited', message: '请求太频繁了，稍等一下再试。' } });
    }
    req.project = p;
  });

  app.post('/baas/v1/:collection', async (req, reply) => {
    const { id } = req.project;
    const body = JSON.stringify(req.body ?? {});
    if (Buffer.byteLength(body) > LIMITS.baasRecordBytes) {
      logCall(id, 'data_write', false);
      return reply.code(413).send({ error: { code: 'record_too_large', message: '单条数据太大了。' } });
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM baas_records WHERE project_id=?').get(id).n;
    if (n >= LIMITS.baasRecordsPerProject) {
      logCall(id, 'data_write', false);
      return reply.code(429).send({ error: { code: 'quota_exceeded', message: '这个作品的数据条数用满了。' } });
    }
    const rid = 'rec_' + nanoid(12);
    db.prepare('INSERT INTO baas_records (id,project_id,collection,data,created_at) VALUES (?,?,?,?,?)')
      .run(rid, id, req.params.collection, body, now());
    logCall(id, 'data_write', true);
    return reply.code(201).send({ id: rid, created_at: now() });
  });

  app.get('/baas/v1/:collection', async (req) => {
    const { id } = req.project;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.prepare(`SELECT id,data,created_at FROM baas_records
                             WHERE project_id=? AND collection=? ORDER BY created_at DESC LIMIT ?`)
      .all(id, req.params.collection, limit);
    logCall(id, 'data_read', true);
    return { items: rows.map((r) => ({ id: r.id, created_at: r.created_at, ...JSON.parse(r.data) })) };
  });

  app.delete('/baas/v1/:collection/:id', async (req) => {
    const changed = db.prepare('DELETE FROM baas_records WHERE id=? AND project_id=? AND collection=?')
      .run(req.params.id, req.project.id, req.params.collection).changes;
    logCall(req.project.id, 'data_write', !!changed);
    return { ok: !!changed };
  });

  app.post('/baas/v1/counter/:key', async (req) => {
    const { id } = req.project;
    db.prepare(`INSERT INTO baas_counters (project_id,key,value) VALUES (?,?,1)
                ON CONFLICT(project_id,key) DO UPDATE SET value=value+1`).run(id, req.params.key);
    const v = db.prepare('SELECT value FROM baas_counters WHERE project_id=? AND key=?').get(id, req.params.key);
    logCall(id, 'counter', true);
    return { value: v.value };
  });

  app.post('/baas/v1/files', async (req, reply) => {
    const { id } = req.project;
    const used = db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM baas_files WHERE project_id=?').get(id).n;
    if (used >= LIMITS.baasBytesPerProject) {
      logCall(id, 'file', false);
      return reply.code(429).send({ error: { code: 'quota_exceeded', message: '这个作品的文件空间用满了。' } });
    }
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: { code: 'missing_file', message: '没有收到文件。' } });
    const fid = 'f_' + nanoid(12);
    const dir = join(paths.uploads, id);
    mkdirSync(dir, { recursive: true });
    const safeName = (file.filename || 'file').replace(/[^\w.\-]/g, '_').slice(-80);
    const rel = `${fid}_${safeName}`;
    await pipeline(file.file, createWriteStream(join(dir, rel)));
    if (file.file.truncated) {
      logCall(id, 'file', false);
      return reply.code(413).send({ error: { code: 'file_too_large', message: '文件太大了。' } });
    }
    db.prepare('INSERT INTO baas_files (id,project_id,filename,mime,size,path,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(fid, id, safeName, file.mimetype ?? null, file.file.bytesRead ?? 0, rel, now());
    logCall(id, 'file', true);
    return reply.code(201).send({ id: fid, url: `/baas/v1/files/${id}/${rel}`, filename: safeName });
  });
}
