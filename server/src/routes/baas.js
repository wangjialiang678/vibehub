import { nanoid } from 'nanoid';
import { mkdirSync, createWriteStream, renameSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { db, now } from '../lib/db.js';
import { paths, LIMITS, WORKS_PREFIX, WORKS_ORIGIN } from '../lib/config.js';
import { projectDiskUsage } from '../services/storage.js';
import { authRequired } from '../lib/auth.js';

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
  // 项目只能由浏览器自动附带的来源信息推导，绝不信任客户端自报项目 header。
  const src = String(req.headers.referer || req.headers.origin || '');
  let sourceUrl;
  try { sourceUrl = new URL(src); }
  catch { return null; }
  // 路径像作品地址还不够：必须来自平台的作品 origin，而不是外站伪造同一路径。
  if (sourceUrl.origin !== WORKS_ORIGIN) return null;

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
    const rid = 'rec_' + nanoid(12);
    let quotaError = null;
    try {
      // 检查与插入放在同一个写事务，避免并发请求一起越过项目配额。
      db.exec('BEGIN IMMEDIATE');
      const recordCount = Number(db.prepare('SELECT COUNT(*) AS n FROM baas_records WHERE project_id=?').get(id).n || 0);
      const recordBytes = Number(db.prepare('SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS n FROM baas_records WHERE project_id=?').get(id).n || 0);
      const collectionExists = db.prepare('SELECT 1 FROM baas_records WHERE project_id=? AND collection=? LIMIT 1')
        .get(id, req.params.collection);
      const collectionCount = Number(db.prepare('SELECT COUNT(DISTINCT collection) AS n FROM baas_records WHERE project_id=?').get(id).n || 0);
      if (recordCount >= LIMITS.baasRecordsPerProject) {
        quotaError = { code: 'quota_exceeded', message: '这个作品的数据条数用满了。' };
      } else if (recordBytes + Buffer.byteLength(body) > LIMITS.baasRecordBytesPerProject) {
        quotaError = { code: 'quota_exceeded', message: '这个作品保存的数据总量已达上限，请先清理不需要的内容。' };
      } else if (!collectionExists && collectionCount >= LIMITS.baasCollectionsPerProject) {
        quotaError = { code: 'collection_quota_exceeded', message: '这个作品的数据分类数量已达上限，请复用现有分类。' };
      }
      if (quotaError) db.exec('ROLLBACK');
      else {
        db.prepare('INSERT INTO baas_records (id,project_id,collection,data,created_at) VALUES (?,?,?,?,?)')
          .run(rid, id, req.params.collection, body, now());
        db.exec('COMMIT');
      }
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 事务未成功开启 */ }
      throw error;
    }
    if (quotaError) {
      logCall(id, 'data_write', false);
      return reply.code(429).send({ error: quotaError });
    }
    logCall(id, 'data_write', true);
    return reply.code(201).send({ id: rid, created_at: now() });
  });

  app.get('/baas/v1/:collection', async (req) => {
    const { id } = req.project;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = db.prepare(`SELECT id,data,created_at FROM baas_records
                             WHERE project_id=? AND collection=? ORDER BY created_at DESC LIMIT ?`)
      .all(id, req.params.collection, limit);
    logCall(id, 'data_read', true);
    return { items: rows.map((r) => ({ id: r.id, created_at: r.created_at, ...JSON.parse(r.data) })) };
  });

  app.delete('/baas/v1/:collection/:id', { preHandler: [authRequired(), async (req, reply) => {
    if (req.auth.project_id !== req.project.id) {
      return reply.code(404).send({ error: { code: 'not_found', message: '找不到这条数据。' } });
    }
  }] }, async (req) => {
    const changed = db.prepare('DELETE FROM baas_records WHERE id=? AND project_id=? AND collection=?')
      .run(req.params.id, req.project.id, req.params.collection).changes;
    logCall(req.project.id, 'data_write', !!changed);
    return { ok: !!changed };
  });

  app.post('/baas/v1/counter/:key', async (req, reply) => {
    const { id } = req.project;
    let quotaError = null;
    try {
      db.exec('BEGIN IMMEDIATE');
      const keyExists = db.prepare('SELECT 1 FROM baas_counters WHERE project_id=? AND key=? LIMIT 1').get(id, req.params.key);
      const keyCount = Number(db.prepare('SELECT COUNT(*) AS n FROM baas_counters WHERE project_id=?').get(id).n || 0);
      if (!keyExists && keyCount >= LIMITS.baasCounterKeysPerProject) {
        quotaError = { code: 'counter_key_quota_exceeded', message: '这个作品的计数器种类已达上限，请复用现有计数器。' };
        db.exec('ROLLBACK');
      } else {
        db.prepare(`INSERT INTO baas_counters (project_id,key,value) VALUES (?,?,1)
                    ON CONFLICT(project_id,key) DO UPDATE SET value=value+1`).run(id, req.params.key);
        db.exec('COMMIT');
      }
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 事务未成功开启 */ }
      throw error;
    }
    if (quotaError) {
      logCall(id, 'counter', false);
      return reply.code(429).send({ error: quotaError });
    }
    const v = db.prepare('SELECT value FROM baas_counters WHERE project_id=? AND key=?').get(id, req.params.key);
    logCall(id, 'counter', true);
    return { value: v.value };
  });

  app.post('/baas/v1/files', async (req, reply) => {
    const { id } = req.project;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: { code: 'missing_file', message: '没有收到文件。' } });
    const fid = 'f_' + nanoid(12);
    const dir = join(paths.uploads, id);
    mkdirSync(dir, { recursive: true });
    const safeName = (file.filename || 'file').replace(/[^\w.\-]/g, '_').slice(-80);
    const rel = `${fid}_${safeName}`;
    mkdirSync(paths.tmp, { recursive: true });
    const staged = join(paths.tmp, `file_${fid}`);
    await pipeline(file.file, createWriteStream(staged));
    if (file.file.truncated) {
      rmSync(staged, { force: true });
      logCall(id, 'file', false);
      return reply.code(413).send({ error: { code: 'file_too_large', message: '文件太大了。' } });
    }
    const size = statSync(staged).size;
    if (size > LIMITS.baasFileBytes) {
      rmSync(staged, { force: true });
      logCall(id, 'file', false);
      return reply.code(413).send({ error: { code: 'file_too_large', message: '文件太大了。', hint: '单个文件请控制在 20 MB 以内' } });
    }
    const destination = join(dir, rel);
    let moved = false;
    let quotaError = null;
    try {
      // 最终复查与写入在同一 SQLite 写事务中，防止并发上传一起越过 200 MB。
      db.exec('BEGIN IMMEDIATE');
      const used = Number(db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM baas_files WHERE project_id=?').get(id).n || 0);
      if (used + size > LIMITS.baasBytesPerProject) {
        quotaError = { status: 429, code: 'quota_exceeded', message: '这个作品的文件空间用满了。', hint: '删除不用的文件后再上传' };
      } else if (projectDiskUsage(id).used_bytes + size > LIMITS.projectDiskBytes) {
        quotaError = { status: 413, code: 'project_disk_quota_exceeded', message: '这个项目的磁盘空间快用完了，暂时不能上传这个文件。', hint: '删除旧文件或压缩素材后再试' };
      }
      if (quotaError) {
        db.exec('ROLLBACK');
        rmSync(staged, { force: true });
      } else {
        renameSync(staged, destination);
        moved = true;
        db.prepare('INSERT INTO baas_files (id,project_id,filename,mime,size,path,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(fid, id, safeName, file.mimetype ?? null, size, rel, now());
        db.exec('COMMIT');
      }
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 事务未成功开启 */ }
      rmSync(moved ? destination : staged, { force: true });
      throw error;
    }
    if (quotaError) {
      logCall(id, 'file', false);
      return reply.code(quotaError.status).send({ error: quotaError });
    }
    logCall(id, 'file', true);
    return reply.code(201).send({ id: fid, url: `/baas/v1/files/${id}/${rel}`, filename: safeName });
  });
}
