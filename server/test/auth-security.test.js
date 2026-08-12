import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'vh-auth-security-'));
process.env.VIBEHUB_DATA_DIR = dataDir;
process.env.VIBEHUB_MODEL_GATEWAY_URL = '';
process.env.VIBEHUB_PREVIEW_CLAIM_SECRET = 'auth-security-test-secret-at-least-32-bytes';

const { buildApp } = await import('../src/index.js');
const { db, now } = await import('../src/lib/db.js');
const { issueToken, countDevices } = await import('../src/lib/auth.js');
const { paths, CONSOLE_ORIGIN } = await import('../src/lib/config.js');

const app = await buildApp({ probePreview: async () => ({ status: 'ok' }) });
let sequence = 0;

function clearDatabase() {
  db.exec(`
    DELETE FROM audit_logs; DELETE FROM page_views; DELETE FROM baas_calls;
    DELETE FROM baas_files; DELETE FROM baas_counters; DELETE FROM baas_records;
    DELETE FROM diagnoses; DELETE FROM deployments; DELETE FROM reviews;
    DELETE FROM versions; DELETE FROM projects; DELETE FROM tokens;
    DELETE FROM invites; DELETE FROM camp_members; DELETE FROM users; DELETE FROM camps;
  `);
  for (const dir of Object.values(paths)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

function createCamp() {
  const id = `c_auth_${++sequence}`;
  const slug = `secure-camp-${sequence}`;
  db.prepare('INSERT INTO camps (id,slug,name,created_at) VALUES (?,?,?,?)')
    .run(id, slug, '安全测试营地', now());
  return { id, slug };
}

function teacherToken(campId) {
  const userId = `u_teacher_${++sequence}`;
  db.prepare('INSERT INTO users (id,username,display_name,created_at) VALUES (?,?,?,?)')
    .run(userId, `teacher-${sequence}`, '老师', now());
  db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
    .run(campId, userId, 'teacher', now());
  return issueToken({ kind: 'web', userId, campId, role: 'teacher' });
}

function insertInvite(campId, code, { role = 'student', maxDevices = 3 } = {}) {
  db.prepare(`INSERT INTO invites (code,camp_id,role,status,max_devices,created_at)
              VALUES (?,?,?,'unused',?,?)`).run(code, campId, role, maxDevices, now());
}

beforeEach(clearDatabase);
after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('新邀请码使用至少 10 位不易混淆的随机段，旧四位邀请码仍可兑换', async () => {
  const camp = createCamp();
  const teacher = teacherToken(camp.id);
  const generated = await app.inject({
    method: 'POST', url: `/api/camps/${camp.id}/invites`,
    headers: { authorization: `Bearer ${teacher}` }, payload: { count: 20 },
  });
  assert.equal(generated.statusCode, 201);
  const codes = generated.json().codes;
  assert.equal(new Set(codes).size, 20);
  for (const code of codes) assert.match(code, /^[A-Z]+-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);

  insertInvite(camp.id, 'LEGACY-ABCD');
  const legacy = await app.inject({
    method: 'POST', url: '/api/skill/bind', payload: { code: 'LEGACY-ABCD', device_name: '旧设备' },
  });
  assert.equal(legacy.statusCode, 200);
});

test('网页登录不占 Skill 设备名额，退出时吊销当前网页会话', async () => {
  const camp = createCamp();
  insertInvite(camp.id, 'WEB-LOGIN-SECURE', { maxDevices: 1 });

  for (let i = 0; i < 4; i++) {
    const login = await app.inject({
      method: 'POST', url: '/api/session/redeem', headers: { 'x-forwarded-for': '198.51.100.20' }, payload: { code: 'WEB-LOGIN-SECURE' },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(countDevices('WEB-LOGIN-SECURE'), 0);
    const cookie = login.cookies.find((item) => item.name === 'vh_session');
    assert.ok(cookie?.value);
    const logout = await app.inject({
      method: 'POST', url: '/api/session/logout',
      headers: { origin: CONSOLE_ORIGIN, cookie: `vh_session=${cookie.value}` },
    });
    assert.equal(logout.statusCode, 200);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE kind='web' AND revoked_at IS NULL`).get().n, 0);
  }

  const skill = await app.inject({
    method: 'POST', url: '/api/skill/bind', headers: { 'x-forwarded-for': '198.51.100.20' }, payload: { code: 'WEB-LOGIN-SECURE', device_name: 'Mac' },
  });
  assert.equal(skill.statusCode, 200);
  assert.equal(countDevices('WEB-LOGIN-SECURE'), 1);
  const secondSkill = await app.inject({
    method: 'POST', url: '/api/skill/bind', headers: { 'x-forwarded-for': '198.51.100.20' }, payload: { code: 'WEB-LOGIN-SECURE', device_name: 'Windows' },
  });
  assert.equal(secondSkill.statusCode, 403);
});

test('错误兑换在 Skill 与网页登录之间共享来源限速，且限速响应不暴露邀请码状态', async () => {
  const camp = createCamp();
  insertInvite(camp.id, 'TEACHER-VERY-SECRET', { role: 'teacher' });

  for (let i = 0; i < 10; i++) {
    const path = i % 2 ? '/api/session/redeem' : '/api/skill/bind';
    const result = await app.inject({ method: 'POST', url: path, headers: { 'x-forwarded-for': '198.51.100.30' }, payload: { code: `WRONG-${i}` } });
    assert.equal(result.statusCode, 404);
  }
  const blocked = await app.inject({
    method: 'POST', url: '/api/skill/bind', payload: { code: 'TEACHER-VERY-SECRET', device_name: '攻击者' },
    headers: { 'x-forwarded-for': '198.51.100.30' },
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'invite_rate_limited');
  assert.doesNotMatch(JSON.stringify(blocked.json()), /teacher|存在|有效/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n, 0);

  const otherSource = await app.inject({
    method: 'POST', url: '/api/skill/bind',
    headers: { 'x-forwarded-for': '203.0.113.8' },
    payload: { code: 'ANOTHER-WRONG-CODE' },
  });
  assert.equal(otherSource.statusCode, 404);
});
