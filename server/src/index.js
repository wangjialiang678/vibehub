import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { db, now } from './lib/db.js';
import { PORT, HOST, LIMITS, paths, CONSOLE_ORIGIN, WORKS_PREFIX, DATA_DIR } from './lib/config.js';
import { authRequired } from './lib/auth.js';
import skillRoutes from './routes/skill.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';
import baasRoutes from './routes/baas.js';
import { projectSnapshot, diagnosisView } from './routes/_shared.js';

for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 2 * 1024 * 1024 });

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: LIMITS.bundleBytes, files: 1 } });

// 控制台是另一个 origin（决策 2 的安全修订），需要 CORS + 带 cookie
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && (origin === CONSOLE_ORIGIN || /^http:\/\/localhost:\d+$/.test(origin))) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Headers', 'content-type,authorization,x-vibehub-project');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return reply.code(204).send();
});

app.get('/healthz', async () => ({ ok: true, at: now() }));

await app.register(skillRoutes);
await app.register(adminRoutes);
await app.register(publicRoutes);
await app.register(baasRoutes);

// ── 学员端网页接口 ──────────────────────────────────────────────────
app.post('/api/session/redeem', async (req, reply) => {
  // 决策 3：邀请码即身份。复用 skill 的绑定逻辑，再种一个 host-only cookie。
  const res = await app.inject({
    method: 'POST', url: '/api/skill/bind',
    payload: { code: req.body?.code, device_name: '网页' },
  });
  const data = res.json();
  if (res.statusCode >= 400) return reply.code(res.statusCode).send(data);
  // host-only cookie：不设 Domain，作品域拿不到
  reply.setCookie('vh_session', data.token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
  });
  return { user: data.user, camp: data.camp, project: data.project, role: 'student' };
});

app.post('/api/session/logout', async (req, reply) => {
  reply.clearCookie('vh_session', { path: '/' });
  return { ok: true };
});

app.get('/api/me', { preHandler: authRequired() }, async (req) => {
  const u = db.prepare('SELECT id,username,display_name,avatar_url FROM users WHERE id=?').get(req.auth.user_id);
  const c = db.prepare('SELECT id,slug,name,kind FROM camps WHERE id=?').get(req.auth.camp_id);
  return { user: u, camp: c, role: req.auth.role, project_id: req.auth.project_id };
});

app.get('/api/projects/:id', { preHandler: authRequired() }, async (req, reply) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  // 越权返回 404，不泄露「存在但无权」
  if (!p || p.camp_id !== req.auth.camp_id) return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个项目。' } });
  const teacher = req.auth.role === 'teacher' || req.auth.role === 'admin';
  if (!teacher && p.id !== req.auth.project_id) return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个项目。' } });
  return projectSnapshot(p.id);
});

app.patch('/api/projects/:id', { preHandler: authRequired() }, async (req, reply) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  const teacher = req.auth.role === 'teacher' || req.auth.role === 'admin';
  if (!p || (!teacher && p.id !== req.auth.project_id)) {
    return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个项目。' } });
  }
  const { title, tagline, category, cover_url } = req.body || {};
  db.prepare(`UPDATE projects SET title=COALESCE(?,title), tagline=COALESCE(?,tagline),
              category=COALESCE(?,category), cover_url=COALESCE(?,cover_url), updated_at=? WHERE id=?`)
    .run(title ?? null, tagline ?? null, category ?? null, cover_url ?? null, now(), p.id);
  return projectSnapshot(p.id);
});

app.get('/api/projects/:id/versions', { preHandler: authRequired() }, async (req, reply) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  const teacher = req.auth.role === 'teacher' || req.auth.role === 'admin';
  if (!p || (!teacher && p.id !== req.auth.project_id)) {
    return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个项目。' } });
  }
  const rows = db.prepare('SELECT * FROM versions WHERE project_id=? ORDER BY seq DESC LIMIT 50').all(p.id);
  return {
    items: rows.map((v) => ({
      id: v.id, label: v.label, seq: v.seq, summary: v.summary, submitted_at: v.submitted_at,
      review: db.prepare('SELECT status,comment,decided_at FROM reviews WHERE version_id=? ORDER BY created_at DESC LIMIT 1').get(v.id),
      diagnosis_score: diagnosisView(v.id)?.score ?? null,
    })),
  };
});

// ── 作品静态托管（本地开发用；生产由 nginx 直接 serve）────────────────
// 路径式：/vibehub/<username>/<project>/  与  /vibehub/_preview/<pid>/
const SDK = readFileSync(new URL('./runtime/sdk.js', import.meta.url), 'utf8');
app.get(`${WORKS_PREFIX}/_sdk/vibehub.js`, async (req, reply) =>
  reply.type('application/javascript').send(SDK));

const MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'video/webm', '.mp4': 'video/mp4' };

function serveFrom(root, rest, reply) {
  // 防目录穿越：normalize 后必须仍在 root 之内
  const clean = normalize(decodeURIComponent(rest || '')).replace(/^(\.\.[/\\])+/, '');
  let target = join(root, clean);
  if (!target.startsWith(root)) return reply.code(403).send('forbidden');
  if (!existsSync(target)) return reply.code(404).type('text/html').send('<h1>404</h1><p>这个页面还没有内容。</p>');
  if (statSync(target).isDirectory()) target = join(target, 'index.html');
  if (!existsSync(target)) return reply.code(404).type('text/html').send('<h1>404</h1>');
  const ext = target.slice(target.lastIndexOf('.')).toLowerCase();
  return reply.type(MIME[ext] || 'application/octet-stream').send(readFileSync(target));
}

app.get(`${WORKS_PREFIX}/_preview/:pid/*`, async (req, reply) =>
  serveFrom(join(paths.previews, req.params.pid), req.params['*'], reply));
app.get(`${WORKS_PREFIX}/_preview/:pid`, async (req, reply) => reply.redirect(`${WORKS_PREFIX}/_preview/${req.params.pid}/`));

// 浏览量信标。生产环境 nginx 直接 serve 静态文件不经过这里，
// 所以由作品页里注入的 SDK 主动 POST 一次。
app.post(`${WORKS_PREFIX}/_hit`, async (req, reply) => {
  const m = String(req.body?.path || '').match(/\/vibehub\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)\//i);
  if (m) countView(m[1], m[2]);
  return reply.code(204).send();
});

app.get(`${WORKS_PREFIX}/:username/:slug/*`, async (req, reply) =>
  serveFrom(join(paths.sites, req.params.username, req.params.slug), req.params['*'], reply));
app.get(`${WORKS_PREFIX}/:username/:slug`, async (req, reply) =>
  reply.redirect(`${WORKS_PREFIX}/${req.params.username}/${req.params.slug}/`));

function countView(username, slug) {
  try {
    const p = db.prepare(`SELECT p.id FROM projects p JOIN users u ON u.id=p.owner_user_id
                          WHERE u.username=? AND p.slug=?`).get(username, slug);
    if (!p) return;
    db.prepare(`INSERT INTO page_views (project_id,day,views) VALUES (?,date('now'),1)
                ON CONFLICT(project_id,day) DO UPDATE SET views=views+1`).run(p.id);
  } catch { /* 统计失败不影响访问 */ }
}

app.listen({ port: PORT, host: HOST }).then(() => {
  app.log.info(`VibeHub 服务已启动  数据目录=${DATA_DIR}`);
});
