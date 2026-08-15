import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = mkdtempSync(join(tmpdir(), 'vh-student-project-creation-'));
process.env.VIBEHUB_DATA_DIR = dataDir;
process.env.VIBEHUB_MODEL_GATEWAY_URL = '';
process.env.VIBEHUB_PREVIEW_CLAIM_SECRET = 'student-project-test-secret-at-least-32-bytes';

const { buildApp } = await import('../src/index.js');
const { db, now } = await import('../src/lib/db.js');
const { countDevices, issueToken, resolveToken, revokeInviteAndTokens, revokeToken } = await import('../src/lib/auth.js');
const { paths, CONSOLE_ORIGIN } = await import('../src/lib/config.js');
const { createStudentProject, StudentProjectCreationError } = await import('../src/services/student-project-creation.js');

const app = await buildApp({ probePreview: async () => ({ status: 'ok' }) });
let sequence = 0;

function clearDatabase() {
  db.exec(`
    DELETE FROM audit_logs; DELETE FROM page_views; DELETE FROM baas_calls;
    DELETE FROM baas_files; DELETE FROM baas_counters; DELETE FROM baas_records;
    DELETE FROM diagnoses; DELETE FROM deployments; DELETE FROM reviews;
    DELETE FROM versions; DELETE FROM projects; DELETE FROM tokens;
    DELETE FROM invites; DELETE FROM camp_roster; DELETE FROM camp_members;
    DELETE FROM users; DELETE FROM camps;
  `);
  for (const dir of Object.values(paths)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

function createCamp(name = '多项目测试营') {
  const id = `c_multi_${++sequence}`;
  const slug = `multi-camp-${sequence}`;
  db.prepare('INSERT INTO camps (id,slug,name,created_at) VALUES (?,?,?,?)').run(id, slug, name, now());
  return { id, slug, name };
}

async function bindStudent(camp, { code = `MULTI-${++sequence}`, kind = 'skill' } = {}) {
  db.prepare(`INSERT INTO invites (code,camp_id,role,status,max_devices,created_at)
              VALUES (?,?,'student','unused',3,?)`).run(code, camp.id, now());
  const payload = { code, real_name: `学员${sequence}`, display_name: `创作者${sequence}` };
  const response = await app.inject(kind === 'skill'
    ? { method: 'POST', url: '/api/skill/bind', payload: { ...payload, device_name: '测试电脑' } }
    : { method: 'POST', url: '/api/session/redeem', payload });
  assert.equal(response.statusCode, 200, response.body);
  return { code, response, ...response.json() };
}

async function createProject(token, title, requestId, extra = {}) {
  return app.inject({
    method: 'POST', url: '/api/skill/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: { title, request_id: requestId, ...extra },
  });
}

function uploadBundle(marker) {
  const source = mkdtempSync(join(tmpdir(), 'vh-multi-project-bundle-'));
  const archiveDir = mkdtempSync(join(tmpdir(), 'vh-multi-project-archive-'));
  const archive = join(archiveDir, 'bundle.tgz');
  writeFileSync(join(source, 'index.html'), `<main>${marker}：这是用于验证多项目上传隔离的完整网页内容。</main>`);
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  return readFileSync(archive);
}

function multipartUpload(content, summary) {
  const boundary = `----vibehub-multi-${++sequence}`;
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify({ summary })}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.tgz"\r\nContent-Type: application/gzip\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function deploy(token, marker) {
  const upload = multipartUpload(uploadBundle(marker), marker);
  return app.inject({
    method: 'POST', url: '/api/skill/versions',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${upload.boundary}` },
    payload: upload.payload,
  });
}

beforeEach(clearDatabase);
after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('学生 Skill 凭证可创建同营地独立项目并得到只作用于新项目的派生凭证', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  const rootIdentity = resolveToken(student.token);

  const response = await createProject(student.token, ' 第二个作品 ', 'pc_request-create-0001');

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json().project.title, '第二个作品');
  assert.equal(response.json().camp.id, camp.id);
  assert.notEqual(response.json().project.id, student.project.id);
  assert.match(response.json().token, /^vhk_/);

  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(response.json().project.id);
  assert.equal(project.owner_user_id, student.user.id);
  assert.equal(project.camp_id, camp.id);
  assert.equal(project.creation_request_id, 'pc_request-create-0001');

  const childIdentity = resolveToken(response.json().token);
  assert.equal(childIdentity.project_id, project.id);
  assert.equal(childIdentity.user_id, student.user.id);
  assert.equal(childIdentity.camp_id, camp.id);
  assert.equal(childIdentity.invite_code, student.code);
  assert.equal(childIdentity.derived_from_token_id, rootIdentity.id);
  assert.equal(resolveToken(student.token).project_id, student.project.id);
  assert.equal(countDevices(student.code), 1);

  const childStatus = await app.inject({
    method: 'GET', url: '/api/skill/project', headers: { authorization: `Bearer ${response.json().token}` },
  });
  assert.equal(childStatus.statusCode, 200);
  assert.equal(childStatus.json().project.id, project.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='student_project_create' AND target_id=?`).get(project.id).n, 1);
});

test('相同 request_id 仅保留一枚有效凭证，且高频重签受限', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);

  const rootIdentity = resolveToken(student.token);
  const first = await createProject(student.token, '网络重试作品', 'pc_request-idempotent-0001');
  const unrelatedParentToken = issueToken({
    kind: 'skill', userId: student.user.id, campId: camp.id, projectId: student.project.id,
    role: 'student', inviteCode: student.code, derivedFromTokenId: rootIdentity.id, deviceName: '旧连接父节点',
  });
  const unrelatedParent = resolveToken(unrelatedParentToken);
  issueToken({
    kind: 'skill', userId: student.user.id, campId: camp.id, projectId: first.json().project.id,
    role: 'student', inviteCode: student.code, derivedFromTokenId: unrelatedParent.id, deviceName: '旧连接',
  });
  db.prepare(`UPDATE tokens SET created_at='1999-01-01T00:00:00.000Z'
    WHERE derived_from_token_id=? AND project_id=?`).run(unrelatedParent.id, first.json().project.id);
  const retried = await createProject(student.token, '被忽略的新标题', 'pc_request-idempotent-0001');
  const wrongParent = await createProject(retried.json().token, '不能换授权凭证', 'pc_request-idempotent-0001');
  const throttled = await createProject(student.token, '不应再签发', 'pc_request-idempotent-0001');

  assert.equal(first.statusCode, 201, first.body);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().project.id, first.json().project.id);
  assert.equal(retried.json().project.title, '网络重试作品');
  assert.notEqual(retried.json().token, first.json().token);
  assert.equal(wrongParent.statusCode, 404, wrongParent.body);
  assert.equal(throttled.statusCode, 429, throttled.body);
  assert.equal(throttled.json().error.code, 'project_reconnect_rate_limited');
  assert.equal(resolveToken(first.json().token), null);
  assert.equal(resolveToken(retried.json().token).project_id, first.json().project.id);
  db.prepare(`UPDATE tokens SET last_used_at='2000-01-01T00:00:00.000Z'
    WHERE derived_from_token_id=? AND project_id=?`).run(rootIdentity.id, first.json().project.id);
  const recoveredLater = await createProject(student.token, '限流窗口后恢复', 'pc_request-idempotent-0001');
  assert.equal(recoveredLater.statusCode, 200, recoveredLater.body);
  assert.equal(resolveToken(retried.json().token), null);
  assert.equal(resolveToken(recoveredLater.json().token).project_id, first.json().project.id);
  const tokenStats = db.prepare(`SELECT COUNT(*) AS rows,
    SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active
    FROM tokens WHERE derived_from_token_id=? AND project_id=?`)
    .get(rootIdentity.id, first.json().project.id);
  assert.equal(tokenStats.rows, 1);
  assert.equal(tokenStats.active, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_user_id=?').get(student.user.id).n, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='student_project_create'`).get().n, 1);
  assert.equal(countDevices(student.code), 1);
});

test('项目创建入口拒绝网页会话、老师和与当前项目不一致的伪造学生凭证', async () => {
  const camp = createCamp();
  const webStudent = await bindStudent(camp, { kind: 'web' });
  const cookie = webStudent.response.cookies.find((item) => item.name === 'vh_session');
  const webAttempt = await app.inject({
    method: 'POST', url: '/api/skill/projects',
    headers: { origin: CONSOLE_ORIGIN, cookie: `vh_session=${cookie.value}` },
    payload: { title: '网页绕过', request_id: 'pc_request-web-0001' },
  });
  assert.equal(webAttempt.statusCode, 404);

  const teacherId = `u_teacher_${++sequence}`;
  db.prepare('INSERT INTO users (id,username,display_name,created_at) VALUES (?,?,?,?)')
    .run(teacherId, `teacher-${sequence}`, '老师', now());
  db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
    .run(camp.id, teacherId, 'teacher', now());
  const teacherToken = issueToken({ kind: 'skill', userId: teacherId, campId: camp.id, role: 'teacher' });
  const teacherAttempt = await createProject(teacherToken, '老师伪装作品', 'pc_request-teacher-0001');
  assert.equal(teacherAttempt.statusCode, 404);

  const otherCamp = createCamp('其他营地');
  const otherStudent = await bindStudent(otherCamp);
  const forged = issueToken({
    kind: 'skill', userId: webStudent.user.id, campId: camp.id, projectId: otherStudent.project.id,
    role: 'student', inviteCode: webStudent.code, deviceName: '伪造设备',
  });
  const forgedAttempt = await createProject(forged, '跨营作品', 'pc_request-forged-0001');
  assert.equal(forgedAttempt.statusCode, 404);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE title IN ('网页绕过','老师伪装作品','跨营作品')`).get().n, 0);
});

test('创建参数无效时不产生项目或凭证', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  const beforeTokens = db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n;
  for (const payload of [
    { title: '   ', request_id: 'pc_request-invalid-0001' },
    { title: 'x'.repeat(81), request_id: 'pc_request-invalid-0002' },
    { title: '作品', request_id: 'request-without-prefix-0001' },
    { title: '作品', request_id: 'pc_short' },
    { title: '作品' },
  ]) {
    const response = await app.inject({
      method: 'POST', url: '/api/skill/projects',
      headers: { authorization: `Bearer ${student.token}` }, payload,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_user_id=?').get(student.user.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n, beforeTokens);
});

test('创建入口拒绝客户端自报归属字段且不产生项目', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  const beforeProjects = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const beforeTokens = db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n;
  const response = await createProject(student.token, '伪造作品', 'pc_request-forged-fields-0001', {
    owner_user_id: 'u_forged', camp_id: 'c_forged', project_id: 'p_forged', slug: 'forged-slug',
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.code, 'invalid_project_fields');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, beforeProjects);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n, beforeTokens);
});

test('作品名称拒绝可能污染终端输出的控制字符', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  for (const title of ['正常标题\n伪造下一行', '正常标题\u001b[31m']) {
    const response = await createProject(student.token, title, `pc_request-control-${Buffer.from(title).toString('hex')}`);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'invalid_project_title');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_user_id=?').get(student.user.id).n, 1);
});

test('每名学生每分钟最多新建五个项目，一次幂等恢复先于新建限流', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  let first;
  for (let i = 0; i < 5; i += 1) {
    const response = await createProject(student.token, `作品 ${i + 1}`, `pc_request-rate-limit-000${i}`);
    assert.equal(response.statusCode, 201, response.body);
    if (i === 0) first = response;
  }
  const retry = await createProject(student.token, '重试不改标题', 'pc_request-rate-limit-0000');
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().project.id, first.json().project.id);

  const blocked = await createProject(student.token, '第六个作品', 'pc_request-rate-limit-0005');
  assert.equal(blocked.statusCode, 429, blocked.body);
  assert.equal(blocked.json().error.code, 'project_create_rate_limited');
  assert.equal(blocked.headers['retry-after'], '60');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_user_id=?').get(student.user.id).n, 6);
});

test('撤销初始邀请码会同时吊销所有派生项目凭证且派生凭证不占设备名额', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  const second = await createProject(student.token, '第二个作品', 'pc_request-revoke-0001');
  const third = await createProject(second.json().token, '第三个作品', 'pc_request-revoke-0002');
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(third.statusCode, 201, third.body);
  assert.equal(countDevices(student.code), 1);

  const revoked = revokeInviteAndTokens(student.code);
  assert.equal(revoked, 3);
  assert.equal(resolveToken(student.token), null);
  assert.equal(resolveToken(second.json().token), null);
  assert.equal(resolveToken(third.json().token), null);
});

test('单独撤销根 token 会在同一事务中级联撤销 child 和 grandchild', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  const child = await createProject(student.token, '子作品', 'pc_request-token-tree-0001');
  const grandchild = await createProject(child.json().token, '孙作品', 'pc_request-token-tree-0002');
  assert.equal(child.statusCode, 201, child.body);
  assert.equal(grandchild.statusCode, 201, grandchild.body);

  assert.equal(revokeToken(student.token), true);
  assert.equal(resolveToken(student.token), null);
  assert.equal(resolveToken(child.json().token), null);
  assert.equal(resolveToken(grandchild.json().token), null);
  assert.equal(db.prepare('SELECT status FROM invites WHERE code=?').get(student.code).status, 'bound');
});

test('派生树撤销中途失败时会回滚根与子 token 状态', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  const child = await createProject(student.token, '子作品', 'pc_request-token-rollback-0001');
  const childId = resolveToken(child.json().token).id;
  db.exec(`CREATE TEMP TRIGGER fail_child_token_revoke
    BEFORE UPDATE OF revoked_at ON tokens WHEN OLD.id='${childId}'
    BEGIN SELECT RAISE(ABORT, 'forced child revoke failure'); END`);
  try {
    assert.throws(() => revokeToken(student.token), /forced child revoke failure/);
    assert.notEqual(resolveToken(student.token), null);
    assert.notEqual(resolveToken(child.json().token), null);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_child_token_revoke');
  }
});

test('鉴权后若初始邀请码已被并发撤销也不能签发新的派生凭证', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  const staleIdentity = resolveToken(student.token);
  revokeInviteAndTokens(student.code);

  assert.throws(
    () => createStudentProject(staleIdentity, { title: '撤销后的作品', request_id: 'pc_request-revoked-race-0001' }),
    (error) => error instanceof StudentProjectCreationError && error.code === 'not_found',
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE title='撤销后的作品'`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE derived_from_token_id=?`).get(staleIdentity.id).n, 0);
});

test('A 与 B 的项目凭证上传版本后只更新各自项目', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  const second = await createProject(student.token, '作品 B', 'pc_request-upload-scope-0001');
  assert.equal(second.statusCode, 201, second.body);

  const uploadA = await deploy(student.token, '只属于 A');
  const uploadB = await deploy(second.json().token, '只属于 B');
  assert.equal(uploadA.statusCode, 201, uploadA.body);
  assert.equal(uploadB.statusCode, 201, uploadB.body);
  const versionA = db.prepare('SELECT project_id,summary FROM versions WHERE id=?').get(uploadA.json().version_id);
  const versionB = db.prepare('SELECT project_id,summary FROM versions WHERE id=?').get(uploadB.json().version_id);
  assert.equal(versionA.project_id, student.project.id);
  assert.equal(versionA.summary, '只属于 A');
  assert.equal(versionB.project_id, second.json().project.id);
  assert.equal(versionB.summary, '只属于 B');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id=?').get(student.project.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id=?').get(second.json().project.id).n, 1);
});

test('派生凭证签发失败时回滚项目和审计且不向客户端泄露底层错误', async () => {
  const camp = createCamp();
  const student = await bindStudent(camp);
  db.exec(`CREATE TRIGGER reject_derived_project_token
    BEFORE INSERT ON tokens WHEN NEW.derived_from_token_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'sensitive-derived-token-failure'); END`);
  try {
    const response = await createProject(student.token, '必须回滚的作品', 'pc_request-rollback-0001');
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().error.code, 'project_create_failed');
    assert.doesNotMatch(response.body, /sensitive-derived-token-failure/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE title='必须回滚的作品'`).get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='student_project_create'`).get().n, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_derived_project_token');
  }
});
