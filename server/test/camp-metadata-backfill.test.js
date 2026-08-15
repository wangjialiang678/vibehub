import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'vh-camp-metadata-'));
process.env.VIBEHUB_DATA_DIR = dataDir;
const { db, now } = await import('../src/lib/db.js');
const { paths } = await import('../src/lib/config.js');
const { applyCampMetadataBackfill, planCampMetadataBackfill } = await import('../scripts/backfill-camp-project-metadata.mjs');

beforeEach(() => {
  db.exec(`DELETE FROM audit_logs; DELETE FROM versions; DELETE FROM projects; DELETE FROM tokens;
    DELETE FROM invites; DELETE FROM camp_roster; DELETE FROM camp_members; DELETE FROM users; DELETE FROM camps;`);
  rmSync(paths.versions, { recursive: true, force: true });
  mkdirSync(paths.versions, { recursive: true });
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

function fixture() {
  db.prepare('INSERT INTO camps (id,slug,name,created_at) VALUES (?,?,?,?)').run('c1', 'camp-one', '测试营', now());
  db.prepare('INSERT INTO users (id,username,display_name,real_name,created_at) VALUES (?,?,?,?,?)').run('teacher', 'teacher-one', '老师', '老师', now());
  db.prepare('INSERT INTO users (id,username,display_name,real_name,created_at) VALUES (?,?,?,?,?)').run('student', 'student-one', '创作者01', '小明', now());
  db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)').run('c1', 'teacher', 'teacher', now());
  db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)').run('c1', 'student', 'student', now());
  db.prepare(`INSERT INTO camp_roster (id,camp_id,real_name,display_name,user_id,source,verification_status,created_at,updated_at)
              VALUES (?,?,?,?,?,'teacher','verified',?,?)`).run('roster1', 'c1', '小明', '创作者01', 'student', now(), now());
  db.prepare(`INSERT INTO camp_roster (id,camp_id,real_name,display_name,source,verification_status,created_at,updated_at)
              VALUES (?,?,?,?,'teacher','verified',?,?)`).run('roster2', 'c1', '小红', '创作者02', now(), now());
  db.prepare(`INSERT INTO projects (id,camp_id,owner_user_id,slug,title,publish_status,live_version_id,created_at,updated_at)
              VALUES (?,?,?,?,?,'published','v1',?,?)`).run('p1', 'c1', 'student', 'work-one', '我的作品', now(), now());
  db.prepare(`INSERT INTO projects (id,camp_id,owner_user_id,slug,title,visibility,created_at,updated_at)
              VALUES (?,?,?,?,?,'camp_only',?,?)`).run('p2', 'c1', 'student', 'private-work', '营地内作品', now(), now());
  db.prepare(`INSERT INTO versions (id,project_id,label,seq,summary,bundle_sha,bundle_size,file_count,preview_id,submitted_by,submitted_at)
              VALUES ('v1','p1','v1',1,?,'sha',1,1,'preview1','student',?)`).run('首次提交：完成双人竞速、AI 对手和结算页面。', now());
  mkdirSync(join(paths.versions, 'v1'), { recursive: true });
  writeFileSync(join(paths.versions, 'v1', 'index.html'), '<!doctype html><title>极速分裂 · 双人竞速</title><main>游戏</main>');
}

test('dry-run 规划公开名单与默认作品元数据，apply 原子写入并记录授权审计', () => {
  fixture();
  const plan = planCampMetadataBackfill({ database: db, campSlug: 'camp-one', publishRosterNames: true });
  assert.deepEqual(plan.counts, { roster_names: 2, project_realnames: 1, project_titles: 1, project_taglines: 1 });
  assert.equal(db.prepare('SELECT title FROM projects WHERE id=?').get('p1').title, '我的作品');

  const applied = applyCampMetadataBackfill({ database: db, campSlug: 'camp-one', actorUsername: 'teacher-one', publishRosterNames: true });
  assert.deepEqual(applied.counts, plan.counts);
  assert.equal(db.prepare('SELECT display_name FROM camp_roster WHERE id=?').get('roster1').display_name, '小明');
  assert.equal(db.prepare('SELECT display_name FROM camp_roster WHERE id=?').get('roster2').display_name, '小红');
  assert.equal(db.prepare('SELECT display_name FROM users WHERE id=?').get('student').display_name, '创作者01',
    '全局昵称不能被单个营地的公开授权覆盖');
  assert.equal(db.prepare('SELECT visibility FROM projects WHERE id=?').get('p1').visibility, 'realname');
  assert.equal(db.prepare('SELECT visibility FROM projects WHERE id=?').get('p2').visibility, 'camp_only',
    '实名展示授权不能改变仅营地可见的作品');
  const project = db.prepare('SELECT title,tagline FROM projects WHERE id=?').get('p1');
  assert.equal(project.title, '极速分裂 · 双人竞速');
  assert.equal(project.tagline, '完成双人竞速、AI 对手和结算页面。');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='camp_metadata_backfill'`).get().n, 1);

  assert.deepEqual(applyCampMetadataBackfill({ database: db, campSlug: 'camp-one', actorUsername: 'teacher-one', publishRosterNames: true }).counts,
    { roster_names: 0, project_realnames: 0, project_titles: 0, project_taglines: 0 });
});
