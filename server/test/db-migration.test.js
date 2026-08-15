import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = mkdtempSync(join(tmpdir(), 'vh-old-schema-migration-'));
process.env.VIBEHUB_DATA_DIR = dataDir;
process.env.VIBEHUB_MODEL_GATEWAY_URL = '';
process.env.VIBEHUB_PREVIEW_CLAIM_SECRET = 'old-schema-migration-secret-at-least-32-bytes';
mkdirSync(dataDir, { recursive: true });

const oldDb = new DatabaseSync(join(dataDir, 'db.sqlite'));
oldDb.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, camp_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    slug TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (camp_id, slug)
  );
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    user_id TEXT NOT NULL, camp_id TEXT NOT NULL, project_id TEXT, role TEXT NOT NULL,
    invite_code TEXT, device_name TEXT, created_at TEXT NOT NULL, last_used_at TEXT,
    expires_at TEXT, revoked_at TEXT
  );
  INSERT INTO projects VALUES ('p_old','c_old','u_old','old-work','旧作品','2026-01-01','2026-01-01');
  INSERT INTO tokens VALUES ('t_old','hash-old','skill','u_old','c_old','p_old','student',NULL,'旧设备','2026-01-01',NULL,NULL,NULL);
`);
oldDb.close();

const { db } = await import('../src/lib/db.js');

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('旧 projects/tokens schema 启动后补列、唯一索引和派生索引且保留旧数据', () => {
  const projectColumns = db.prepare('PRAGMA table_info(projects)').all().map((row) => row.name);
  const tokenColumns = db.prepare('PRAGMA table_info(tokens)').all().map((row) => row.name);
  assert.ok(projectColumns.includes('creation_request_id'));
  assert.ok(tokenColumns.includes('derived_from_token_id'));
  assert.equal(db.prepare('SELECT title FROM projects WHERE id=?').get('p_old').title, '旧作品');
  assert.equal(db.prepare('SELECT device_name FROM tokens WHERE id=?').get('t_old').device_name, '旧设备');

  const projectIndex = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_projects_creation_request'`).get();
  assert.match(projectIndex.sql, /UNIQUE INDEX/i);
  assert.match(projectIndex.sql, /WHERE creation_request_id IS NOT NULL/i);
  const tokenIndex = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tokens_derived_from'`).get();
  assert.match(tokenIndex.sql, /derived_from_token_id/i);
});
