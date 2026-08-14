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
    method: 'POST', url: '/api/skill/bind', payload: { code: 'LEGACY-ABCD', device_name: '旧设备', real_name: '旧版学员', display_name: '旧版创作者' },
  });
  assert.equal(legacy.statusCode, 200);
});

test('网页登录不占 Skill 设备名额，退出时吊销当前网页会话', async () => {
  const camp = createCamp();
  insertInvite(camp.id, 'WEB-LOGIN-SECURE', { maxDevices: 1 });

  for (let i = 0; i < 4; i++) {
    const login = await app.inject({
      method: 'POST', url: '/api/session/redeem', headers: { 'x-forwarded-for': '198.51.100.20' }, payload: i === 0 ? { code: 'WEB-LOGIN-SECURE', real_name: '网页登录学员', display_name: '网页创作者' } : { code: 'WEB-LOGIN-SECURE' },
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

test('事务内重查可阻止撤销与兑换竞态重新激活邀请码', async () => {
  const camp = createCamp();
  insertInvite(camp.id, 'RACE-REVOKED-CODE');
  const originalPrepare = db.prepare.bind(db);
  let revokedDuringBegin = false;
  const originalExec = db.exec.bind(db);
  db.exec = (sql) => {
    const result = originalExec(sql);
    if (sql === 'BEGIN IMMEDIATE' && !revokedDuringBegin) {
      revokedDuringBegin = true;
      originalPrepare(`UPDATE invites SET status='revoked', revoked_at=? WHERE code=?`)
        .run(now(), 'RACE-REVOKED-CODE');
    }
    return result;
  };
  try {
    const result = await app.inject({
      method: 'POST', url: '/api/skill/bind', payload: { code: 'RACE-REVOKED-CODE', device_name: '竞态设备' },
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().error.code, 'invite_revoked');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n, 0);
  } finally {
    db.exec = originalExec;
  }
});

test('学生邀请码可先补名或预分配姓名，且不匹配时不创建账号', async () => {
  const camp = createCamp();
  insertInvite(camp.id, 'PROFILE-SELF-FILL');

  const required = await app.inject({ method: 'POST', url: '/api/session/redeem', payload: { code: 'PROFILE-SELF-FILL' } });
  assert.equal(required.statusCode, 409);
  assert.equal(required.json().error.code, 'profile_required');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);

  const filled = await app.inject({
    method: 'POST', url: '/api/session/redeem',
    payload: { code: 'PROFILE-SELF-FILL', real_name: '自填学员', display_name: '公开昵称' },
  });
  assert.equal(filled.statusCode, 200);
  const cookie = filled.cookies.find((item) => item.name === 'vh_session');
  assert.ok(cookie?.value);
  const roster = db.prepare('SELECT * FROM camp_roster WHERE camp_id=?').get(camp.id);
  assert.equal(roster.real_name, '自填学员');
  assert.equal(roster.verification_status, 'self_reported');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${cookie.value}` } });
  assert.equal(me.json().user.real_name, '自填学员');
  assert.equal(me.json().user.display_name, '公开昵称');
  assert.equal(me.json().profile.verification_status, 'self_reported');

  insertInvite(camp.id, 'PROFILE-PREASSIGNED');
  const { importRosterEntries } = await import('../src/services/student-identity.js');
  importRosterEntries({ campId: camp.id, actorUserId: null, entries: [{ code: 'PROFILE-PREASSIGNED', real_name: '预分配学员', display_name: '预设昵称' }] });
  const mismatch = await app.inject({
    method: 'POST', url: '/api/skill/bind',
    payload: { code: 'PROFILE-PREASSIGNED', device_name: 'Mac', real_name: '其他人' },
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().error.code, 'profile_mismatch');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE real_name='预分配学员'`).get().n, 0);

  const matched = await app.inject({
    method: 'POST', url: '/api/skill/bind',
    payload: { code: 'PROFILE-PREASSIGNED', device_name: 'Mac', real_name: ' 预分配学员 ' },
  });
  assert.equal(matched.statusCode, 200);
  assert.equal(matched.json().user.real_name, '预分配学员');
  assert.equal(matched.json().user.display_name, '预设昵称');
});

test('学员可改昵称，自填姓名确认前可修正，老师确认后姓名锁定', async () => {
  const camp = createCamp();
  insertInvite(camp.id, 'PROFILE-EDIT');
  const login = await app.inject({ method: 'POST', url: '/api/session/redeem', payload: { code: 'PROFILE-EDIT', real_name: '初始姓名', display_name: '初始昵称' } });
  const cookie = login.cookies.find((item) => item.name === 'vh_session');
  const headers = { cookie: `vh_session=${cookie.value}`, origin: CONSOLE_ORIGIN };
  const changed = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers, payload: { real_name: '修正姓名', display_name: '新昵称' } });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().user.real_name, '修正姓名');
  assert.equal(changed.json().user.display_name, '新昵称');

  db.prepare(`UPDATE camp_roster SET verification_status='verified' WHERE user_id=?`).run(changed.json().user.id);
  const locked = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers, payload: { real_name: '再次修改' } });
  assert.equal(locked.statusCode, 409);
  assert.equal(locked.json().error.code, 'real_name_locked');
});
