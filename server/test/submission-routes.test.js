import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const dataDir = mkdtempSync(join(tmpdir(), 'vh-submission-routes-'));
process.env.VIBEHUB_DATA_DIR = dataDir;
process.env.VIBEHUB_MODEL_GATEWAY_URL = '';
process.env.VIBEHUB_PREVIEW_CLAIM_SECRET = 'submission-route-preview-secret-32-bytes';

const { buildApp } = await import('../src/index.js');
const { db, now } = await import('../src/lib/db.js');
const { issueToken } = await import('../src/lib/auth.js');
const { CONSOLE_ORIGIN, LIMITS, paths } = await import('../src/lib/config.js');

const app = await buildApp({
  probePreview: async () => ({ status: 'ok', entry_status: 200, resource_failures: [], checked_at: now() }),
});
let sequence = 0;

async function waitForDiagnoses() {
  for (let i = 0; i < 100; i += 1) {
    if (db.prepare("SELECT COUNT(*) AS n FROM diagnoses WHERE status='running'").get().n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('异步诊断没有在测试清理前结束');
}

async function clearState() {
  await waitForDiagnoses();
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

function fixture({ role = 'student', withProject = true } = {}) {
  sequence += 1;
  const campId = `c_browser_${sequence}`;
  const userId = `u_browser_${sequence}`;
  const projectId = withProject ? `p_browser_${sequence}` : null;
  db.prepare('INSERT INTO camps (id,slug,name,created_at) VALUES (?,?,?,?)')
    .run(campId, `browser-${sequence}`, '网页提交测试营地', now());
  db.prepare('INSERT INTO users (id,username,display_name,created_at) VALUES (?,?,?,?)')
    .run(userId, `browser-user-${sequence}`, '网页提交者', now());
  db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
    .run(campId, userId, role, now());
  if (projectId) {
    db.prepare(`INSERT INTO projects (id,camp_id,owner_user_id,slug,title,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(projectId, campId, userId, `browser-work-${sequence}`, '网页作品', now(), now());
  }
  const token = issueToken({ kind: 'web', userId, campId, projectId, role });
  return {
    campId,
    userId,
    projectId,
    token,
    headers: { cookie: `vh_session=${token}`, origin: CONSOLE_ORIGIN },
  };
}

function multipart(parts, boundary = `----vibehub-browser-${Date.now()}-${sequence}`) {
  const chunks = [];
  for (const part of parts) {
    if (part.kind === 'file') {
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name || 'bundle'}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType || 'application/octet-stream'}\r\n\r\n`),
        Buffer.from(part.content),
        Buffer.from('\r\n'),
      );
    } else {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, payload: Buffer.concat(chunks) };
}

function htmlForm(content, meta = {}, filename = '原始作品.HTML') {
  return multipart([
    { kind: 'field', name: 'meta', value: JSON.stringify(meta) },
    { kind: 'file', filename, contentType: 'text/html', content },
  ]);
}

function submit(projectId, headers, form) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/versions`,
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${form.boundary}` },
    payload: form.payload,
  });
}

beforeEach(clearState);
after(async () => {
  await waitForDiagnoses();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('学员 cookie 可向自己的项目提交 HTML，保留共享字段并记录 web 来源', async () => {
  const student = fixture();
  const response = await submit(student.projectId, student.headers, htmlForm(
    '<main>这是一个内容完整、可以从网页提交的 HTML 游戏作品。</main>',
    { summary: ' 第一版 ', flows: [' 开始游戏 '] },
  ));

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), [
    'deployment', 'diagnosis', 'label', 'message', 'preview_expires_at', 'preview_url',
    'review', 'rewrites', 'seq', 'version_id',
  ]);
  assert.equal(body.deployment.status, 'ready');
  assert.equal(body.diagnosis.status, 'running');
  assert.equal(body.review.status, 'waiting_for_diagnosis');
  const row = db.prepare('SELECT submitted_via,summary,flows FROM versions WHERE id=?').get(body.version_id);
  assert.equal(row.submitted_via, 'web');
  assert.equal(row.summary, '第一版');
  assert.equal(row.flows, JSON.stringify(['开始游戏']));

  const granted = new URL(body.preview_url);
  const claim = granted.searchParams.get('claim');
  assert.ok(claim);
  assert.doesNotMatch(
    db.prepare('SELECT url FROM deployments WHERE version_id=?').get(body.version_id).url,
    /claim/i,
  );
  assert.doesNotMatch(JSON.stringify({ ...body, preview_url: '[private preview grant]' }), new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('网页可提交 ZIP 且服务端按原始文件名和文件头识别', async () => {
  const student = fixture();
  const archive = zipSync({
    'index.html': strToU8('<main>这是一个内容完整、含静态资源的 ZIP 网页作品。</main>'),
    'assets/site.css': strToU8('main { color: navy; }'),
  });
  const form = multipart([
    { kind: 'field', name: 'meta', value: '{}' },
    { kind: 'file', filename: '我的作品.zip', contentType: 'application/zip', content: archive },
  ]);

  const response = await submit(student.projectId, student.headers, form);

  assert.equal(response.statusCode, 201);
  assert.equal(db.prepare('SELECT file_count,submitted_via FROM versions WHERE id=?').get(response.json().version_id).file_count, 2);
});

test('跨项目、跨课程和未绑定项目都统一返回 404，不暴露项目存在性', async () => {
  const student = fixture();
  const sameCampOwner = fixture();
  db.prepare('UPDATE projects SET camp_id=? WHERE id=?').run(student.campId, sameCampOwner.projectId);
  const noProject = fixture({ withProject: false });

  for (const [actor, projectId] of [
    [student, sameCampOwner.projectId],
    [student, 'p_does_not_exist'],
    [noProject, student.projectId],
  ]) {
    const response = await submit(projectId, actor.headers, htmlForm('<main>不应落库</main>'));
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'not_found');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 0);
});

test('无身份返回 401，teacher 即使同课程也返回 404', async () => {
  const student = fixture();
  const teacher = fixture({ role: 'teacher', withProject: false });
  const form = htmlForm('<main>不应落库</main>');

  const anonymous = await submit(student.projectId, { origin: CONSOLE_ORIGIN }, form);
  const teacherResponse = await submit(student.projectId, teacher.headers, form);

  assert.equal(anonymous.statusCode, 401);
  assert.equal(teacherResponse.statusCode, 404);
  assert.equal(teacherResponse.json().error.code, 'not_found');
});

test('cookie 网页写请求必须来自控制台 Origin', async () => {
  const student = fixture();
  const response = await submit(student.projectId, {
    cookie: `vh_session=${student.token}`,
    origin: 'https://evil.example',
  }, htmlForm('<main>不应落库</main>'));

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'csrf_origin_invalid');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 0);
});

test('缺少 bundle 和重复 bundle 都返回明确错误并清理临时文件', async () => {
  const student = fixture();
  const missing = multipart([{ kind: 'field', name: 'meta', value: '{}' }]);
  const multiple = multipart([
    { kind: 'file', filename: 'first.html', content: '<main>first</main>' },
    { kind: 'file', filename: 'second.html', content: '<main>second</main>' },
  ]);

  const missingResponse = await submit(student.projectId, student.headers, missing);
  assert.equal(missingResponse.statusCode, 400);
  assert.equal(missingResponse.json().error.code, 'missing_bundle');
  const multipleResponse = await submit(student.projectId, student.headers, multiple);
  assert.equal(multipleResponse.statusCode, 400);
  assert.equal(multipleResponse.json().error.code, 'multiple_bundles');
  assert.deepEqual(readdirSync(paths.tmp), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 0);
});

test('超出上传上限的 bundle 返回 413 并清理截断文件', async () => {
  const student = fixture();
  const response = await submit(student.projectId, student.headers, htmlForm(
    Buffer.alloc(LIMITS.bundleBytes + 1, 0x61),
    {},
    'oversized.html',
  ));

  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'bundle_too_large');
  assert.deepEqual(readdirSync(paths.tmp), []);
});

test('非法 meta JSON 和 schema 返回 invalid_meta，解析垃圾不消耗提交次数', async () => {
  const student = fixture();
  const malformed = multipart([
    { kind: 'field', name: 'meta', value: '{not-json' },
    { kind: 'file', filename: 'work.html', content: '<main>内容</main>' },
  ]);
  const wrongSchema = htmlForm('<main>内容</main>', { flows: '不是数组' });

  for (let i = 0; i < 5; i += 1) {
    const response = await submit(student.projectId, student.headers, malformed);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_meta');
  }
  const schemaResponse = await submit(student.projectId, student.headers, wrongSchema);
  assert.equal(schemaResponse.statusCode, 400);
  assert.equal(schemaResponse.json().error.code, 'invalid_meta');
  const valid = await submit(student.projectId, student.headers, htmlForm(
    '<main>垃圾请求之后仍然可以提交的完整网页作品。</main>',
  ));
  assert.equal(valid.statusCode, 201);
});

test('同项目并发返回 409，release 幂等且释放后在频率未满时可提交', async () => {
  const student = fixture();
  const { browserSubmissionGuard } = await import('../src/services/submission-guard.js');
  const held = browserSubmissionGuard.acquire(student.projectId);
  assert.equal(held.ok, true);

  const busy = await submit(student.projectId, student.headers, htmlForm('<main>并发提交</main>'));
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().error.code, 'submission_in_progress');
  held.release();
  held.release();
  const accepted = await submit(student.projectId, student.headers, htmlForm(
    '<main>释放锁之后可以提交的完整网页作品。</main>',
  ));
  assert.equal(accepted.statusCode, 201);
});

test('网页合法提交 10 分钟最多 5 次，第 6 次返回可重试提示', async () => {
  const student = fixture();
  for (let i = 0; i < 5; i += 1) {
    const response = await submit(student.projectId, student.headers, htmlForm(
      `<main>这是第 ${i + 1} 个内容不同、可正常诊断的网页提交版本。</main>`,
    ));
    assert.equal(response.statusCode, 201);
  }

  const limited = await submit(student.projectId, student.headers, htmlForm('<main>第六次提交</main>'));
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'submission_rate_limited');
  assert.match(limited.json().error.message, /10 分钟/);
  assert.ok(limited.json().error.retry_after_seconds > 0);
});
