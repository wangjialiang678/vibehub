/**
 * 上海营历史作品补全与合集去重。
 *
 * 输入必须是管理员在本地核验、整理后复制到生产机私有临时区的静态目录。
 * 脚本不会连接或修改任何历史源站；重复执行时，相同内容会跳过，不同内容会拒绝覆盖。
 *
 * 仓库不保存任何学员真实姓名：新用户的展示名默认用账号，需要保留已公开的角色署名时，
 * 由管理员用 `--authors <json>` 传入一个不进仓库的 `{"账号":"公开署名"}` 映射表。 */
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { paths, worksUrl } from '../src/lib/config.js';
import { rewriteAbsolutePaths } from '../src/services/unpack.js';
import { publishVersion, siteLink, versionDir } from '../src/services/publish.js';
import {
  cleanupPartialImport,
  inspectArtifact,
  isMainModule,
  makeArtifactPublicReadable,
  sha256Directory,
} from './import-ai-game-sh.mjs';

export const CAMP_SLUG = 'ai-game-shanghai';
const HISTORICAL_ARTIFACT_MAX_BYTES = 400 * 1024 * 1024;
const RECONCILIATION_JOURNAL = join(paths.tmp, 'ai-game-shanghai-reconcile.json');
const RECONCILIATION_LOCK = join(paths.tmp, 'ai-game-shanghai-reconcile.lock');

export const AI_GAME_SH_COMPLETE_MANIFEST = [
  {
    source: 'yijianlou/yijianlou', username: 'yijianlou',
    slug: 'yijianlou', title: '异检楼', label: '第三层＋第四层归档版',
    tagline: '在异检楼中探索第三层与第四层的悬疑章节。',
  },
  {
    source: 'angela/zhaiyuan', username: 'angela',
    slug: 'zhaiyuan', title: '宅怨·老宅探秘', label: '历史归档版',
    tagline: '走进老宅，追查被尘封的诡异往事。',
  },
  {
    source: 'radiance/justinrush', username: 'radiance',
    slug: 'justinrush', title: 'JustinRush', label: '历史归档版',
    tagline: '横版动作射击游戏原型。',
  },
  {
    source: 'gaodabao/ward-castle', username: 'gaodabao',
    slug: 'ward-castle', title: '沃德古堡', label: '手机版归档版',
    tagline: '探索沃德古堡，在线索与选择中揭开家族真相。',
  },
  {
    source: 'gaodabao/spirit-contract', username: 'gaodabao',
    slug: 'spirit-contract', title: '精灵契约', label: '历史归档版',
    tagline: '与精灵结契并展开幻想冒险。',
  },
  {
    source: 'gaodabao/soul-drift-bottle', username: 'gaodabao',
    slug: 'soul-drift-bottle', title: '心灵漂流瓶', label: '历史归档版',
    tagline: '让情绪与心声沿着漂流瓶彼此相遇。',
  },
  {
    source: 'gaodabao/huangshan-wingsuit', username: 'gaodabao',
    slug: 'huangshan-wingsuit', title: '黄山翼装飞行', label: '2D＋3D 原型归档版',
    tagline: '穿越黄山奇峰云海的翼装飞行原型。',
  },
];

// 只退出公开合集；项目、版本和静态站点地址全部保留。
export const AI_GAME_SH_HIDDEN_PROJECTS = [
  'lunhui-front',
  'lunhui-quick',
  'wujin-lunhui',
  'endless-reincarnation',
  'codex-godot',
];

function parseArgs(argv) {
  const sourceIndex = argv.indexOf('--source-root');
  const sourceRoot = sourceIndex >= 0 ? argv[sourceIndex + 1] : null;
  if (!sourceRoot) throw new Error('请提供 --source-root <已核验补全作品目录>');
  const authorsIndex = argv.indexOf('--authors');
  const authorsPath = authorsIndex >= 0 ? argv[authorsIndex + 1] : null;
  return { sourceRoot, authors: loadAuthors(authorsPath), dryRun: argv.includes('--dry-run') };
}

/**
 * 可选署名映射：`{"username": "公开署名"}`。
 * 映射表不进仓库，只由管理员从运营侧传入，避免把未成年人真实姓名写进代码。
 */
function loadAuthors(path) {
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--authors 需要 JSON 对象：{"账号":"公开署名"}');
  const authors = {};
  for (const [username, displayName] of Object.entries(parsed)) {
    if (typeof displayName !== 'string' || !displayName.trim()) throw new Error(`--authors 中 ${username} 的署名必须是非空字符串`);
    authors[username] = displayName.trim();
  }
  return authors;
}

function loadCamp(database) {
  const camp = database.prepare('SELECT id FROM camps WHERE slug=?').get(CAMP_SLUG);
  if (!camp) throw new Error(`上海营营地不存在: ${CAMP_SLUG}`);
  return camp;
}

function loadExistingProjects(database, campId) {
  return new Map(database.prepare(`
    SELECT p.id AS project_id,p.slug,u.username,v.bundle_sha
    FROM projects p
    JOIN users u ON u.id=p.owner_user_id
    LEFT JOIN versions v ON v.id=p.live_version_id
    WHERE p.camp_id=?`).all(campId).map((row) => [row.slug, row]));
}

function loadExistingUsers(database) {
  return new Map(database.prepare('SELECT id,username,display_name FROM users').all()
    .map((row) => [row.username, row]));
}

function loadHistoricalImports(database, campId) {
  return new Map(database.prepare(`
    SELECT h.source_key,h.project_id,h.source_sha,h.version_sha,p.slug,u.username
    FROM historical_imports h
    JOIN projects p ON p.id=h.project_id
    JOIN users u ON u.id=p.owner_user_id
    WHERE h.camp_id=?`).all(campId).map((row) => [row.source_key, row]));
}

/**
 * 展示名解析：优先用管理员从仓库外传入的公开署名，缺省退回账号。
 * 仓库因此可以完全不出现学员真实姓名。
 */
export function resolveDisplayName(authors, username) {
  const value = authors?.[username];
  return typeof value === 'string' && value.trim() ? value.trim() : username;
}

export function inspectReconciliationSource(sourceRoot, { authors = {} } = {}) {
  return AI_GAME_SH_COMPLETE_MANIFEST.map((item) => {
    const source = join(sourceRoot, item.source);
    const artifact = inspectArtifact(source, { maxBytes: HISTORICAL_ARTIFACT_MAX_BYTES });
    return {
      ...item,
      // 署名默认用账号；需要保留已公开的角色名时通过 --authors 传入不进仓库的映射表。
      displayName: resolveDisplayName(authors, item.username),
      sourceKey: `${CAMP_SLUG}:${item.source}`,
      source,
      ...artifact,
      bundleSha: sha256Directory(source, artifact.files),
    };
  });
}

export function classifyReconciliation(artifacts, existingProjects, historicalImports = new Map()) {
  const created = [];
  const skipped = [];
  for (const artifact of artifacts) {
    const existing = existingProjects.get(artifact.slug);
    if (!existing) {
      if (historicalImports.has(artifact.sourceKey)) throw new Error(`历史导入台账存在但项目缺失: ${artifact.slug}`);
      created.push(artifact);
      continue;
    }
    const imported = historicalImports.get(artifact.sourceKey);
    const sameRecordedSource = imported && imported.project_id === existing.project_id && imported.source_sha === artifact.bundleSha;
    const sameUnrewrittenBundle = !imported && existing.bundle_sha === artifact.bundleSha;
    if (existing.username !== artifact.username || (!sameRecordedSource && !sameUnrewrittenBundle)) {
      throw new Error(`已有项目内容与补全清单不一致: ${artifact.slug}`);
    }
    skipped.push(artifact);
  }
  return { created, skipped };
}

export function prepareReconciliationEntries(artifacts, existingUsers) {
  const users = new Map(existingUsers);
  const userFor = (artifact) => {
    if (!users.has(artifact.username)) {
      users.set(artifact.username, {
        id: `u_${nanoid(16)}`,
        username: artifact.username,
        display_name: artifact.displayName || artifact.username,
        isNew: true,
      });
    }
    return users.get(artifact.username);
  };
  return artifacts.map((artifact) => {
    const user = userFor(artifact);
    return {
      ...artifact,
      userId: user.id,
      userIsNew: Boolean(user.isNew),
      projectId: `p_${nanoid(16)}`,
      versionId: `v_${nanoid(16)}`,
      previewId: nanoid(16).toLowerCase().replace(/[^a-z0-9]/g, 'x'),
    };
  });
}

export function inspectReconciliation({ sourceRoot, database, authors = {} }) {
  const camp = loadCamp(database);
  const artifacts = inspectReconciliationSource(sourceRoot, { authors });
  const plan = classifyReconciliation(
    artifacts,
    loadExistingProjects(database, camp.id),
    loadHistoricalImports(database, camp.id),
  );
  for (const slug of AI_GAME_SH_HIDDEN_PROJECTS) {
    if (!loadExistingProjects(database, camp.id).has(slug)) throw new Error(`待隐藏项目不存在: ${slug}`);
  }
  return { camp, ...plan };
}

function acquireReconciliationLock(lockPath = RECONCILIATION_LOCK) {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ownerAlive = false;
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); ownerAlive = true; } catch (signalError) {
            if (signalError.code === 'EPERM') ownerAlive = true;
          }
        }
      } catch { /* 损坏的锁按中断残留处理 */ }
      if (ownerAlive) throw new Error('上海营补全任务正在运行，请勿并发执行');
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error('无法取得上海营补全任务锁');
}

function writeReconciliationJournal(journalPath, entries) {
  mkdirSync(join(journalPath, '..'), { recursive: true });
  const temporary = `${journalPath}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600 });
  renameSync(temporary, journalPath);
}

function removeOwnedSiteLink(link, finalDir) {
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === finalDir) rmSync(link, { force: true });
  } catch { /* 不删除不属于本次导入的路径 */ }
}

/**
 * 上次进程若在文件切换与数据库提交之间被强杀：
 * - 数据库已有项目，说明提交成功，只清台账；
 * - 数据库没有项目，删除本次 journal 明确记录的孤儿文件，恢复可重试状态。
 */
export function recoverInterruptedReconciliation({ database, journalPath = RECONCILIATION_JOURNAL }) {
  if (!existsSync(journalPath)) return false;
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  if (journal.version !== 1 && journal.version !== undefined) throw new Error('无法识别上海营补全恢复台账版本');
  for (const entry of journal.entries || []) {
    const committed = database.prepare('SELECT id FROM projects WHERE id=?').get(entry.projectId);
    if (committed) continue;
    removeOwnedSiteLink(entry.siteLink, entry.finalDir);
    rmSync(entry.stagingDir, { recursive: true, force: true });
    rmSync(entry.finalDir, { recursive: true, force: true });
  }
  rmSync(journalPath, { force: true });
  return true;
}

export function reconcileHistoricalProjects({ sourceRoot, database, authors = {} }) {
  let transactionOpen = false;
  let committed = false;
  let entries = [];
  const versionDirs = [];
  const stagingDirs = [];
  const siteLinks = [];
  acquireReconciliationLock();
  try {
    recoverInterruptedReconciliation({ database });
    const { camp, created, skipped } = inspectReconciliation({ sourceRoot, database, authors });
    const users = loadExistingUsers(database);
    entries = prepareReconciliationEntries(created, users);
    const runId = `${process.pid}-${Date.now()}`;

    for (const entry of entries) {
      entry.finalDir = versionDir(entry.versionId);
      entry.stagingDir = `${entry.finalDir}.staging-${runId}`;
      entry.siteLink = siteLink(entry.username, entry.slug);
    }
    writeReconciliationJournal(RECONCILIATION_JOURNAL, entries.map((entry) => ({
      projectId: entry.projectId,
      finalDir: entry.finalDir,
      stagingDir: entry.stagingDir,
      siteLink: entry.siteLink,
    })));

    for (const entry of entries) {
      if (existsSync(entry.finalDir) || existsSync(entry.stagingDir)) throw new Error(`目标版本目录已存在: ${entry.versionId}`);
      if (existsSync(entry.siteLink) || safeIsSymlink(entry.siteLink)) throw new Error(`目标公开地址已存在: ${entry.username}/${entry.slug}`);
      mkdirSync(paths.versions, { recursive: true });
      stagingDirs.push(entry.stagingDir);
      entry.bundleShaBeforeRewrite = entry.bundleSha;
      cpSync(entry.source, entry.stagingDir, { recursive: true, errorOnExist: true, force: false });
      makeArtifactPublicReadable(entry.stagingDir);
      entry.rewrites = rewriteAbsolutePaths(entry.stagingDir, `/vibehub/${entry.username}/${entry.slug}`).slice(0, 50);
      const copied = inspectArtifact(entry.stagingDir, { maxBytes: HISTORICAL_ARTIFACT_MAX_BYTES });
      entry.fileCount = copied.files.length;
      entry.bundleSize = copied.totalBytes;
      entry.bundleSha = sha256Directory(entry.stagingDir, copied.files);
    }

    // 大文件准备在事务外完成；这里只持有短事务做最终冲突复核、原子改名和写库。
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const latestPlan = classifyReconciliation(
      created,
      loadExistingProjects(database, camp.id),
      loadHistoricalImports(database, camp.id),
    );
    if (latestPlan.created.length !== entries.length) throw new Error('补全期间项目状态已变化，请重新执行');
    const maxOrder = Number(database.prepare('SELECT COALESCE(MAX(collection_order),0) AS n FROM projects WHERE camp_id=?').get(camp.id).n);
    const createdAt = new Date().toISOString();
    for (const entry of entries) {
      if (existsSync(entry.finalDir)) throw new Error(`目标版本目录已存在: ${entry.versionId}`);
      if (existsSync(entry.siteLink) || safeIsSymlink(entry.siteLink)) throw new Error(`目标公开地址已存在: ${entry.username}/${entry.slug}`);
      renameSync(entry.stagingDir, entry.finalDir);
      versionDirs.push(entry.finalDir);
      publishVersion({ username: entry.username, slug: entry.slug, versionId: entry.versionId });
      siteLinks.push(entry.siteLink);
    }

    const insertedUsers = new Set();
    for (const entry of entries) {
      if (entry.userIsNew && !insertedUsers.has(entry.userId)) {
        database.prepare('INSERT INTO users (id,username,display_name,created_at) VALUES (?,?,?,?)')
          .run(entry.userId, entry.username, entry.displayName, createdAt);
        database.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
          .run(camp.id, entry.userId, 'student', createdAt);
        insertedUsers.add(entry.userId);
      }
    }

    for (const [index, entry] of entries.entries()) {
      database.prepare(`INSERT INTO projects
        (id,camp_id,owner_user_id,slug,title,tagline,category,dev_status,publish_status,live_version_id,collection_order,collection_recommended,collection_hidden,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        entry.projectId, camp.id, entry.userId, entry.slug, entry.title, entry.tagline,
        '游戏', 'developing', 'published', entry.versionId, maxOrder + index + 1, 1, 0, createdAt, createdAt,
      );
      database.prepare(`INSERT INTO versions
        (id,project_id,label,seq,summary,flows,bundle_sha,bundle_size,file_count,rewrites,rejected,preview_id,submitted_by,submitted_via,submitted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        entry.versionId, entry.projectId, entry.label, 1,
        '从上海营本地历史归档复制补全；保留原始归档，未修改历史源站。', '[]',
        entry.bundleSha, entry.bundleSize, entry.fileCount, JSON.stringify(entry.rewrites), '[]',
        entry.previewId, entry.userId, 'historical_import', createdAt,
      );
      database.prepare(`INSERT INTO deployments (id,version_id,target,status,url,started_at,finished_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        `dp_${nanoid(16)}`, entry.versionId, 'live', 'ready', worksUrl(entry.username, entry.slug), createdAt, createdAt,
      );
      database.prepare(`INSERT INTO reviews (id,version_id,project_id,camp_id,status,comment,created_at,decided_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        `r_${nanoid(16)}`, entry.versionId, entry.projectId, camp.id, 'approved',
        '经管理员授权，将上海营历史作品或原型复制归档并公开。', createdAt, createdAt,
      );
      database.prepare(`INSERT INTO historical_imports
        (source_key,camp_id,project_id,source_sha,version_sha,imported_at) VALUES (?,?,?,?,?,?)`).run(
        entry.sourceKey, camp.id, entry.projectId, entry.bundleShaBeforeRewrite, entry.bundleSha, createdAt,
      );
    }

    const hide = database.prepare('UPDATE projects SET collection_hidden=1,updated_at=? WHERE camp_id=? AND slug=?');
    for (const slug of AI_GAME_SH_HIDDEN_PROJECTS) hide.run(createdAt, camp.id, slug);
    database.exec('COMMIT');
    transactionOpen = false;
    committed = true;
    rmSync(RECONCILIATION_JOURNAL, { force: true });
    return {
      created: entries.map(({ username, slug, title }) => ({ username, slug, title, url: worksUrl(username, slug) })),
      skipped: skipped.map(({ username, slug, title }) => ({ username, slug, title, url: worksUrl(username, slug) })),
      hidden_from_collection: AI_GAME_SH_HIDDEN_PROJECTS,
    };
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
    }
    if (!committed) {
      cleanupPartialImport(entries, { versionDirs: [...versionDirs, ...stagingDirs], siteLinks });
      rmSync(RECONCILIATION_JOURNAL, { force: true });
    }
    throw error;
  } finally {
    rmSync(RECONCILIATION_LOCK, { force: true });
  }
}

function safeIsSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  (async () => {
    try {
      const { sourceRoot, dryRun, authors } = parseArgs(process.argv.slice(2));
      const { db: database } = await import('../src/lib/db.js');
      const inspected = inspectReconciliation({ sourceRoot, database, authors });
      if (dryRun) {
        console.log(JSON.stringify({
          dry_run: true,
          created: inspected.created.map(({ username, slug, title, totalBytes, files, bundleSha }) => ({ username, slug, title, total_bytes: totalBytes, file_count: files.length, bundle_sha: bundleSha })),
          skipped: inspected.skipped.map(({ username, slug, title }) => ({ username, slug, title })),
          hidden_from_collection: AI_GAME_SH_HIDDEN_PROJECTS,
        }, null, 2));
      } else {
        console.log(JSON.stringify(reconcileHistoricalProjects({ sourceRoot, database, authors }), null, 2));
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  })();
}
