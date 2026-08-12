import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';

// 必须在导入服务端模块前确定隔离的数据目录，避免测试污染本机开发数据。
const dataDir = mkdtempSync(join(tmpdir(), 'vh-routes-'));
process.env.VIBEHUB_DATA_DIR = dataDir;
process.env.VIBEHUB_MODEL_GATEWAY_URL = '';
process.env.VIBEHUB_PREVIEW_CLAIM_SECRET = 'preview-auth-test-secret-at-least-32-bytes';

const { buildApp } = await import('../src/index.js');
const { db, now } = await import('../src/lib/db.js');
const { issueToken } = await import('../src/lib/auth.js');
const { paths, LIMITS, previewUrl: configuredPreviewUrl } = await import('../src/lib/config.js');
const { collectFacts, score, summarize } = await import('../src/services/diagnosis.js');
const { projectSnapshot } = await import('../src/routes/_shared.js');
const { probePreviewHttp } = await import('../src/services/preview-probe.js');
const { pruneProjectArtifacts, projectDiskUsage } = await import('../src/services/storage.js');
const { makePreview, publishVersion } = await import('../src/services/publish.js');
const { redactPreviewClaim } = await import('../src/lib/preview-claims.js');

const app = await buildApp({
  probePreview: async () => ({
    status: 'ok',
    entry_status: 200,
    resource_failures: [],
    checked_at: now(),
    console_errors: { status: 'unknown', items: [] },
    screenshot: { status: 'unknown' },
    visible_content: { status: 'unknown' },
    interactive_elements: { status: 'unknown' },
  }),
});

let sequence = 0;
const nextId = (prefix) => `${prefix}_${++sequence}`;

function clearDatabase() {
  db.exec(`
    DELETE FROM audit_logs;
    DELETE FROM page_views;
    DELETE FROM baas_calls;
    DELETE FROM baas_files;
    DELETE FROM baas_counters;
    DELETE FROM baas_records;
    DELETE FROM diagnoses;
    DELETE FROM deployments;
    DELETE FROM reviews;
    DELETE FROM versions;
    DELETE FROM projects;
    DELETE FROM tokens;
    DELETE FROM invites;
    DELETE FROM camp_members;
    DELETE FROM users;
    DELETE FROM camps;
  `);
  for (const dir of Object.values(paths)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

function createCamp({ visibility = 'nickname' } = {}) {
  const id = nextId('c');
  db.prepare(`INSERT INTO camps (id,slug,name,visibility_default,created_at)
              VALUES (?,?,?,?,?)`).run(id, `camp-${sequence}`, '测试营地', visibility, now());
  return { id, slug: `camp-${sequence}` };
}

function createUser(campId, role = 'student', { displayName = '测试学员', realName = '真实姓名' } = {}) {
  const id = nextId('u');
  const username = `user-${sequence}`;
  db.prepare(`INSERT INTO users (id,username,display_name,real_name,created_at)
              VALUES (?,?,?,?,?)`).run(id, username, displayName, realName, now());
  db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
    .run(campId, id, role, now());
  return { id, username, displayName };
}

function createProject(campId, ownerId, { publishStatus = 'unpublished', liveVersionId = null, pendingVersionId = null } = {}) {
  const id = nextId('p');
  const slug = `project-${sequence}`;
  db.prepare(`INSERT INTO projects
    (id,camp_id,owner_user_id,slug,title,publish_status,live_version_id,pending_version_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, campId, ownerId, slug, '测试作品', publishStatus, liveVersionId, pendingVersionId, now(), now());
  return { id, slug };
}

function addVersion(projectId, ownerId, seq, { id = nextId('v') } = {}) {
  const previewId = sequence.toString(36).padStart(16, 'p').slice(-16);
  const dir = join(paths.versions, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<main>测试页面</main>');
  db.prepare(`INSERT INTO versions
    (id,project_id,label,seq,bundle_sha,bundle_size,file_count,preview_id,submitted_by,submitted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, `v${seq}`, seq, `sha-${id}`, 32, 1, previewId, ownerId, now());
  return { id, previewId };
}

function addReview({ versionId, projectId, campId, status = 'pending' }) {
  const id = nextId('r');
  db.prepare(`INSERT INTO reviews (id,version_id,project_id,camp_id,status,created_at)
              VALUES (?,?,?,?,?,?)`).run(id, versionId, projectId, campId, status, now());
  return id;
}

function teacherToken(campId) {
  const teacher = createUser(campId, 'teacher', { displayName: '老师', realName: '老师' });
  return { teacher, token: issueToken({ kind: 'web', userId: teacher.id, campId, role: 'teacher' }) };
}

function activatePreview(projectId, version) {
  makePreview({ previewId: version.previewId, versionId: version.id });
  db.prepare('UPDATE projects SET pending_version_id=? WHERE id=?').run(version.id, projectId);
}

function previewClaimFrom(url) {
  return new URL(url).searchParams.get('claim');
}

function expiredPreviewClaim(claim) {
  const [encoded] = claim.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  payload.exp = Math.floor(Date.now() / 1000) - 1;
  const expiredPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', process.env.VIBEHUB_PREVIEW_CLAIM_SECRET).update(expiredPayload).digest('base64url');
  return `${expiredPayload}.${signature}`;
}

async function bindStudent(campId, appInstance = app) {
  const code = `TEST-${String(++sequence).padStart(4, '0')}`;
  db.prepare(`INSERT INTO invites (code,camp_id,role,status,max_devices,created_at)
              VALUES (?,?,'student','unused',3,?)`).run(code, campId, now());
  const response = await appInstance.inject({
    method: 'POST', url: '/api/skill/bind', payload: { code, device_name: '测试设备' },
  });
  assert.equal(response.statusCode, 200);
  return { code, ...response.json() };
}

function bundle(extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vh-bundle-'));
  const archive = join(mkdtempSync(join(tmpdir(), 'vh-archive-')), 'bundle.tgz');
  writeFileSync(join(dir, 'index.html'), '<html><body>这是一个具备足够可见内容的可提交版本，用来验证提交、审核和发布的完整路径。</body></html>');
  for (const [path, content] of Object.entries(extraFiles)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  execFileSync('tar', ['-czf', archive, '-C', dir, '.']);
  return readFileSync(archive);
}

function multipartUpload(content, meta = {}) {
  const boundary = `----vibehub-${Date.now()}-${sequence}`;
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.tgz"\r\nContent-Type: application/gzip\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return { boundary, payload: Buffer.concat(chunks) };
}

function multipartFile(content, filename = 'file.txt') {
  const boundary = `----vibehub-file-${Date.now()}-${sequence}`;
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function worksReferer(student) {
  return `http://localhost:4300/vibehub/${student.user.username}/${student.project.slug}/`;
}

async function waitFor(check, message) {
  for (let i = 0; i < 40; i += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

beforeEach(clearDatabase);
after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('预览分数只采信真实 HTTP 探测，并保存探测事实', () => {
  const facts = { has_index: true, file_count: 1, missing_ref_count: 0, missing_refs: [], uses_sdk: false, baas_calls_total: 0, baas_calls_ok: 0, baas_records: 0, placeholder_hits: 0 };
  const probe = { status: 'ok', entry_status: 200, resource_failures: [], checked_at: '2026-07-25T00:00:00.000Z' };
  const passed = score(facts, { previewProbe: probe });
  const item = passed.items.find((candidate) => candidate.check_key === 'preview_reachable');
  assert.equal(item.result, 'pass');
  assert.equal(item.earned_points, 20);
  assert.equal(item.evidence.http_status, 200);
  assert.deepEqual(item.evidence.resource_failures, []);

  const unprobed = score(facts, {});
  const unknown = unprobed.items.find((candidate) => candidate.check_key === 'preview_reachable');
  assert.equal(unknown.result, 'unknown');
  assert.equal(unknown.evidence_level, 'human_required');
  assert.equal(unknown.earned_points, 0);
});

test('未声明核心路径仍计入完成度和验证覆盖率的分母，声明只补充证据', () => {
  const facts = {
    has_index: true, file_count: 3, index_visible_text_length: 80,
    missing_ref_count: 0, missing_refs: [], uses_sdk: false,
    baas_calls_total: 0, baas_calls_ok: 0, baas_records: 0, placeholder_hits: 0,
  };
  const undeclared = score(facts, {});
  const core = undeclared.items.find((item) => item.check_key === 'core_flows');
  const applicable = undeclared.items.filter((item) => item.applicability === 'applicable');
  const verified = applicable.filter((item) => item.evidence_level === 'verified');

  assert.equal(core.applicability, 'applicable');
  assert.equal(core.result, 'unknown');
  assert.equal(core.evidence_level, 'human_required');
  assert.deepEqual(core.evidence.flows, []);
  assert.equal(core.evidence.declaration_status, 'undeclared');
  assert.match(core.evidence.note, /未声明.*待人工确认/);
  assert.equal(core.earned_points, 0);
  assert.equal(undeclared.applicable_max, applicable.filter((item) => item !== core).reduce((sum, item) => sum + item.max_points, 0) + core.max_points);
  assert.equal(undeclared.applicable_items, applicable.length);
  assert.equal(undeclared.completeness, Math.round(100 * undeclared.earned / undeclared.max));
  assert.equal(undeclared.verified_ratio, Math.round(100 * verified.length / applicable.length));

  const declared = score(facts, { declaredFlows: ['上传作品'] });
  const declaredCore = declared.items.find((item) => item.check_key === 'core_flows');
  assert.deepEqual(declaredCore.evidence.flows, ['上传作品']);
  assert.equal(declaredCore.evidence.declaration_status, 'declared');
  assert.equal(declared.max, undeclared.max);
  assert.equal(declared.completeness, undeclared.completeness);
  assert.equal(declared.verified_ratio, undeclared.verified_ratio);
});

test('缺失被引用的主样式或脚本会成为 blocker', () => {
  const artifactDir = mkdtempSync(join(tmpdir(), 'vh-missing-static-'));
  try {
    writeFileSync(join(artifactDir, 'index.html'), '<link rel="stylesheet" href="assets/main.css"><script src="assets/main.js?v=1"></script>');
    const facts = collectFacts(artifactDir, 'p_missing_static');
    const scored = score(facts, {});
    const refs = scored.items.find((item) => item.check_key === 'refs_resolve');

    assert.deepEqual(facts.missing_refs, [
      { file: 'index.html', ref: 'assets/main.css' },
      { file: 'index.html', ref: 'assets/main.js?v=1' },
    ]);
    assert.equal(refs.is_blocker, true);
    assert.equal(scored.blocked, true);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('绝对路径引用的缺失主样式/脚本也会成为 blocker（真实采集路径）', () => {
  const artifactDir = mkdtempSync(join(tmpdir(), 'vh-missing-abs-'));
  try {
    // 作品跑在子目录，写 /main.css /app.js 都指向包内根。解包会把「存在的」绝对引用
    // 改成相对，仍以 / 开头的必然是缺失。这里两个目标都不在包内 → 应进 missing_refs 且 blocker。
    writeFileSync(join(artifactDir, 'index.html'),
      '<link rel="stylesheet" href="/main.css"><script src="/app.js"></script><img src="/logo.png">');
    const facts = collectFacts(artifactDir, 'p_missing_abs');
    const scored = score(facts, {});
    assert.deepEqual(facts.missing_refs, [
      { file: 'index.html', ref: '/main.css' },
      { file: 'index.html', ref: '/app.js' },
      { file: 'index.html', ref: '/logo.png' },
    ]);
    assert.equal(scored.blocked, true, '关键 CSS/JS 缺失必须 blocker');
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('大写属性名与等号空格的缺失引用同样被检测为 blocker', () => {
  const artifactDir = mkdtempSync(join(tmpdir(), 'vh-missing-case-'));
  try {
    // 合法 HTML：HREF、SRC = "..." 都要能采集，否则破损版本靠大小写/空格绕过 blocker
    writeFileSync(join(artifactDir, 'index.html'),
      '<link HREF="/main.css"><script SRC = "/app.js"></script>');
    const facts = collectFacts(artifactDir, 'p_case');
    const scored = score(facts, {});
    assert.equal(facts.missing_ref_count, 2);
    assert.equal(scored.blocked, true);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('SDK 排除只针对平台注入路径；/vibehub 下其他缺失脚本仍是 blocker', () => {
  const artifactDir = mkdtempSync(join(tmpdir(), 'vh-sdk-scope-'));
  try {
    // 平台注入的 /vibehub/_sdk/vibehub.js 不算缺失；但学员写的 /vibehub/missing-main.js 真 404 应算
    writeFileSync(join(artifactDir, 'index.html'),
      '<script src="/vibehub/_sdk/vibehub.js" data-vibehub-sdk></script><script src="/vibehub/missing-main.js"></script>');
    const facts = collectFacts(artifactDir, 'p_sdk');
    assert.deepEqual(facts.missing_refs, [{ file: 'index.html', ref: '/vibehub/missing-main.js' }]);
    assert.equal(score(facts, {}).blocked, true);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('SDK 豁免在规范化后判定，_sdk/../ 穿越到真 404 仍是 blocker', () => {
  const artifactDir = mkdtempSync(join(tmpdir(), 'vh-sdk-traverse-'));
  try {
    // 浏览器会把 /vibehub/_sdk/../missing.js 规范化成 /vibehub/missing.js（真 404），不能用原字符串前缀蒙混
    writeFileSync(join(artifactDir, 'index.html'), '<script src="/vibehub/_sdk/../missing.js"></script>');
    const facts = collectFacts(artifactDir, 'p_trav');
    assert.deepEqual(facts.missing_refs, [{ file: 'index.html', ref: '/vibehub/_sdk/../missing.js' }]);
    assert.equal(score(facts, {}).blocked, true);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('新版本诊断中时，不会被旧的 failed 诊断伪装成本次失败', () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const ver1 = addVersion(project.id, owner.id, 1);
  const ver2 = addVersion(project.id, owner.id, 2);
  db.prepare('UPDATE projects SET pending_version_id=? WHERE id=?').run(ver2.id, project.id);
  const insertDiag = (vid, status) => db.prepare(`INSERT INTO diagnoses
    (id,version_id,status,score,policy_version,facts,items,summary,next_steps,created_at,finished_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nextId('d'), vid, status, status === 'running' ? null : 0, 'test', '{}', '[]', 's', '[]',
      now(), status === 'running' ? null : now());
  insertDiag(ver1.id, 'failed');
  insertDiag(ver2.id, 'running');
  const snap = projectSnapshot(project.id);
  // 最新版本 v2 正在诊断 → 应显示 running（stale），绝不能被 v1 的 failed 伪装成"这次失败"
  assert.equal(snap.latest_diagnosis.status, 'running');
  assert.equal(snap.latest_diagnosis.stale, true);
});

test('skill、项目和审核详情都返回可复算的完成度与验证覆盖率', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const version = addVersion(student.project.id, student.user.id, 1);
  const facts = {
    has_index: true, file_count: 1, index_visible_text_length: 80,
    missing_ref_count: 0, missing_refs: [], uses_sdk: false,
    baas_calls_total: 0, baas_calls_ok: 0, baas_records: 0, placeholder_hits: 0,
  };
  const scored = score(facts, {});
  db.prepare('UPDATE projects SET pending_version_id=? WHERE id=?').run(version.id, student.project.id);
  db.prepare(`INSERT INTO diagnoses (id,version_id,status,score,policy_version,facts,items,summary,next_steps,created_at,finished_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nextId('d'), version.id, 'needs_work', 1, 'test', JSON.stringify(facts),
      JSON.stringify(scored.items), '测试诊断', '[]', now(), now());
  const reviewId = addReview({ versionId: version.id, projectId: student.project.id, campId: camp.id });
  const { token: teacherTokenValue } = teacherToken(camp.id);

  const skillProject = await app.inject({ method: 'GET', url: '/api/skill/project', headers: { authorization: `Bearer ${student.token}` } });
  const studentProject = await app.inject({ method: 'GET', url: `/api/projects/${student.project.id}`, headers: { authorization: `Bearer ${student.token}` } });
  const review = await app.inject({ method: 'GET', url: `/api/reviews/${reviewId}`, headers: { authorization: `Bearer ${teacherTokenValue}` } });

  for (const diagnosis of [skillProject.json().latest_diagnosis, studentProject.json().latest_diagnosis, review.json().diagnosis]) {
    assert.equal(diagnosis.score, scored.completeness);
    assert.equal(diagnosis.completeness, scored.completeness);
    assert.equal(diagnosis.verified_ratio, scored.verified_ratio);
    assert.equal(diagnosis.completeness, Math.round(100 * diagnosis.applicable_earned / diagnosis.applicable_max));
    assert.equal(diagnosis.verified_ratio, Math.round(100 * diagnosis.verified_applicable_items / diagnosis.applicable_items));
  }
});

test('诊断仍在运行时，两个尚未计算的指标返回 null 而不是伪装成 0%', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const version = addVersion(student.project.id, student.user.id, 1);
  db.prepare('UPDATE projects SET pending_version_id=? WHERE id=?').run(version.id, student.project.id);
  db.prepare(`INSERT INTO diagnoses (id,version_id,status,score,policy_version,facts,items,summary,next_steps,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(nextId('d'), version.id, 'running', 73, 'test', '{}', '[]', null, '[]', now());

  const project = await app.inject({ method: 'GET', url: '/api/skill/project', headers: { authorization: `Bearer ${student.token}` } });
  const diagnosis = project.json().latest_diagnosis;
  assert.equal(diagnosis.status, 'running');
  assert.equal(diagnosis.score, null);
  assert.equal(diagnosis.completeness, null);
  assert.equal(diagnosis.verified_ratio, null);
});

test('诊断失败时，两个未计算指标和兼容分数也返回 null', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const version = addVersion(student.project.id, student.user.id, 1);
  db.prepare('UPDATE projects SET pending_version_id=? WHERE id=?').run(version.id, student.project.id);
  db.prepare(`INSERT INTO diagnoses (id,version_id,status,score,policy_version,facts,items,summary,next_steps,created_at,finished_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nextId('d'), version.id, 'failed', 73, 'test', '{}', '[]', '诊断失败', '[]', now(), now());

  const project = await app.inject({ method: 'GET', url: '/api/skill/project', headers: { authorization: `Bearer ${student.token}` } });
  const diagnosis = project.json().latest_diagnosis;
  assert.equal(diagnosis.status, 'failed');
  assert.equal(diagnosis.score, null);
  assert.equal(diagnosis.completeness, null);
  assert.equal(diagnosis.verified_ratio, null);
  assert.equal(diagnosis.applicable_earned, null);
  assert.equal(diagnosis.verified_applicable_items, null);
});

test('HTTP 探测会检查入口与同一预览目录的静态资源，浏览器专属事实保持 unknown', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/vibehub/_preview/p1/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<link href="style.css"><img src="missing.png"><script src="ok.js"></script>');
    }
    if (req.url === '/vibehub/_preview/p1/style.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('body { background: url(ok.png) }');
    }
    if (req.url === '/vibehub/_preview/p1/redirect') {
      res.writeHead(302, { location: '/vibehub/_preview/p1/' }); return res.end();
    }
    if (req.url === '/vibehub/_preview/p1/ok.js' || req.url === '/vibehub/_preview/p1/ok.png') return res.end('ok');
    res.writeHead(404); return res.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const probe = await probePreviewHttp(`http://127.0.0.1:${port}/vibehub/_preview/p1/`);
    assert.equal(probe.entry_status, 200);
    assert.equal(probe.status, 'fail');
    assert.deepEqual(probe.resource_failures.map((item) => item.status), [404]);
    assert.equal(probe.console_errors.status, 'unknown');
    assert.equal(probe.screenshot.status, 'unknown');
    const redirected = await probePreviewHttp(`http://127.0.0.1:${port}/vibehub/_preview/p1/redirect`);
    assert.equal(redirected.status, 'fail');
    assert.equal(redirected.entry_status, 302);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('HTTP 探测用 claim 换取 cookie 后跟随干净重定向，资源 URL 和诊断证据不再携带 claim', async () => {
  const requested = [];
  const server = createServer((req, res) => {
    requested.push({ url: req.url, cookie: req.headers.cookie || '' });
    if (req.url === '/vibehub/_preview/p1/?theme=dark&claim=probe-claim') {
      res.writeHead(303, {
        location: '/vibehub/_preview/p1/?theme=dark',
        'set-cookie': 'vh_preview_p1=cookie-claim; Path=/vibehub/_preview/p1; HttpOnly; SameSite=Lax',
      });
      return res.end();
    }
    if (req.url === '/vibehub/_preview/p1/?theme=dark' && req.headers.cookie === 'vh_preview_p1=cookie-claim') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<link href="style.css"><img src="missing.png">');
    }
    if (req.url === '/vibehub/_preview/p1/style.css' && req.headers.cookie === 'vh_preview_p1=cookie-claim') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('body{color:#242321}');
    }
    res.writeHead(404); return res.end('missing cookie');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const probe = await probePreviewHttp(`http://127.0.0.1:${port}/vibehub/_preview/p1/?theme=dark&claim=probe-claim`);
    assert.equal(probe.entry_status, 200);
    assert.equal(probe.status, 'fail');
    assert.deepEqual(probe.resource_failures.map((item) => item.status), [404]);
    assert.deepEqual(requested.map((item) => item.url), [
      '/vibehub/_preview/p1/?theme=dark&claim=probe-claim',
      '/vibehub/_preview/p1/?theme=dark',
      '/vibehub/_preview/p1/style.css',
      '/vibehub/_preview/p1/missing.png',
    ]);
    assert.ok(requested.slice(1).every((item) => item.cookie === 'vh_preview_p1=cookie-claim'));
    assert.doesNotMatch(JSON.stringify(probe), /probe-claim|claim=/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('预览 claim 在请求日志和诊断证据中会被脱敏', () => {
  assert.equal(
    redactPreviewClaim('/vibehub/_preview/p1/?claim=secret-value&asset=1'),
    '/vibehub/_preview/p1/?claim=[redacted]&asset=1',
  );
});

test('请求日志完全丢弃 query，编码后的 claim 参数名也不会绕过脱敏', async () => {
  const { requestUrlForLog } = await import('../src/lib/preview-claims.js');
  assert.equal(requestUrlForLog('/vibehub/_preview/p1/?cl%61im=encoded-secret&asset=1'), '/vibehub/_preview/p1/');
  assert.doesNotMatch(requestUrlForLog('/search?q=ordinary'), /ordinary|\?/);
});

test('提交立即返回，诊断进行中返回上一份报告并标记 stale，审核随后创建', async () => {
  let releaseProbe;
  const waitProbe = new Promise((resolve) => { releaseProbe = resolve; });
  const slowApp = await buildApp({
    probePreview: async () => {
      await waitProbe;
      return { status: 'ok', entry_status: 200, resource_failures: [], resource_checked: 1, checked_at: now() };
    },
  });
  try {
    const camp = createCamp();
    const student = await bindStudent(camp.id, slowApp);
    const live = addVersion(student.project.id, student.user.id, 1);
    db.prepare(`UPDATE projects SET live_version_id=?,publish_status='published' WHERE id=?`).run(live.id, student.project.id);
    db.prepare(`INSERT INTO diagnoses (id,version_id,status,score,policy_version,facts,items,summary,next_steps,created_at,finished_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nextId('d'), live.id, 'healthy', 100, 'test', '{}', '[]', '上一份诊断', '[]', now(), now());
    const form = multipartUpload(bundle(), { label: '异步版本' });
    const deployed = await slowApp.inject({
      method: 'POST', url: '/api/skill/versions', headers: { authorization: `Bearer ${student.token}`, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.payload,
    });
    assert.equal(deployed.statusCode, 201);
    assert.equal(deployed.json().diagnosis.status, 'running');
    const project = await slowApp.inject({ method: 'GET', url: '/api/skill/project', headers: { authorization: `Bearer ${student.token}` } });
    assert.equal(project.statusCode, 200);
    assert.equal(project.json().latest_diagnosis.stale, true);
    assert.equal(project.json().latest_diagnosis.version_id, live.id);
    const newVersionId = deployed.json().version_id;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE version_id=?').get(newVersionId).n, 0);
    releaseProbe();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(db.prepare('SELECT status FROM reviews WHERE version_id=?').get(newVersionId).status, 'pending');
  } finally {
    releaseProbe?.();
    await slowApp.close();
  }
});

test('含敏感文件的部署包不落盘、不生成预览，且同一版本诊断标为 blocker', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const form = multipartUpload(bundle({ '.env': 'API_KEY=sk-example-secret' }));
  const deployed = await app.inject({
    method: 'POST', url: '/api/skill/versions',
    headers: { authorization: `Bearer ${student.token}`, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.payload,
  });
  assert.equal(deployed.statusCode, 422);
  const versionId = db.prepare('SELECT id FROM versions WHERE project_id=? ORDER BY seq DESC LIMIT 1').get(student.project.id).id;
  const diagnosis = db.prepare('SELECT status,facts FROM diagnoses WHERE version_id=? AND status != ?').get(versionId, 'running');
  assert.equal(existsSync(join(paths.versions, versionId, '.env')), false);
  assert.equal(diagnosis.status, 'blocked');
  assert.ok(JSON.parse(diagnosis.facts).secret_findings.some((item) => item.type === 'rejected'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE version_id=?').get(versionId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE version_id=?').get(versionId).n, 0);
});

test('密钥内容命中 secret scan 时不会创建预览或待审记录', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const form = multipartUpload(bundle({ 'app.js': `const key = '${randomBytes(300 * 1024).toString('hex')}sk-secret-after-large-prefix';` }));
  const deployed = await app.inject({
    method: 'POST', url: '/api/skill/versions',
    headers: { authorization: `Bearer ${student.token}`, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.payload,
  });
  assert.equal(deployed.statusCode, 422);
  const versionId = db.prepare('SELECT id FROM versions WHERE project_id=? ORDER BY seq DESC LIMIT 1').get(student.project.id).id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE version_id=?').get(versionId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE version_id=?').get(versionId).n, 0);
  assert.equal(db.prepare('SELECT status FROM diagnoses WHERE version_id=?').get(versionId).status, 'blocked');
});

test('异步诊断发现 blocker 后不进入老师审核队列', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const form = multipartUpload(bundle({ 'index.html': '<html><body></body></html>' }));
  const deployed = await app.inject({
    method: 'POST', url: '/api/skill/versions',
    headers: { authorization: `Bearer ${student.token}`, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.payload,
  });
  assert.equal(deployed.statusCode, 201);
  const versionId = deployed.json().version_id;
  const diagnosis = await waitFor(
    () => db.prepare('SELECT status FROM diagnoses WHERE version_id=? AND status != ?').get(versionId, 'running'),
    'blocker 诊断应在测试时限内完成',
  );
  assert.equal(diagnosis.status, 'blocked');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE version_id=?').get(versionId).n, 0);
  assert.equal(db.prepare('SELECT dev_status FROM projects WHERE id=?').get(student.project.id).dev_status, 'needs_revision');
  // blocked 会清空 pending_version_id，但学员看板仍必须能看到这份 blocked 诊断（否则学员不知道为什么被退回）
  const snapshot = await app.inject({ method: 'GET', url: '/api/skill/project', headers: { authorization: `Bearer ${student.token}` } });
  assert.equal(snapshot.json().latest_diagnosis.status, 'blocked');
});

test('黄金路径 bind → deploy → approve → 正式地址 200 仍可跑通', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const form = multipartUpload(bundle());
  const deployed = await app.inject({
    method: 'POST', url: '/api/skill/versions',
    headers: { authorization: `Bearer ${student.token}`, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.payload,
  });
  assert.equal(deployed.statusCode, 201);
  const versionId = deployed.json().version_id;
  const review = await waitFor(
    () => db.prepare('SELECT * FROM reviews WHERE version_id=? AND status=?').get(versionId, 'pending'),
    '诊断完成后应进入审核队列',
  );
  const { token } = teacherToken(camp.id);
  const approved = await app.inject({ method: 'POST', url: `/api/reviews/${review.id}/approve`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(approved.statusCode, 200);
  const published = await app.inject({ method: 'GET', url: `/vibehub/${student.user.username}/${student.project.slug}/` });
  assert.equal(published.statusCode, 200);
  assert.match(published.body, /具备足够可见内容/);
});

test('邀请码撤销后，该码签发的 token 立即返回 401', async () => {
  const camp = createCamp();
  const { token } = teacherToken(camp.id);
  const student = await bindStudent(camp.id);
  const revoked = await app.inject({ method: 'POST', url: `/api/invites/${student.code}/revoke`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(revoked.statusCode, 200);
  const result = await app.inject({ method: 'GET', url: '/api/skill/project', headers: { authorization: `Bearer ${student.token}` } });
  assert.equal(result.statusCode, 401);
});

test('邀请码撤销与 token 级联处于同一事务，token 更新故障会整体回滚', async () => {
  const camp = createCamp();
  const { token: teacher } = teacherToken(camp.id);
  const student = await bindStudent(camp.id);
  db.exec(`CREATE TEMP TRIGGER fail_invite_token_revoke
           BEFORE UPDATE OF revoked_at ON tokens
           WHEN OLD.invite_code='${student.code}'
           BEGIN SELECT RAISE(ABORT, 'forced revoke failure'); END`);
  try {
    const failed = await app.inject({
      method: 'POST', url: `/api/invites/${student.code}/revoke`, headers: { authorization: `Bearer ${teacher}` },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(db.prepare('SELECT status FROM invites WHERE code=?').get(student.code).status, 'bound');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE invite_code=? AND revoked_at IS NULL').get(student.code).n, 1);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_invite_token_revoke');
  }
});

test('并发撤销同一邀请码保持幂等，结束时邀请码与全部 token 一致失效', async () => {
  const camp = createCamp();
  const { token: teacher } = teacherToken(camp.id);
  const student = await bindStudent(camp.id);
  const second = await app.inject({ method: 'POST', url: '/api/skill/bind', payload: { code: student.code, device_name: '第二台设备' } });
  assert.equal(second.statusCode, 200);

  const responses = await Promise.all([1, 2].map(() => app.inject({
    method: 'POST', url: `/api/invites/${student.code}/revoke`, headers: { authorization: `Bearer ${teacher}` },
  })));
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
  assert.equal(db.prepare('SELECT status FROM invites WHERE code=?').get(student.code).status, 'revoked');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE invite_code=? AND revoked_at IS NULL').get(student.code).n, 0);
});

test('学员读取其他项目返回 404 而不是 403', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const otherOwner = createUser(camp.id);
  const other = createProject(camp.id, otherOwner.id);
  const result = await app.inject({ method: 'GET', url: `/api/projects/${other.id}`, headers: { authorization: `Bearer ${student.token}` } });
  assert.equal(result.statusCode, 404);
});

test('跨课程老师不能修改或查看其他课程项目的版本', async () => {
  const campA = createCamp();
  const { token } = teacherToken(campA.id);
  const campB = createCamp();
  const owner = createUser(campB.id);
  const target = createProject(campB.id, owner.id);
  addVersion(target.id, owner.id, 1);

  const patch = await app.inject({
    method: 'PATCH', url: `/api/projects/${target.id}`,
    headers: { authorization: `Bearer ${token}` }, payload: { title: '越权修改' },
  });
  assert.equal(patch.statusCode, 404);
  assert.equal(db.prepare('SELECT title FROM projects WHERE id=?').get(target.id).title, '测试作品');

  const versions = await app.inject({
    method: 'GET', url: `/api/projects/${target.id}/versions`, headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(versions.statusCode, 404);
});

test('学员提交记录按版本倒序返回审核状态、退回意见和诊断完成度', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const statuses = ['pending', 'approved', 'rejected', 'superseded'];
  for (const [index, status] of statuses.entries()) {
    const version = addVersion(student.project.id, student.user.id, index + 1);
    db.prepare('UPDATE versions SET summary=? WHERE id=?').run(`第 ${index + 1} 次更新说明`, version.id);
    const reviewId = addReview({ versionId: version.id, projectId: student.project.id, campId: camp.id, status });
    if (status === 'rejected') db.prepare('UPDATE reviews SET comment=? WHERE id=?').run('请补充操作说明', reviewId);
    if (status === 'approved') {
      db.prepare(`INSERT INTO diagnoses (id,version_id,status,score,policy_version,facts,items,summary,created_at,finished_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(nextId('d'), version.id, 'healthy', 0, 'test', '{}', JSON.stringify([{ applicability: 'applicable', earned_points: 15, max_points: 20 }]), '完成', now(), now());
    }
  }

  const response = await app.inject({ method: 'GET', url: `/api/projects/${student.project.id}/versions`, headers: { authorization: `Bearer ${student.token}` } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items.map((item) => item.review?.status), ['superseded', 'rejected', 'approved', 'pending']);
  assert.equal(response.json().items[1].review.comment, '请补充操作说明');
  assert.equal(response.json().items[2].diagnosis_score, 75);
});

test('cookie 鉴权的写请求拒绝错误 Origin，但 Bearer 请求不受 CSRF 校验影响', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const payload = { sha256: 'a'.repeat(64), size: 1 };
  const cookieRequest = await app.inject({
    method: 'POST', url: '/api/skill/versions/preflight',
    headers: { cookie: `vh_session=${student.token}`, origin: 'https://evil.example' }, payload,
  });
  assert.equal(cookieRequest.statusCode, 403);

  const bearerRequest = await app.inject({
    method: 'POST', url: '/api/skill/versions/preflight',
    headers: { authorization: `Bearer ${student.token}`, origin: 'https://evil.example' }, payload,
  });
  assert.equal(bearerRequest.statusCode, 200);
});

test('BaaS 忽略伪造项目 header，且负 limit 被夹到一条', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const victim = await bindStudent(camp.id);
  for (const [project, prefix, count] of [[student.project, 'owner', 2], [victim.project, 'victim', 3]]) {
    for (let i = 0; i < count; i += 1) {
      db.prepare(`INSERT INTO baas_records (id,project_id,collection,data,created_at) VALUES (?,?,?,?,?)`)
        .run(nextId('rec'), project.id, 'messages', JSON.stringify({ label: `${prefix}-${i}` }), now());
    }
  }

  const response = await app.inject({
    method: 'GET', url: '/baas/v1/messages?limit=-1',
    headers: { referer: worksReferer(student), 'x-vibehub-project': worksReferer(victim) },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 1);
  assert.match(response.json().items[0].label, /^owner-/);

  const headerOnly = await app.inject({
    method: 'GET', url: '/baas/v1/messages', headers: { 'x-vibehub-project': worksReferer(victim) },
  });
  assert.equal(headerOnly.statusCode, 400);

  const foreignOrigin = await app.inject({
    method: 'GET', url: '/baas/v1/messages',
    headers: { referer: `https://attacker.example/vibehub/${victim.user.username}/${victim.project.slug}/` },
  });
  assert.equal(foreignOrigin.statusCode, 400);
});

test('BaaS 预览身份同时绑定独立 origin 与 preview path，A 域不能冒充 B 项目', async () => {
  const camp = createCamp();
  const first = await bindStudent(camp.id);
  const firstVersion = addVersion(first.project.id, first.user.id, 1);
  activatePreview(first.project.id, firstVersion);
  const second = await bindStudent(camp.id);
  const secondVersion = addVersion(second.project.id, second.user.id, 1);
  activatePreview(second.project.id, secondVersion);
  db.prepare(`INSERT INTO baas_records (id,project_id,collection,data,created_at) VALUES (?,?,?,?,?)`)
    .run(nextId('rec'), second.project.id, 'messages', JSON.stringify({ label: 'second-only' }), now());

  const grant = await app.inject({
    method: 'POST', url: `/api/previews/${secondVersion.previewId}/grant`,
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(grant.statusCode, 200);
  const granted = new URL(grant.json().preview_url);
  const exchange = await app.inject({
    method: 'GET', url: granted.pathname + granted.search, headers: { host: granted.host },
  });
  assert.equal(exchange.statusCode, 303);
  const cookie = exchange.headers['set-cookie'].split(';', 1)[0];
  const validReferer = new URL('page.html', `${granted.origin}${exchange.headers.location}`).href;
  const valid = await app.inject({
    method: 'GET', url: '/baas/v1/messages',
    headers: { host: granted.host, referer: validReferer, cookie },
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json().items.map((item) => item.label), ['second-only']);

  const forgedReferer = new URL(validReferer);
  forgedReferer.host = new URL(configuredPreviewUrl(firstVersion.previewId)).host;
  const forged = await app.inject({
    method: 'GET', url: '/baas/v1/messages',
    headers: { host: forgedReferer.host, referer: forgedReferer.href, cookie },
  });
  assert.equal(forged.statusCode, 400);
});

test('BaaS 删除必须有目标项目的 owner 凭证', async () => {
  const camp = createCamp();
  const owner = await bindStudent(camp.id);
  const outsider = await bindStudent(camp.id);
  const recordId = nextId('rec');
  db.prepare(`INSERT INTO baas_records (id,project_id,collection,data,created_at) VALUES (?,?,?,?,?)`)
    .run(recordId, owner.project.id, 'messages', JSON.stringify({ text: '不能匿名删除' }), now());
  const url = `/baas/v1/messages/${recordId}`;

  const anonymous = await app.inject({ method: 'DELETE', url, headers: { referer: worksReferer(owner) } });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM baas_records WHERE id=?').get(recordId).n, 1);

  const wrongOwner = await app.inject({
    method: 'DELETE', url, headers: { referer: worksReferer(owner), authorization: `Bearer ${outsider.token}` },
  });
  assert.equal(wrongOwner.statusCode, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM baas_records WHERE id=?').get(recordId).n, 1);
});

test('BaaS 限流拒绝不写 baas_calls', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const headers = { referer: worksReferer(student) };
  for (let i = 0; i < 60; i += 1) {
    const response = await app.inject({ method: 'GET', url: '/baas/v1/messages', headers });
    assert.equal(response.statusCode, 200);
  }
  const before = db.prepare('SELECT COUNT(*) AS n FROM baas_calls WHERE project_id=?').get(student.project.id).n;
  const limited = await app.inject({ method: 'GET', url: '/baas/v1/messages', headers });
  assert.equal(limited.statusCode, 429);
  const after = db.prepare('SELECT COUNT(*) AS n FROM baas_calls WHERE project_id=?').get(student.project.id).n;
  assert.equal(after, before);
});

test('BaaS 的记录字节、集合和 counter key 都有项目级配额', async () => {
  const camp = createCamp();
  const records = await bindStudent(camp.id);
  db.prepare(`INSERT INTO baas_records (id,project_id,collection,data,created_at) VALUES (?,?,?,?,?)`)
    .run(nextId('rec'), records.project.id, 'messages', JSON.stringify({ payload: 'x'.repeat(LIMITS.baasRecordBytesPerProject) }), now());
  const recordQuota = await app.inject({
    method: 'POST', url: '/baas/v1/messages', headers: { referer: worksReferer(records) }, payload: { text: 'one more' },
  });
  assert.equal(recordQuota.statusCode, 429);
  assert.equal(recordQuota.json().error.code, 'quota_exceeded');

  const collections = await bindStudent(camp.id);
  for (let i = 0; i < LIMITS.baasCollectionsPerProject; i += 1) {
    db.prepare(`INSERT INTO baas_records (id,project_id,collection,data,created_at) VALUES (?,?,?,?,?)`)
      .run(nextId('rec'), collections.project.id, `c-${i}`, '{}', now());
  }
  const collectionQuota = await app.inject({
    method: 'POST', url: '/baas/v1/one-more', headers: { referer: worksReferer(collections) }, payload: {},
  });
  assert.equal(collectionQuota.statusCode, 429);
  assert.equal(collectionQuota.json().error.code, 'collection_quota_exceeded');

  const counters = await bindStudent(camp.id);
  for (let i = 0; i < LIMITS.baasCounterKeysPerProject; i += 1) {
    db.prepare('INSERT INTO baas_counters (project_id,key,value) VALUES (?,?,1)').run(counters.project.id, `key-${i}`);
  }
  const counterQuota = await app.inject({
    method: 'POST', url: '/baas/v1/counter/one-more', headers: { referer: worksReferer(counters) },
  });
  assert.equal(counterQuota.statusCode, 429);
  assert.equal(counterQuota.json().error.code, 'counter_key_quota_exceeded');
});

test('重复 approve 返回 409，且不二次发布', async () => {
  const camp = createCamp();
  const { teacher, token } = teacherToken(camp.id);
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  const reviewId = addReview({ versionId: version.id, projectId: project.id, campId: camp.id });
  const first = await app.inject({ method: 'POST', url: `/api/reviews/${reviewId}/approve`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(first.statusCode, 200);
  const duplicate = await app.inject({ method: 'POST', url: `/api/reviews/${reviewId}/approve`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM deployments WHERE version_id=? AND target='live'`).get(version.id).n, 1);
  assert.ok(teacher.id);
});

test('老师不能批准已被 blocker 诊断拦下的版本', async () => {
  const camp = createCamp();
  const { token } = teacherToken(camp.id);
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  const reviewId = addReview({ versionId: version.id, projectId: project.id, campId: camp.id });
  db.prepare(`INSERT INTO diagnoses (id,version_id,status,score,policy_version,facts,items,summary,created_at,finished_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(nextId('d'), version.id, 'blocked', 0, 'test', '{}', '[]', '检测到密钥', now(), now());
  const result = await app.inject({ method: 'POST', url: `/api/reviews/${reviewId}/approve`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(result.statusCode, 409);
  assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(reviewId).status, 'pending');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM deployments WHERE version_id=? AND target='live'`).get(version.id).n, 0);
});

test('本地静态托管拒绝 dotfile，避免绕过 nginx 保护', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id, { publishStatus: 'published' });
  const site = join(paths.sites, owner.username, project.slug);
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'index.html'), '<main>正常页面</main>');
  writeFileSync(join(site, '.env'), 'API_KEY=should-not-be-readable');
  const result = await app.inject({ method: 'GET', url: `/vibehub/${owner.username}/${project.slug}/.env` });
  assert.equal(result.statusCode, 404);
  assert.doesNotMatch(result.body, /should-not-be-readable/);
});

test('每个 preview_id 使用独立 origin，恶意预览不能沿同源路径读取其他项目', async () => {
  const camp = createCamp();
  const firstOwner = createUser(camp.id);
  const firstProject = createProject(camp.id, firstOwner.id);
  const firstVersion = addVersion(firstProject.id, firstOwner.id, 1);
  activatePreview(firstProject.id, firstVersion);
  const secondOwner = createUser(camp.id);
  const secondProject = createProject(camp.id, secondOwner.id);
  const secondVersion = addVersion(secondProject.id, secondOwner.id, 1);
  writeFileSync(join(paths.versions, secondVersion.id, 'index.html'), '<main>第二个项目的私有预览内容</main>');
  activatePreview(secondProject.id, secondVersion);

  const firstUrl = new URL(configuredPreviewUrl(firstVersion.previewId));
  const secondUrl = new URL(configuredPreviewUrl(secondVersion.previewId));
  assert.notEqual(firstUrl.origin, secondUrl.origin);
  assert.equal(firstUrl.hostname, `${firstVersion.previewId}.preview.localhost`);
  assert.equal(secondUrl.hostname, `${secondVersion.previewId}.preview.localhost`);

  const secondToken = issueToken({ kind: 'skill', userId: secondOwner.id, campId: camp.id, projectId: secondProject.id, role: 'student' });
  const grant = await app.inject({ method: 'POST', url: `/api/previews/${secondVersion.previewId}/grant`, headers: { authorization: `Bearer ${secondToken}` } });
  const granted = new URL(grant.json().preview_url);
  const exchange = await app.inject({ method: 'GET', url: granted.pathname + granted.search, headers: { host: granted.host } });
  assert.equal(exchange.statusCode, 303);
  assert.doesNotMatch(exchange.headers['set-cookie'], /Domain=/i);
  const cookie = exchange.headers['set-cookie'].split(';', 1)[0];

  // 浏览器无 Origin 的导航/子资源响应也必须带 CORP，禁止被 A origin 嵌入并读取或执行。
  const protectedResponse = await app.inject({
    method: 'GET', url: exchange.headers.location, headers: { host: granted.host, cookie },
  });
  assert.equal(protectedResponse.statusCode, 200);
  assert.match(protectedResponse.body, /第二个项目的私有预览内容/);
  assert.equal(protectedResponse.headers['cross-origin-resource-policy'], 'same-origin');

  // cross-origin fetch 会携带 A 的 Origin；即使测试刻意附上 B cookie，服务端仍拒绝。
  const maliciousRead = await app.inject({
    method: 'GET', url: exchange.headers.location,
    headers: { host: granted.host, cookie, origin: firstUrl.origin },
  });
  assert.equal(maliciousRead.statusCode, 404);
  assert.doesNotMatch(maliciousRead.body, /第二个项目的私有预览内容/);
  assert.equal(maliciousRead.headers['access-control-allow-origin'], undefined);
  assert.equal(maliciousRead.headers['cross-origin-resource-policy'], 'same-origin');
});

test('预览匿名访问返回 404，owner 与同课程老师只用 claim 换 cookie，再从无 claim 地址加载页面和资源', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  writeFileSync(join(paths.versions, version.id, 'index.html'), '<main>测试页面</main><script>document.body.dataset.query=location.search</script>');
  writeFileSync(join(paths.versions, version.id, 'style.css'), 'body{color:#242321}');
  activatePreview(project.id, version);
  const ownerToken = issueToken({ kind: 'skill', userId: owner.id, campId: camp.id, projectId: project.id, role: 'student' });
  const { token: teacher } = teacherToken(camp.id);
  const previewPath = `/vibehub/_preview/${version.previewId}/`;

  const anonymous = await app.inject({ method: 'GET', url: previewPath });
  assert.equal(anonymous.statusCode, 404);

  for (const token of [ownerToken, teacher]) {
    const grant = await app.inject({ method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(grant.statusCode, 200);
    assert.match(grant.json().preview_url, new RegExp(`${previewPath.replaceAll('/', '\\/')}\\?claim=`));
    assert.ok(Date.parse(grant.json().expires_at) > Date.now());

    const granted = new URL(grant.json().preview_url);
    granted.searchParams.set('theme', 'dark');
    const first = await app.inject({ method: 'GET', url: granted.pathname + granted.search, headers: { host: granted.host } });
    assert.equal(first.statusCode, 303);
    assert.equal(first.headers.location, `${previewPath}?theme=dark`);
    assert.doesNotMatch(first.body, /测试页面|location\.search|claim=/);
    assert.match(first.headers['content-security-policy'], /frame-ancestors/);
    // same-origin 会让浏览器在预览页请求同域 BaaS 时附带 Referer，
    // 同时对外域导航仍不泄露预览路径。
    assert.equal(first.headers['referrer-policy'], 'same-origin');
    const cookie = first.headers['set-cookie'].split(';', 1)[0];
    assert.doesNotMatch(first.headers['set-cookie'], /Domain=/i);
    assert.match(first.headers['set-cookie'], /HttpOnly/i);
    assert.match(first.headers['set-cookie'], /Path=\/(?:;|$)/i);
    const page = await app.inject({ method: 'GET', url: first.headers.location, headers: { host: granted.host, cookie } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /测试页面/);
    const baas = await app.inject({
      method: 'GET',
      url: '/baas/v1/messages',
      headers: {
        host: granted.host,
        referer: `${granted.origin}${first.headers.location}`,
        cookie,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(baas.statusCode, 200);
    const asset = await app.inject({ method: 'GET', url: `${previewPath}style.css`, headers: { host: granted.host, cookie } });
    assert.equal(asset.statusCode, 200);
    const emptyClaim = await app.inject({ method: 'GET', url: `${previewPath}?claim=`, headers: { host: granted.host, cookie } });
    assert.equal(emptyClaim.statusCode, 404);
    assert.doesNotMatch(emptyClaim.body, /测试页面|location\.search/);
  }
});

test('无斜杠和资源上的 claim 也只换 cookie 并 303 到同路径的干净 URL', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  writeFileSync(join(paths.versions, version.id, 'style.css'), 'body{color:#242321}');
  activatePreview(project.id, version);
  const token = issueToken({ kind: 'skill', userId: owner.id, campId: camp.id, projectId: project.id, role: 'student' });
  const grant = await app.inject({ method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${token}` } });
  const claim = previewClaimFrom(grant.json().preview_url);
  const previewHost = new URL(grant.json().preview_url).host;
  const base = `/vibehub/_preview/${version.previewId}`;

  for (const [url, location] of [
    [`${base}?view=compact&claim=${claim}`, `${base}?view=compact`],
    [`${base}/style.css?claim=${claim}&v=1`, `${base}/style.css?v=1`],
    [`${base}/?cl%61im=${claim}&encoded=1`, `${base}/?encoded=1`],
  ]) {
    const response = await app.inject({ method: 'GET', url, headers: { host: previewHost } });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, location);
    assert.doesNotMatch(response.body, /body\{color|claim=/);
  }
});

test('签发 token 被邀请码撤销后，已经换取的预览 cookie 立即失效', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const version = addVersion(student.project.id, student.user.id, 1);
  activatePreview(student.project.id, version);
  const grant = await app.inject({
    method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${student.token}` },
  });
  const granted = new URL(grant.json().preview_url);
  const exchange = await app.inject({ method: 'GET', url: granted.pathname + granted.search, headers: { host: granted.host } });
  assert.equal(exchange.statusCode, 303);
  const cookie = exchange.headers['set-cookie'].split(';', 1)[0];
  const cleanPath = exchange.headers.location;
  assert.equal((await app.inject({ method: 'GET', url: cleanPath, headers: { host: granted.host, cookie } })).statusCode, 200);

  const { token: teacher } = teacherToken(camp.id);
  const revoked = await app.inject({
    method: 'POST', url: `/api/invites/${student.code}/revoke`, headers: { authorization: `Bearer ${teacher}` },
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: cleanPath, headers: { host: granted.host, cookie } })).statusCode, 404);
  const baasAfterRevoke = await app.inject({
    method: 'GET', url: '/baas/v1/messages',
    headers: { host: granted.host, referer: `${granted.origin}${cleanPath}`, cookie },
  });
  assert.equal(baasAfterRevoke.statusCode, 400);
});

test('预览 BaaS 必须同时持有仍有效的预览 cookie，伪造 Referer 不足以授权', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const version = addVersion(student.project.id, student.user.id, 1);
  activatePreview(student.project.id, version);
  const grant = await app.inject({
    method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${student.token}` },
  });
  const granted = new URL(grant.json().preview_url);
  const cleanPath = `/vibehub/_preview/${version.previewId}/`;
  const forged = await app.inject({
    method: 'GET', url: '/baas/v1/messages',
    headers: { host: granted.host, referer: `${granted.origin}${cleanPath}` },
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(forged.json().error.code, 'unknown_project');
});

test('owner 被移出课程后，已经换取的预览 cookie 立即失效', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  activatePreview(project.id, version);
  const token = issueToken({ kind: 'skill', userId: owner.id, campId: camp.id, projectId: project.id, role: 'student' });
  const grant = await app.inject({ method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${token}` } });
  const granted = new URL(grant.json().preview_url);
  const exchange = await app.inject({ method: 'GET', url: granted.pathname + granted.search, headers: { host: granted.host } });
  const cookie = exchange.headers['set-cookie'].split(';', 1)[0];
  const cleanPath = exchange.headers.location;
  assert.equal((await app.inject({ method: 'GET', url: cleanPath, headers: { host: granted.host, cookie } })).statusCode, 200);

  db.prepare('DELETE FROM camp_members WHERE camp_id=? AND user_id=?').run(camp.id, owner.id);
  assert.equal((await app.inject({ method: 'GET', url: cleanPath, headers: { host: granted.host, cookie } })).statusCode, 404);
});

test('签发 token 过期后，已经换取的预览 cookie 立即失效', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  activatePreview(project.id, version);
  const token = issueToken({ kind: 'skill', userId: owner.id, campId: camp.id, projectId: project.id, role: 'student' });
  const grant = await app.inject({ method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${token}` } });
  const granted = new URL(grant.json().preview_url);
  const exchange = await app.inject({ method: 'GET', url: granted.pathname + granted.search, headers: { host: granted.host } });
  const cookie = exchange.headers['set-cookie'].split(';', 1)[0];
  const cleanPath = exchange.headers.location;
  assert.equal((await app.inject({ method: 'GET', url: cleanPath, headers: { host: granted.host, cookie } })).statusCode, 200);

  db.prepare('UPDATE tokens SET expires_at=? WHERE user_id=? AND project_id=?').run('2000-01-01T00:00:00.000Z', owner.id, project.id);
  assert.equal((await app.inject({ method: 'GET', url: cleanPath, headers: { host: granted.host, cookie } })).statusCode, 404);
});

test('跨项目和跨课程身份不能签发或复用预览 claim', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  activatePreview(project.id, version);

  const otherOwner = createUser(camp.id);
  const otherProject = createProject(camp.id, otherOwner.id);
  const otherToken = issueToken({ kind: 'skill', userId: otherOwner.id, campId: camp.id, projectId: otherProject.id, role: 'student' });
  const otherCamp = createCamp();
  const { token: otherTeacher } = teacherToken(otherCamp.id);

  for (const token of [otherToken, otherTeacher]) {
    const denied = await app.inject({ method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(denied.statusCode, 404);
  }

  const ownerToken = issueToken({ kind: 'skill', userId: owner.id, campId: camp.id, projectId: project.id, role: 'student' });
  const grant = await app.inject({ method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(grant.statusCode, 200);
  const otherVersion = addVersion(otherProject.id, otherOwner.id, 1);
  activatePreview(otherProject.id, otherVersion);
  const reused = await app.inject({ method: 'GET', url: `/vibehub/_preview/${otherVersion.previewId}/?claim=${previewClaimFrom(grant.json().preview_url)}`,
    headers: { host: new URL(configuredPreviewUrl(otherVersion.previewId)).host } });
  assert.equal(reused.statusCode, 404);
});

test('过期、superseded 和 rejected 的预览 claim 都返回 404', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  activatePreview(project.id, version);
  const reviewId = addReview({ versionId: version.id, projectId: project.id, campId: camp.id });
  const ownerToken = issueToken({ kind: 'skill', userId: owner.id, campId: camp.id, projectId: project.id, role: 'student' });
  const grant = await app.inject({ method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(grant.statusCode, 200);
  const claim = previewClaimFrom(grant.json().preview_url);
  const previewPath = `/vibehub/_preview/${version.previewId}/`;

  const previewHost = new URL(grant.json().preview_url).host;
  const expired = await app.inject({ method: 'GET', url: `${previewPath}?claim=${expiredPreviewClaim(claim)}`, headers: { host: previewHost } });
  assert.equal(expired.statusCode, 404);

  db.prepare("UPDATE reviews SET status='superseded' WHERE id=?").run(reviewId);
  const superseded = await app.inject({ method: 'GET', url: `${previewPath}?claim=${claim}`, headers: { host: previewHost } });
  assert.equal(superseded.statusCode, 404);

  db.prepare("UPDATE reviews SET status='rejected' WHERE id=?").run(reviewId);
  db.prepare('UPDATE projects SET pending_version_id=NULL WHERE id=?').run(project.id);
  const rejected = await app.inject({ method: 'GET', url: `${previewPath}?claim=${claim}`, headers: { host: previewHost } });
  assert.equal(rejected.statusCode, 404);
});

test('审核通过后旧预览失效，但正式作品仍公开可访问', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  activatePreview(project.id, version);
  const ownerToken = issueToken({ kind: 'skill', userId: owner.id, campId: camp.id, projectId: project.id, role: 'student' });
  const grant = await app.inject({ method: 'POST', url: `/api/previews/${version.previewId}/grant`, headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(grant.statusCode, 200);
  publishVersion({ username: owner.username, slug: project.slug, versionId: version.id });
  db.prepare("UPDATE projects SET pending_version_id=NULL,live_version_id=?,publish_status='published' WHERE id=?").run(version.id, project.id);

  const oldPreview = await app.inject({ method: 'GET', url: `/vibehub/_preview/${version.previewId}/?claim=${previewClaimFrom(grant.json().preview_url)}`,
    headers: { host: new URL(grant.json().preview_url).host } });
  assert.equal(oldPreview.statusCode, 404);
  const live = await app.inject({ method: 'GET', url: `/vibehub/${owner.username}/${project.slug}/` });
  assert.equal(live.statusCode, 200);
  assert.match(live.body, /测试页面/);
});

test('reject 的 comment 为空返回 400', async () => {
  const camp = createCamp();
  const { token } = teacherToken(camp.id);
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id);
  const version = addVersion(project.id, owner.id, 1);
  const reviewId = addReview({ versionId: version.id, projectId: project.id, campId: camp.id });
  const result = await app.inject({ method: 'POST', url: `/api/reviews/${reviewId}/reject`, headers: { authorization: `Bearer ${token}` }, payload: { comment: '' } });
  assert.equal(result.statusCode, 400);
});

test('驳回后 live_version_id 保持原值', async () => {
  const camp = createCamp();
  const { token } = teacherToken(camp.id);
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id, { publishStatus: 'published' });
  const live = addVersion(project.id, owner.id, 1);
  const pending = addVersion(project.id, owner.id, 2);
  db.prepare('UPDATE projects SET live_version_id=?, pending_version_id=? WHERE id=?').run(live.id, pending.id, project.id);
  const reviewId = addReview({ versionId: pending.id, projectId: project.id, campId: camp.id });
  const result = await app.inject({ method: 'POST', url: `/api/reviews/${reviewId}/reject`, headers: { authorization: `Bearer ${token}` }, payload: { comment: '请补充说明' } });
  assert.equal(result.statusCode, 200);
  assert.equal(db.prepare('SELECT live_version_id FROM projects WHERE id=?').get(project.id).live_version_id, live.id);
});

test('提交新版本时，同项目更早的 pending review 变 superseded', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const previous = addVersion(student.project.id, student.user.id, 1);
  const oldReview = addReview({ versionId: previous.id, projectId: student.project.id, campId: camp.id });
  db.prepare('UPDATE projects SET pending_version_id=? WHERE id=?').run(previous.id, student.project.id);
  const form = multipartUpload(bundle(), { label: 'v2.0.0' });
  const result = await app.inject({
    method: 'POST', url: '/api/skill/versions', headers: { authorization: `Bearer ${student.token}`, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.payload,
  });
  assert.equal(result.statusCode, 201);
  assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(oldReview).status, 'superseded');
});

test('公开端白名单不泄露真实姓名、诊断、审核或邀请码', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id, 'student', { displayName: '昵称', realName: '绝不公开的真实姓名' });
  const project = createProject(camp.id, owner.id, { publishStatus: 'published' });
  const version = addVersion(project.id, owner.id, 1);
  db.prepare('UPDATE projects SET live_version_id=? WHERE id=?').run(version.id, project.id);
  addReview({ versionId: version.id, projectId: project.id, campId: camp.id, status: 'approved' });
  db.prepare(`INSERT INTO diagnoses (id,version_id,status,score,policy_version,facts,items,summary,created_at,finished_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(nextId('d'), version.id, 'healthy', 100, 'test', '{}', '[]', '内部诊断', now(), now());
  const result = await app.inject({ method: 'GET', url: `/api/public/camps/${camp.slug}` });
  assert.equal(result.statusCode, 200);
  const body = JSON.stringify(result.json());
  assert.ok(!body.includes('绝不公开的真实姓名'));
  assert.ok(!body.includes('内部诊断'));
  assert.ok(!body.includes('review'));
  assert.ok(!body.includes('invite'));
});

test('公开集合将推荐作品置顶，并且只白名单返回推荐标记', async () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const first = createProject(camp.id, owner.id, { publishStatus: 'published' });
  const second = createProject(camp.id, owner.id, { publishStatus: 'published' });
  const featured = createProject(camp.id, owner.id, { publishStatus: 'published' });
  const firstVersion = addVersion(first.id, owner.id, 1);
  const secondVersion = addVersion(second.id, owner.id, 1);
  const featuredVersion = addVersion(featured.id, owner.id, 1);
  db.prepare("UPDATE projects SET live_version_id=?,collection_order=?,collection_recommended=? WHERE id=?").run(firstVersion.id, 20, 0, first.id);
  db.prepare("UPDATE projects SET live_version_id=?,collection_order=?,collection_recommended=? WHERE id=?").run(secondVersion.id, 10, 0, second.id);
  db.prepare("UPDATE projects SET live_version_id=?,collection_order=?,collection_recommended=? WHERE id=?").run(featuredVersion.id, 99, 1, featured.id);

  const result = await app.inject({ method: 'GET', url: `/api/public/camps/${camp.slug}` });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().items.map((item) => ({ slug: item.slug, featured: item.featured })), [
    { slug: featured.slug, featured: true },
    { slug: second.slug, featured: false },
    { slug: first.slug, featured: false },
  ]);
});

test('camp_only 可见性的课程，公开端返回 404', async () => {
  const camp = createCamp({ visibility: 'camp_only' });
  const result = await app.inject({ method: 'GET', url: `/api/public/camps/${camp.slug}` });
  assert.equal(result.statusCode, 404);
});

test('camp_only 可见性的课程允许本课程已登录成员访问', async () => {
  const camp = createCamp({ visibility: 'camp_only' });
  const student = await bindStudent(camp.id);
  const result = await app.inject({ method: 'GET', url: `/api/public/camps/${camp.slug}`, headers: { authorization: `Bearer ${student.token}` } });
  assert.equal(result.statusCode, 200);
});

test('诊断百分比等于适用项 earned/max，且不适用项不进分母', () => {
  const facts = { has_index: true, file_count: 1, missing_ref_count: 0, missing_refs: [], uses_sdk: false, baas_calls_total: 0, baas_calls_ok: 0, baas_records: 0, placeholder_hits: 0 };
  const result = score(facts, { previewProbe: { status: 'ok', entry_status: 200, resource_failures: [] } });
  const applicable = result.items.filter((item) => item.applicability === 'applicable');
  assert.equal(result.percent, Math.round(100 * applicable.reduce((sum, item) => sum + item.earned_points, 0) / applicable.reduce((sum, item) => sum + item.max_points, 0)));
  const backend = result.items.find((item) => item.check_key === 'baas_connected');
  assert.equal(backend.applicability, 'not_applicable');
  assert.equal(result.max, applicable.reduce((sum, item) => sum + item.max_points, 0));
});

test('基本为空的首页被诊断为 blocker，不能拿到完整预览结论', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-empty-homepage-'));
  writeFileSync(join(dir, 'index.html'), '<html><head><style>.x{display:none}</style><script>const secret = "not content";</script></head><body>  </body></html>');
  const facts = collectFacts(dir, 'no-project');
  const scored = score(facts, { previewProbe: { status: 'ok', entry_status: 200, resource_failures: [] } });
  const homepage = scored.items.find((item) => item.check_key === 'homepage_content');
  assert.ok(facts.index_visible_text_length < 30);
  assert.equal(homepage.result, 'fail');
  assert.equal(homepage.is_blocker, true);
  assert.equal(scored.blocked, true);
  assert.ok(scored.percent < 100);
  assert.notEqual(summarize(scored).summary, '已具备完整预览版本，可以提交老师审核了。');
});

test('诊断把敏感文件名或密钥内容标为 blocker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-secret-artifact-'));
  writeFileSync(join(dir, 'index.html'), '<main>这是一个有足够可见文本的作品首页，用于验证安全扫描不会漏掉敏感文件。</main>');
  writeFileSync(join(dir, '.env'), 'API_KEY=sk-example-secret');
  writeFileSync(join(dir, 'app.js'), `${'x'.repeat(300 * 1024)}\nconst leaked = 'sk-after-256kb';`);
  const facts = collectFacts(dir, 'no-project');
  const scored = score(facts, { previewProbe: { status: 'ok', entry_status: 200, resource_failures: [] } });
  const secretScan = scored.items.find((item) => item.check_key === 'secret_scan');
  assert.ok(facts.secret_findings.some((item) => item.path === 'app.js' && item.type === 'content'));
  assert.equal(secretScan.result, 'fail');
  assert.equal(secretScan.is_blocker, true);
  assert.equal(scored.blocked, true);
  assert.ok(summarize(scored).next_steps.includes('你的作品里包含了不该公开的密钥文件，请删除后重新提交'));
});

test('每个项目只保留当前正式、上一正式与当前待审三份产物', () => {
  const camp = createCamp();
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id, { publishStatus: 'published' });
  const previous = addVersion(project.id, owner.id, 1);
  const live = addVersion(project.id, owner.id, 2);
  const obsolete = addVersion(project.id, owner.id, 3);
  const pending = addVersion(project.id, owner.id, 4);
  const review1 = addReview({ versionId: previous.id, projectId: project.id, campId: camp.id, status: 'approved' });
  const review2 = addReview({ versionId: live.id, projectId: project.id, campId: camp.id, status: 'approved' });
  db.prepare('UPDATE reviews SET decided_at=? WHERE id IN (?,?)').run(now(), review1, review2);
  db.prepare('UPDATE projects SET live_version_id=?,pending_version_id=? WHERE id=?').run(live.id, pending.id, project.id);
  assert.equal(pruneProjectArtifacts(project.id).pruned, 1);
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(obsolete.id).artifact_pruned, 1);
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(previous.id).artifact_pruned, 0);
  assert.equal(projectDiskUsage(project.id).used_bytes, 96);
});

test('BaaS 文件上传同样受项目总磁盘 200MB 配额约束', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp.id);
  const live = addVersion(student.project.id, student.user.id, 1);
  db.prepare('UPDATE versions SET bundle_size=? WHERE id=?').run(LIMITS.projectDiskBytes, live.id);
  db.prepare(`UPDATE projects SET live_version_id=?,publish_status='published' WHERE id=?`).run(live.id, student.project.id);
  const form = multipartFile(Buffer.from('small file'));
  const result = await app.inject({
    method: 'POST', url: '/baas/v1/files',
    headers: { referer: worksReferer(student), 'content-type': `multipart/form-data; boundary=${form.boundary}` },
    payload: form.payload,
  });
  assert.equal(result.statusCode, 413);
  assert.equal(result.json().error.code, 'project_disk_quota_exceeded');
});

test('老师可下线恢复作品、设置可见性、排序集合并导出带审计的邀请码 CSV', async () => {
  const camp = createCamp();
  const { token } = teacherToken(camp.id);
  const owner = createUser(camp.id);
  const project = createProject(camp.id, owner.id, { publishStatus: 'published' });
  const live = addVersion(project.id, owner.id, 1);
  db.prepare('UPDATE projects SET live_version_id=? WHERE id=?').run(live.id, project.id);
  db.prepare(`INSERT INTO invites (code,camp_id,role,status,max_devices,created_at)
              VALUES ('EXPORT-0001',?,'student','unused',3,?)`).run(camp.id, now());

  const suspended = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/suspend`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(suspended.statusCode, 200);
  const publicPage = await app.inject({ method: 'GET', url: `/vibehub/${owner.username}/${project.slug}/` });
  assert.equal(publicPage.statusCode, 200);
  assert.match(publicPage.body, /暂时下线/);
  const resumed = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/resume`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(resumed.statusCode, 200);
  const visibility = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}/visibility`, headers: { authorization: `Bearer ${token}` }, payload: { visibility: 'camp_only' } });
  assert.equal(visibility.statusCode, 200);
  const collection = await app.inject({ method: 'POST', url: `/api/camps/${camp.id}/collection`, headers: { authorization: `Bearer ${token}` }, payload: { items: [{ project_id: project.id, order: 4, recommended: true }] } });
  assert.equal(collection.statusCode, 200);
  const exported = await app.inject({ method: 'GET', url: `/api/camps/${camp.id}/invites/export`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(exported.statusCode, 200);
  assert.match(exported.body, /EXPORT-0001/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='invite_export'`).get().n, 1);
});
