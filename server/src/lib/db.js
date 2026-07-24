import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DATA_DIR } from './config.js';

const DB_PATH = `${DATA_DIR}/db.sqlite`;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// 表结构见 docs/specs/domain-model.md。改这里必须同步改那份文档。
db.exec(`
CREATE TABLE IF NOT EXISTS camps (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'course',
  theme TEXT, intro TEXT, cover_url TEXT,
  visibility_default TEXT NOT NULL DEFAULT 'nickname',
  collection_published INTEGER NOT NULL DEFAULT 1,
  stale_days INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,      -- URL 用，路径式网址的一段
  display_name TEXT NOT NULL,         -- 昵称，公开展示
  real_name TEXT,                     -- 仅管理端可见
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS camp_members (
  camp_id TEXT NOT NULL REFERENCES camps(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'student',
  joined_at TEXT NOT NULL,
  PRIMARY KEY (camp_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  role TEXT NOT NULL DEFAULT 'student',
  status TEXT NOT NULL DEFAULT 'unused',   -- unused|bound|revoked|expired
  bound_user_id TEXT REFERENCES users(id),
  bound_project_id TEXT,
  max_devices INTEGER NOT NULL DEFAULT 3,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  bound_at TEXT, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_camp ON invites(camp_id, status);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  tagline TEXT, category TEXT, cover_url TEXT,
  dev_status TEXT NOT NULL DEFAULT 'not_started',
  publish_status TEXT NOT NULL DEFAULT 'unpublished',
  visibility TEXT,
  live_version_id TEXT,
  pending_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (camp_id, slug)
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  seq INTEGER NOT NULL,
  summary TEXT,
  flows TEXT,                         -- JSON 数组：学员声明的核心操作路径
  bundle_sha TEXT NOT NULL,
  bundle_size INTEGER NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  rewrites TEXT,                      -- JSON：解包时做过的绝对路径重写，学员可见
  preview_id TEXT NOT NULL UNIQUE,
  submitted_by TEXT NOT NULL REFERENCES users(id),
  submitted_via TEXT NOT NULL DEFAULT 'skill',
  submitted_at TEXT NOT NULL,
  UNIQUE (project_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, seq DESC);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  target TEXT NOT NULL,               -- preview|live
  status TEXT NOT NULL,               -- deploying|ready|failed
  url TEXT, error TEXT,
  started_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deploy_version ON deployments(version_id, target);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  camp_id TEXT NOT NULL REFERENCES camps(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|superseded
  reviewer_id TEXT REFERENCES users(id),
  comment TEXT,
  created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_queue ON reviews(camp_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS diagnoses (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  status TEXT NOT NULL,               -- running|healthy|needs_work|blocked|failed
  score INTEGER,
  policy_version TEXT NOT NULL,
  facts TEXT NOT NULL,                -- JSON
  items TEXT NOT NULL,               -- JSON: diagnostic_item[]
  summary TEXT,
  next_steps TEXT,                    -- JSON
  model TEXT,
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_diag_version ON diagnoses(version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                 -- skill|web
  user_id TEXT NOT NULL REFERENCES users(id),
  camp_id TEXT NOT NULL REFERENCES camps(id),
  project_id TEXT,
  role TEXT NOT NULL,
  invite_code TEXT REFERENCES invites(code),
  device_name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_invite ON tokens(invite_code);

-- 最小 BaaS：按项目命名空间隔离
CREATE TABLE IF NOT EXISTS baas_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  collection TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_baas ON baas_records(project_id, collection, created_at DESC);

CREATE TABLE IF NOT EXISTS baas_counters (
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE IF NOT EXISTS baas_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  filename TEXT NOT NULL,
  mime TEXT, size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_baas_files ON baas_files(project_id);

-- 作品运行时调用台账：诊断的「服务端」维度靠它，不靠猜
CREATE TABLE IF NOT EXISTS baas_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- data_write|data_read|file|counter|ai
  ok INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls ON baas_calls(project_id, at DESC);

CREATE TABLE IF NOT EXISTS page_views (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);
`);

export const now = () => new Date().toISOString();
