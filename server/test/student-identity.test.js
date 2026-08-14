import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'vh-student-identity-'));
process.env.VIBEHUB_DATA_DIR = dataDir;

const { db, now } = await import('../src/lib/db.js');
const {
  IdentityError,
  importRosterEntries,
  normalizeStudentName,
  updateRosterEntry,
} = await import('../src/services/student-identity.js');

function reset() {
  db.exec(`
    DELETE FROM audit_logs; DELETE FROM projects; DELETE FROM tokens; DELETE FROM invites;
    DELETE FROM camp_members; DELETE FROM users; DELETE FROM camps;
  `);
  db.prepare('INSERT INTO camps (id,slug,name,created_at) VALUES (?,?,?,?)')
    .run('camp-one', 'shenzhen', '深圳营', now());
  db.prepare('INSERT INTO camps (id,slug,name,created_at) VALUES (?,?,?,?)')
    .run('camp-two', 'other', '其他营', now());
}

beforeEach(reset);
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('姓名规范化拒绝空值、控制字符和超长内容', () => {
  assert.equal(normalizeStudentName('  王梓潼  ', 'real_name'), '王梓潼');
  assert.throws(() => normalizeStudentName('', 'real_name'), IdentityError);
  assert.throws(() => normalizeStudentName('坏\u0000名字', 'real_name'), IdentityError);
  assert.throws(() => normalizeStudentName('学'.repeat(41), 'display_name'), IdentityError);
});

test('名单支持同名、已有邀请码关联和幂等重复导入', () => {
  for (const code of ['AIGAME-CODE000001', 'AIGAME-CODE000002']) {
    db.prepare(`INSERT INTO invites (code,camp_id,role,status,max_devices,created_at)
                VALUES (?,'camp-one','student','unused',3,?)`).run(code, now());
  }
  const entries = [
    { real_name: '同名同学', display_name: '创作者01', code: 'AIGAME-CODE000001' },
    { real_name: '同名同学', display_name: '创作者02', code: 'AIGAME-CODE000002' },
  ];
  const first = importRosterEntries({ campId: 'camp-one', entries, actorUserId: null });
  const second = importRosterEntries({ campId: 'camp-one', entries, actorUserId: null });
  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM camp_roster WHERE camp_id=?').get('camp-one').n, 2);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT roster_entry_id) AS n FROM invites WHERE camp_id=?').get('camp-one').n, 2);
});

test('给已绑定邀请码补名单时保留学员自定义昵称，只替换通用昵称', () => {
  db.prepare(`INSERT INTO users (id,username,display_name,created_at) VALUES ('u-custom','custom','自己昵称',?)`).run(now());
  db.prepare(`INSERT INTO users (id,username,display_name,created_at) VALUES ('u-generic','generic','新学员',?)`).run(now());
  for (const [code, user] of [['AIGAME-CUSTOM001', 'u-custom'], ['AIGAME-GENERIC01', 'u-generic']]) {
    db.prepare(`INSERT INTO invites (code,camp_id,role,status,bound_user_id,max_devices,created_at)
                VALUES (?,'camp-one','student','bound',?,3,?)`).run(code, user, now());
  }
  importRosterEntries({ campId: 'camp-one', actorUserId: null, entries: [
    { real_name: '甲同学', display_name: '老师昵称甲', code: 'AIGAME-CUSTOM001' },
    { real_name: '乙同学', display_name: '老师昵称乙', code: 'AIGAME-GENERIC01' },
  ] });
  assert.deepEqual({ ...db.prepare('SELECT display_name,real_name FROM users WHERE id=?').get('u-custom') }, { display_name: '自己昵称', real_name: '甲同学' });
  assert.deepEqual({ ...db.prepare('SELECT display_name,real_name FROM users WHERE id=?').get('u-generic') }, { display_name: '老师昵称乙', real_name: '乙同学' });
});

test('老师只能修改本营地名单并写入审计日志', () => {
  const imported = importRosterEntries({ campId: 'camp-one', actorUserId: null, entries: [{ real_name: '原姓名', display_name: '原昵称' }] });
  const id = imported.items[0].id;
  assert.throws(() => updateRosterEntry({ campId: 'camp-two', rosterId: id, input: { real_name: '越权' }, actorUserId: 'teacher' }), IdentityError);
  db.prepare(`INSERT INTO users (id,username,display_name,created_at) VALUES ('teacher','teacher','老师',?)`).run(now());
  const updated = updateRosterEntry({ campId: 'camp-one', rosterId: id, input: { real_name: '新姓名', display_name: '新昵称', verified: true }, actorUserId: 'teacher' });
  assert.equal(updated.real_name, '新姓名');
  assert.equal(updated.verification_status, 'verified');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='roster_update' AND target_id=?`).get(id).n, 1);
});
