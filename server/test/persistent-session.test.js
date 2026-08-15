import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'vh-persistent-session-'));
process.env.VIBEHUB_DATA_DIR = dataDir;
process.env.VIBEHUB_MODEL_GATEWAY_URL = '';
process.env.VIBEHUB_PREVIEW_CLAIM_SECRET = 'persistent-session-test-secret-at-least-32-bytes';

const { buildApp } = await import('../src/index.js');
const { db, now } = await import('../src/lib/db.js');
const { issueToken, resolveToken, revokeToken } = await import('../src/lib/auth.js');
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

function createTeacher({ inviteCode = null } = {}) {
  const n = ++sequence;
  const campId = `c_persistent_${n}`;
  const userId = `u_persistent_${n}`;
  db.prepare('INSERT INTO camps (id,slug,name,created_at) VALUES (?,?,?,?)')
    .run(campId, `persistent-camp-${n}`, '长期登录测试营地', now());
  db.prepare('INSERT INTO users (id,username,display_name,real_name,created_at) VALUES (?,?,?,?,?)')
    .run(userId, `persistent-teacher-${n}`, '长期登录老师', '长期登录老师', now());
  db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
    .run(campId, userId, 'teacher', now());
  if (inviteCode) {
    db.prepare(`INSERT INTO invites
      (code,camp_id,role,status,bound_user_id,max_devices,created_at,bound_at)
      VALUES (?,?,'teacher','bound',?,3,?,?)`)
      .run(inviteCode, campId, userId, now(), now());
  }
  return { campId, userId };
}

function sessionCookie(response) {
  return response.cookies.find((item) => item.name === 'vh_session');
}

beforeEach(clearDatabase);
after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('网页登录签发长期安全 Cookie，服务端 token 没有固定到期时间', async () => {
  createTeacher({ inviteCode: 'PERSISTENT-LOGIN' });
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let login;
  try {
    login = await app.inject({ method: 'POST', url: '/api/session/redeem', payload: { code: 'PERSISTENT-LOGIN' } });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }

  assert.equal(login.statusCode, 200);
  const cookie = sessionCookie(login);
  assert.ok(cookie?.value);
  assert.equal(cookie.maxAge, 400 * 24 * 60 * 60);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(String(cookie.sameSite).toLowerCase(), 'lax');
  assert.equal(cookie.path, '/');
  assert.equal(cookie.domain, undefined);
  const stored = db.prepare(`SELECT expires_at,remembered FROM tokens WHERE invite_code=? AND kind='web'`).get('PERSISTENT-LOGIN');
  assert.equal(stored.expires_at, null);
  assert.equal(stored.remembered, 1);
});

test('取消记住我后只签发浏览器会话 Cookie，后续鉴权不会意外升级为长期 Cookie', async () => {
  createTeacher({ inviteCode: 'SESSION-ONLY-LOGIN' });
  const login = await app.inject({
    method: 'POST', url: '/api/session/redeem',
    payload: { code: 'SESSION-ONLY-LOGIN', remember_me: false },
  });

  assert.equal(login.statusCode, 200);
  const cookie = sessionCookie(login);
  assert.ok(cookie?.value);
  assert.equal(cookie.maxAge, undefined);
  assert.equal(cookie.expires, undefined);
  const stored = db.prepare(`SELECT expires_at,remembered FROM tokens WHERE invite_code=? AND kind='web'`)
    .get('SESSION-ONLY-LOGIN');
  assert.equal(stored.expires_at, null);
  assert.equal(stored.remembered, 0);

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${cookie.value}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(sessionCookie(me)?.maxAge, undefined);

  db.prepare(`UPDATE camps SET visibility_default='camp_only' WHERE id=(SELECT camp_id FROM invites WHERE code=?)`)
    .run('SESSION-ONLY-LOGIN');
  const collection = await app.inject({
    method: 'GET', url: `/api/public/camps/persistent-camp-${sequence}`,
    headers: { cookie: `vh_session=${cookie.value}` },
  });
  assert.equal(collection.statusCode, 200);
  assert.equal(sessionCookie(collection)?.maxAge, undefined);
});

test('成功的 Cookie 鉴权自动续期，Bearer 鉴权不写 Cookie', async () => {
  const teacher = createTeacher();
  const webToken = issueToken({ kind: 'web', userId: teacher.userId, campId: teacher.campId, role: 'teacher' });
  const cookieRequest = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${webToken}` } });
  assert.equal(cookieRequest.statusCode, 200);
  assert.equal(sessionCookie(cookieRequest)?.maxAge, 400 * 24 * 60 * 60);

  const bearerToken = issueToken({ kind: 'web', userId: teacher.userId, campId: teacher.campId, role: 'teacher' });
  const bearerRequest = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${bearerToken}` } });
  assert.equal(bearerRequest.statusCode, 200);
  assert.equal(sessionCookie(bearerRequest), undefined);

  const skillToken = issueToken({ kind: 'skill', userId: teacher.userId, campId: teacher.campId, role: 'teacher' });
  const skillRequest = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${skillToken}` } });
  assert.equal(skillRequest.statusCode, 200);
  assert.equal(sessionCookie(skillRequest), undefined);
});

test('仍有效的旧 12 小时会话无感升级，过期或吊销凭证不能被续期恢复', async () => {
  const teacher = createTeacher();
  const legacyToken = issueToken({
    kind: 'web', userId: teacher.userId, campId: teacher.campId, role: 'teacher',
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
  });
  const upgraded = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${legacyToken}` } });
  assert.equal(upgraded.statusCode, 200);
  assert.equal(sessionCookie(upgraded)?.maxAge, 400 * 24 * 60 * 60);
  assert.equal(db.prepare(`SELECT expires_at FROM tokens WHERE user_id=? ORDER BY created_at DESC LIMIT 1`).get(teacher.userId).expires_at, null);

  const expiredToken = issueToken({
    kind: 'web', userId: teacher.userId, campId: teacher.campId, role: 'teacher',
    expiresAt: '2000-01-01T00:00:00.000Z',
  });
  const expired = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${expiredToken}` } });
  assert.equal(expired.statusCode, 401);
  assert.equal(sessionCookie(expired), undefined);

  const revokedToken = issueToken({ kind: 'web', userId: teacher.userId, campId: teacher.campId, role: 'teacher' });
  assert.equal(revokeToken(revokedToken), true);
  const revoked = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${revokedToken}` } });
  assert.equal(revoked.statusCode, 401);
  assert.equal(sessionCookie(revoked), undefined);
});

test('仅浏览营地内部作品集合也会续期并升级旧网页会话', async () => {
  const teacher = createTeacher();
  db.prepare(`UPDATE camps SET visibility_default='camp_only' WHERE id=?`).run(teacher.campId);
  const legacyToken = issueToken({
    kind: 'web', userId: teacher.userId, campId: teacher.campId, role: 'teacher',
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
  });

  const collection = await app.inject({
    method: 'GET', url: `/api/public/camps/persistent-camp-${sequence}`,
    headers: { cookie: `vh_session=${legacyToken}` },
  });
  assert.equal(collection.statusCode, 200);
  assert.equal(sessionCookie(collection)?.maxAge, 400 * 24 * 60 * 60);
  assert.equal(db.prepare(`SELECT expires_at FROM tokens WHERE user_id=? ORDER BY created_at DESC LIMIT 1`).get(teacher.userId).expires_at, null);
});

test('退出登录与邀请码撤销会立即终止长期会话', async () => {
  const teacher = createTeacher({ inviteCode: 'PERSISTENT-REVOCABLE' });
  const firstLogin = await app.inject({ method: 'POST', url: '/api/session/redeem', payload: { code: 'PERSISTENT-REVOCABLE' } });
  const firstToken = sessionCookie(firstLogin).value;
  const logout = await app.inject({
    method: 'POST', url: '/api/session/logout',
    headers: { origin: CONSOLE_ORIGIN, cookie: `vh_session=${firstToken}` },
  });
  assert.equal(logout.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${firstToken}` } })).statusCode, 401);

  const secondLogin = await app.inject({ method: 'POST', url: '/api/session/redeem', payload: { code: 'PERSISTENT-REVOCABLE' } });
  const secondToken = sessionCookie(secondLogin).value;
  const revoked = await app.inject({
    method: 'POST', url: '/api/invites/PERSISTENT-REVOCABLE/revoke',
    headers: { origin: CONSOLE_ORIGIN, cookie: `vh_session=${secondToken}` },
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${secondToken}` } })).statusCode, 401);
});

test('同一邀请码的长期网页会话有上限，超出时只淘汰最久未用的会话', async () => {
  createTeacher({ inviteCode: 'PERSISTENT-BOUNDED' });
  const tokens = [];
  for (let index = 0; index < 12; index += 1) {
    const login = await app.inject({ method: 'POST', url: '/api/session/redeem', payload: { code: 'PERSISTENT-BOUNDED' } });
    assert.equal(login.statusCode, 200, login.body);
    tokens.push(sessionCookie(login).value);
    const identity = resolveToken(tokens.at(-1));
    const usedAt = `2000-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`;
    db.prepare('UPDATE tokens SET created_at=?,last_used_at=? WHERE id=?').run(usedAt, usedAt, identity.id);
  }

  const active = db.prepare(`SELECT COUNT(*) AS n FROM tokens
    WHERE invite_code=? AND kind='web' AND revoked_at IS NULL`).get('PERSISTENT-BOUNDED').n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tokens
    WHERE invite_code=? AND kind='web'`).get('PERSISTENT-BOUNDED').n;
  assert.equal(active, 10);
  assert.equal(total, 10);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${tokens[0]}` } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${tokens[1]}` } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `vh_session=${tokens.at(-1)}` } })).statusCode, 200);
});
