import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import { mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join, normalize } from 'node:path';
import { db, now } from './lib/db.js';
import { PORT, HOST, LIMITS, paths, CONSOLE_ORIGIN, WORKS_PREFIX, DATA_DIR } from './lib/config.js';
import { authRequired, assertProjectAccess, hasAllowedCookieOrigin } from './lib/auth.js';
import skillRoutes from './routes/skill.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';
import baasRoutes from './routes/baas.js';
import { projectSnapshot, diagnosisView } from './routes/_shared.js';
import { DiagnosisQueue } from './services/diagnosis-queue.js';
import { probePreviewHttp } from './services/preview-probe.js';
import { cleanupTmp, diskHealth, pruneProjectArtifacts } from './services/storage.js';
import { authorizePreviewRequest, createPreviewGrant, previewCookieName } from './services/preview-access.js';
import { redactPreviewClaim } from './lib/preview-claims.js';

const MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'video/webm', '.mp4': 'video/mp4' };

function serveFrom(root, rest, reply) {
  // 防目录穿越：normalize 后必须仍在 root 之内。
  const clean = normalize(decodeURIComponent(rest || '')).replace(/^(\.\.[/\\])+/, '');
  if (clean.split(/[\\/]/).some((segment) => segment && segment !== '.' && segment.startsWith('.') && segment !== '.well-known')) {
    return reply.code(404).type('text/html').send('<h1>404</h1>');
  }
  let target = join(root, clean);
  if (!target.startsWith(root)) return reply.code(403).send('forbidden');
  if (!existsSync(target)) return reply.code(404).type('text/html').send('<h1>404</h1><p>这个页面还没有内容。</p>');
  if (statSync(target).isDirectory()) target = join(target, 'index.html');
  if (!existsSync(target)) return reply.code(404).type('text/html').send('<h1>404</h1>');
  const ext = target.slice(target.lastIndexOf('.')).toLowerCase();
  return reply.type(MIME[ext] || 'application/octet-stream').send(readFileSync(target));
}

function countView(username, slug) {
  try {
    const project = db.prepare(`SELECT p.id FROM projects p JOIN users u ON u.id=p.owner_user_id
                                WHERE u.username=? AND p.slug=?`).get(username, slug);
    if (!project) return;
    db.prepare(`INSERT INTO page_views (project_id,day,views) VALUES (?,date('now'),1)
                ON CONFLICT(project_id,day) DO UPDATE SET views=views+1`).run(project.id);
  } catch { /* 统计失败不影响访问 */ }
}

function suspendedPage() {
  return '<!doctype html><meta charset="utf-8"><title>作品暂时下线</title><main style="max-width:36rem;margin:12vh auto;font:16px system-ui;line-height:1.7"><h1>这个作品暂时下线了</h1><p>老师正在处理内容或更新，稍后再来看看。</p></main>';
}

/** 供集成测试使用：构建 app 但不监听真实端口。 */
export async function buildApp({ probePreview = probePreviewHttp } = {}) {
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  cleanupTmp();
  // 版本保留不是只在有新提交时才生效；服务重启也会收敛历史项目的遗留产物。
  for (const project of db.prepare('SELECT id FROM projects').all()) pruneProjectArtifacts(project.id);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      serializers: {
        req: (request) => ({
          method: request.method,
          url: redactPreviewClaim(request.url),
          host: request.hostname,
          remoteAddress: request.ip,
        }),
      },
    },
    bodyLimit: 2 * 1024 * 1024,
  });
  const diagnosisQueue = new DiagnosisQueue({ probePreview, log: app.log });
  const tmpCleaner = setInterval(() => cleanupTmp(), 10 * 60 * 1000);
  tmpCleaner.unref();
  app.addHook('onClose', async () => clearInterval(tmpCleaner));

  // 进程重启前已经落盘但尚未完成的诊断不能永远显示「更新中」。复用原记录续跑，
  // 不新建重复任务，也不会让同一 version 同时跑两次。
  const interrupted = db.prepare(`SELECT d.id AS diagnosis_id,v.id AS version_id,v.project_id,v.flows,v.preview_id,p.camp_id,p.owner_user_id
                                  FROM diagnoses d JOIN versions v ON v.id=d.version_id
                                  JOIN projects p ON p.id=v.project_id WHERE d.status='running'`).all();
  app.addHook('onListen', async () => {
    for (const task of interrupted) {
      let flows = [];
      try { flows = JSON.parse(task.flows || '[]'); } catch { /* 元数据损坏时仍可做其余诊断 */ }
      diagnosisQueue.enqueue({
        diagnosisId: task.diagnosis_id, versionId: task.version_id, projectId: task.project_id,
        campId: task.camp_id, versionDir: join(paths.versions, task.version_id),
        previewUrl: () => {
          const identity = db.prepare(`SELECT * FROM tokens WHERE user_id=? AND camp_id=? AND project_id=?
                                       AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>=?)
                                       ORDER BY created_at DESC LIMIT 1`)
            .get(task.owner_user_id, task.camp_id, task.project_id, now());
          return identity ? createPreviewGrant(task.preview_id, identity)?.preview_url : null;
        },
        flows,
      });
    }
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: LIMITS.bundleBytes, files: 1 } });

  // 控制台是另一个 origin（决策 2 的安全修订），需要 CORS + 带 cookie。
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && (origin === CONSOLE_ORIGIN || /^http:\/\/localhost:\d+$/.test(origin))) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Allow-Headers', 'content-type,authorization');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.get('/healthz', async (req) => {
    const health = diskHealth();
    if (health.warning) req.log.error({ disk_used_percent: health.used_percent }, '磁盘使用率超过 80%');
    return health.warning ? { ok: true, at: now(), warning: `磁盘使用率 ${health.used_percent}%，请尽快清理空间` } : { ok: true, at: now() };
  });
  app.get('/api/internal/queue', { preHandler: authRequired(['teacher', 'admin']) }, async () => diagnosisQueue.snapshot());

  await app.register(skillRoutes, { diagnosisQueue });
  await app.register(adminRoutes);
  await app.register(publicRoutes);
  await app.register(baasRoutes);

  // ── 学员端网页接口 ──────────────────────────────────────────────
  app.post('/api/session/redeem', async (req, reply) => {
    // 决策 3：邀请码即身份。复用 skill 的绑定逻辑，再种一个 host-only cookie。
    const res = await app.inject({ method: 'POST', url: '/api/skill/bind', payload: { code: req.body?.code, device_name: '网页' } });
    const data = res.json();
    if (res.statusCode >= 400) return reply.code(res.statusCode).send(data);
    reply.setCookie('vh_session', data.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return { user: data.user, camp: data.camp, project: data.project, role: 'student' };
  });

  app.post('/api/session/logout', async (req, reply) => {
    if (!hasAllowedCookieOrigin(req)) {
      return reply.code(403).send({ error: { code: 'csrf_origin_invalid', message: '请从 VibeHub 控制台发起此操作。' } });
    }
    reply.clearCookie('vh_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: authRequired() }, async (req) => {
    const user = db.prepare('SELECT id,username,display_name,avatar_url FROM users WHERE id=?').get(req.auth.user_id);
    const camp = db.prepare('SELECT id,slug,name,kind FROM camps WHERE id=?').get(req.auth.camp_id);
    return { user, camp, role: req.auth.role, project_id: req.auth.project_id };
  });

  app.post('/api/previews/:pid/grant', { preHandler: authRequired() }, async (req, reply) => {
    const grant = createPreviewGrant(req.params.pid, req.auth);
    if (!grant) return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个预览。' } });
    return reply.header('cache-control', 'no-store').send(grant);
  });

  app.get('/api/projects/:id', { preHandler: authRequired() }, async (req, reply) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!assertProjectAccess(project, req.auth)) return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个项目。' } });
    return projectSnapshot(project.id);
  });

  app.patch('/api/projects/:id', { preHandler: authRequired() }, async (req, reply) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!assertProjectAccess(project, req.auth)) return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个项目。' } });
    const { title, tagline, category, cover_url } = req.body || {};
    db.prepare(`UPDATE projects SET title=COALESCE(?,title), tagline=COALESCE(?,tagline),
                category=COALESCE(?,category), cover_url=COALESCE(?,cover_url), updated_at=? WHERE id=?`)
      .run(title ?? null, tagline ?? null, category ?? null, cover_url ?? null, now(), project.id);
    return projectSnapshot(project.id);
  });

  app.get('/api/projects/:id/versions', { preHandler: authRequired() }, async (req, reply) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!assertProjectAccess(project, req.auth)) return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个项目。' } });
    const rows = db.prepare('SELECT * FROM versions WHERE project_id=? ORDER BY seq DESC LIMIT 50').all(project.id);
    return { items: rows.map((version) => ({
      id: version.id, label: version.label, seq: version.seq, summary: version.summary, submitted_at: version.submitted_at,
      artifact_pruned: !!version.artifact_pruned,
      review: db.prepare('SELECT status,comment,decided_at FROM reviews WHERE version_id=? ORDER BY created_at DESC LIMIT 1').get(version.id),
      diagnosis_score: diagnosisView(version.id)?.score ?? null,
    })) };
  });

  // ── 作品静态托管（本地开发用；生产由 nginx 直接 serve）─────────────
  const sdk = readFileSync(new URL('./runtime/sdk.js', import.meta.url), 'utf8');
  app.get(`${WORKS_PREFIX}/_sdk/vibehub.js`, async (req, reply) => reply.type('application/javascript').send(sdk));
  const previewAccess = (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', `frame-ancestors 'self' ${CONSOLE_ORIGIN}`);
    const cookieName = previewCookieName(req.params.pid);
    const hasQueryClaim = Object.prototype.hasOwnProperty.call(req.query || {}, 'claim');
    const queryClaim = hasQueryClaim ? req.query.claim : null;
    const access = authorizePreviewRequest(req.params.pid, hasQueryClaim ? queryClaim : req.cookies?.[cookieName]);
    if (!access) {
      reply.code(404).type('text/html').send('<h1>404</h1>');
      return 'denied';
    }
    if (hasQueryClaim) {
      reply.setCookie(cookieName, queryClaim, {
        path: `${WORKS_PREFIX}/_preview/${req.params.pid}`,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: access.maxAge,
      });
      const target = new URL(req.raw.url, 'http://vibehub.local');
      target.searchParams.delete('claim');
      reply.redirect(`${target.pathname}${target.search}`, 303);
      return 'redirected';
    }
    return 'authorized';
  };
  app.get(`${WORKS_PREFIX}/_preview/:pid/*`, async (req, reply) => {
    if (previewAccess(req, reply) !== 'authorized') return reply;
    return serveFrom(join(paths.previews, req.params.pid), req.params['*'], reply);
  });
  app.get(`${WORKS_PREFIX}/_preview/:pid`, async (req, reply) => {
    if (previewAccess(req, reply) !== 'authorized') return reply;
    const target = new URL(req.raw.url, 'http://vibehub.local');
    return reply.redirect(`${target.pathname}/${target.search}`);
  });

  app.post(`${WORKS_PREFIX}/_hit`, async (req, reply) => {
    const match = String(req.body?.path || '').match(/\/vibehub\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)\//i);
    if (match) countView(match[1], match[2]);
    return reply.code(204).send();
  });

  app.get(`${WORKS_PREFIX}/:username/:slug/*`, async (req, reply) => {
    const project = db.prepare(`SELECT p.publish_status FROM projects p JOIN users u ON u.id=p.owner_user_id
                                WHERE u.username=? AND p.slug=?`).get(req.params.username, req.params.slug);
    if (project?.publish_status === 'suspended') return reply.type('text/html; charset=utf-8').send(suspendedPage());
    return serveFrom(join(paths.sites, req.params.username, req.params.slug), req.params['*'], reply);
  });
  app.get(`${WORKS_PREFIX}/:username/:slug`, async (req, reply) => reply.redirect(`${WORKS_PREFIX}/${req.params.username}/${req.params.slug}/`));

  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await buildApp();
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`VibeHub 服务已启动  数据目录=${DATA_DIR}`);
}
