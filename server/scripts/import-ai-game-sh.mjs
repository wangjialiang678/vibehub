/**
 * 一次性历史作品导入器。
 *
 * 只接收已经由管理员从新加坡源站复制到本机临时目录的静态作品；不会连接或改动源站。
 * 导入前必须先用 --dry-run 确认清单和冲突状态，再移除该参数执行一次。
 */
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { paths, worksUrl } from '../src/lib/config.js';
import { isSensitiveArtifactPath, listFiles, rewriteAbsolutePaths } from '../src/services/unpack.js';
import { publishVersion, siteLink, versionDir } from '../src/services/publish.js';

export const AI_GAME_SH_CAMP = {
  slug: 'ai-game-shanghai',
  name: 'Codex × Godot 游戏训练营·上海营',
  kind: 'course',
  theme: '上海营 · 游戏作品集',
  intro: '这里收集了 Codex × Godot 游戏训练营上海营学员已经完成并复制归档的游戏作品。',
};

// 只包含管理员逐一确认仍可访问的作品；不从源目录自动发现，以免把 smoke、测速和管理工具公开。
export const AI_GAME_SH_MANIFEST = [
  ['ailidego/jianyiwei', 'ailidego', 'jianyiwei', '王国防线'],
  ['andyl/space-game', 'andyl', 'space-game', '喜服'],
  ['dudongzhe/lunhui', 'dudongzhe', 'lunhui', '无尽轮回·三部曲'],
  ['dudongzhe/lunhui-front', 'dudongzhe', 'lunhui-front', '贪婪轮回·前篇'],
  ['dudongzhe/lunhui-quick', 'dudongzhe', 'lunhui-quick', '无尽轮回（快速版）'],
  ['dudongzhe/wujin-lunhui', 'dudongzhe', 'wujin-lunhui', '贪婪轮回（另一发布版）'],
  ['elon/chentuxing', 'elon', 'chentuxing', '尘途行·盛唐武侠生存'],
  ['jingliu/grey-zone', 'jingliu', 'grey-zone', '潜行 3D'],
  ['player/endless-reincarnation', 'player', 'endless-reincarnation', '无尽轮回·三部曲（player 版）'],
  ['renhaoxun/neon-shooter', 'renhaoxun', 'neon-shooter', '星际防线'],
  ['rita/aetherglow', 'rita', 'aetherglow', '浮光城：一生奇遇'],
  ['ruanminghao/huaxi', 'ruanminghao', 'huaxi', '花息·漫游灵野'],
  ['wangcheche/jingxiuzhonghua', 'wangcheche', 'jingxiuzhonghua', '锦绣中华'],
  ['zhangyuhang/paoku', 'zhangyuhang', 'paoku', '简单的跑酷'],
  ['feiyang/codex-godot', 'feiyang', 'codex-godot', 'Codex × Godot 游戏训练营'],
].map(([source, username, slug, title]) => ({ source, username, slug, title }));

const BANNED_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.exe', '.dll', '.so', '.dylib', '.bin', '.app', '.command']);

function manifestUsernames() {
  return [...new Set(AI_GAME_SH_MANIFEST.map((item) => item.username))];
}

/** 只允许全新导入，重复执行必须显式失败，绝不覆盖已有数据或正式作品。 */
export function assertImportIsSafe({ camp, usernames, projectSlugs }) {
  if (camp) throw new Error(`上海营营地已存在: ${AI_GAME_SH_CAMP.slug}`);
  for (const username of manifestUsernames()) {
    if (usernames.has(username)) throw new Error(`上海营历史导入账号已存在: ${username}`);
  }
  for (const { slug } of AI_GAME_SH_MANIFEST) {
    if (projectSlugs.has(slug)) throw new Error(`上海营历史导入项目已存在: ${slug}`);
  }
}

export function inspectArtifact(dir, { maxBytes = 200 * 1024 * 1024 } = {}) {
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`缺少 index.html: ${dir}`);
  let totalBytes = 0;
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = lstatSync(full);
      const rel = relative(dir, full).split('\\').join('/');
      if (stat.isSymbolicLink()) throw new Error(`不允许符号链接: ${rel}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        if (isSensitiveArtifactPath(rel)) throw new Error(`不允许敏感文件: ${rel}`);
        if (BANNED_EXTENSIONS.has(extname(rel).toLowerCase()) || (stat.mode & 0o111)) {
          throw new Error(`不允许可执行文件: ${rel}`);
        }
        totalBytes += stat.size;
        files.push(rel);
      } else throw new Error(`不允许特殊文件: ${rel}`);
    }
  };
  walk(dir);
  if (totalBytes > maxBytes) throw new Error(`作品超过 ${Math.floor(maxBytes / 1024 / 1024)} MB: ${dir}`);
  return { totalBytes, files: files.sort() };
}

/** 源站可能以仅属主可读的模式保存产物；公开静态副本必须让 nginx 工作用户可读取。 */
export function makeArtifactPublicReadable(dir) {
  const walk = (current) => {
    const currentStat = lstatSync(current);
    if (currentStat.isSymbolicLink()) throw new Error(`不允许符号链接: ${current}`);
    if (currentStat.isDirectory()) {
      chmodSync(current, 0o755);
      for (const name of readdirSync(current)) walk(join(current, name));
    } else if (currentStat.isFile()) {
      chmodSync(current, 0o644);
    } else throw new Error(`不允许特殊文件: ${current}`);
  };
  walk(dir);
}

export function sha256Directory(dir, files) {
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function loadExistingRows(database) {
  const camp = database.prepare('SELECT id FROM camps WHERE slug=?').get(AI_GAME_SH_CAMP.slug) || null;
  const usernames = new Set(database.prepare('SELECT username FROM users').all().map(({ username }) => username));
  const projectSlugs = new Set(database.prepare('SELECT slug FROM projects').all().map(({ slug }) => slug));
  return { camp, usernames, projectSlugs };
}

function parseArgs(argv) {
  const sourceIndex = argv.indexOf('--source-root');
  const sourceRoot = sourceIndex >= 0 ? argv[sourceIndex + 1] : null;
  if (!sourceRoot) throw new Error('请提供 --source-root <历史作品临时目录>');
  return { sourceRoot, dryRun: argv.includes('--dry-run') };
}

export function isMainModule(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); }
  catch { return false; }
}

export function inspectImport({ sourceRoot, database }) {
  if (!database) throw new Error('缺少 VibeHub 数据库连接');
  const rows = loadExistingRows(database);
  assertImportIsSafe(rows);
  return AI_GAME_SH_MANIFEST.map((item) => {
    const source = join(sourceRoot, item.source);
    const artifact = inspectArtifact(source);
    return { ...item, source, ...artifact };
  });
}

export function prepareImportEntries(artifacts) {
  const users = new Map();
  const userIdFor = (username) => {
    if (!users.has(username)) users.set(username, `u_${nanoid(16)}`);
    return users.get(username);
  };
  return artifacts.map((artifact, index) => ({
    ...artifact,
    userId: userIdFor(artifact.username),
    projectId: `p_${nanoid(16)}`,
    versionId: `v_${nanoid(16)}`,
    previewId: nanoid(16).toLowerCase().replace(/[^a-z0-9]/g, 'x'),
    order: index + 1,
  }));
}

export function cleanupPartialImport(entries, { versionDirs, siteLinks }) {
  for (const path of siteLinks.reverse()) {
    try {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
    } catch { /* 尽力清除本次新建的链接，原始错误优先 */ }
  }
  for (const path of versionDirs.reverse()) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}

export function importHistoricalProjects({ sourceRoot, database }) {
  let entries = [];
  const versionDirs = [];
  const siteLinks = [];
  let transactionOpen = false;

  try {
    // 从冲突检查到提交始终持有 SQLite 写锁；否则并行导入可能互相覆盖正式链接后再失败清理。
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const artifacts = inspectImport({ sourceRoot, database });
    const campId = `c_${nanoid(16)}`;
    const createdAt = new Date().toISOString();
    entries = prepareImportEntries(artifacts);
    const users = new Map(entries.map(({ username, userId }) => [username, userId]));

    // 先完整落盘，再建立站点链接；任一阶段失败都会只清除本次创建的路径。
    for (const entry of entries) {
      const target = versionDir(entry.versionId);
      const link = siteLink(entry.username, entry.slug);
      if (existsSync(target)) throw new Error(`目标版本目录已存在: ${entry.versionId}`);
      if (existsSync(link)) throw new Error(`目标公开地址已存在: ${entry.username}/${entry.slug}`);
      mkdirSync(paths.versions, { recursive: true });
      // cpSync 也可能在部分落盘后抛错，因此复制前即登记，确保 cleanup 能回收半成品。
      versionDirs.push(target);
      cpSync(entry.source, target, { recursive: true, errorOnExist: true, force: false });
      makeArtifactPublicReadable(target);
      const rewrites = rewriteAbsolutePaths(target, `/vibehub/${entry.username}/${entry.slug}`);
      const copied = inspectArtifact(target);
      entry.fileCount = copied.files.length;
      entry.bundleSize = copied.totalBytes;
      entry.bundleSha = sha256Directory(target, copied.files);
      entry.rewrites = rewrites.slice(0, 50);
    }
    for (const entry of entries) {
      publishVersion({ username: entry.username, slug: entry.slug, versionId: entry.versionId });
      siteLinks.push(siteLink(entry.username, entry.slug));
    }

      database.prepare(`INSERT INTO camps (id,slug,name,kind,theme,intro,created_at)
                VALUES (?,?,?,?,?,?,?)`).run(
      campId, AI_GAME_SH_CAMP.slug, AI_GAME_SH_CAMP.name, AI_GAME_SH_CAMP.kind,
      AI_GAME_SH_CAMP.theme, AI_GAME_SH_CAMP.intro, createdAt,
    );
    for (const [username, userId] of users) {
      database.prepare('INSERT INTO users (id,username,display_name,created_at) VALUES (?,?,?,?)')
        .run(userId, username, username, createdAt);
      database.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
        .run(campId, userId, 'student', createdAt);
    }
    for (const entry of entries) {
      database.prepare(`INSERT INTO projects
        (id,camp_id,owner_user_id,slug,title,tagline,category,dev_status,publish_status,live_version_id,collection_order,collection_recommended,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        entry.projectId, campId, entry.userId, entry.slug, entry.title,
        '从上海营历史作品库复制归档', '游戏', 'developing', 'published', entry.versionId,
        entry.order, 1, createdAt, createdAt,
      );
      database.prepare(`INSERT INTO versions
        (id,project_id,label,seq,summary,flows,bundle_sha,bundle_size,file_count,rewrites,rejected,preview_id,submitted_by,submitted_via,submitted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        entry.versionId, entry.projectId, '历史归档版', 1,
        `从 ai-game-sh.sg.superbrain-ai.com/${entry.source.replace(`${sourceRoot}/`, '')}/ 复制归档。`,
        '[]', entry.bundleSha, entry.bundleSize, entry.fileCount, JSON.stringify(entry.rewrites), '[]',
        entry.previewId, entry.userId, 'historical_import', createdAt,
      );
      database.prepare(`INSERT INTO deployments (id,version_id,target,status,url,started_at,finished_at)
                  VALUES (?,?,?,?,?,?,?)`).run(
        `dp_${nanoid(16)}`, entry.versionId, 'live', 'ready', worksUrl(entry.username, entry.slug), createdAt, createdAt,
      );
      database.prepare(`INSERT INTO reviews (id,version_id,project_id,camp_id,status,comment,created_at,decided_at)
                  VALUES (?,?,?,?,?,?,?,?)`).run(
        `r_${nanoid(16)}`, entry.versionId, entry.projectId, campId, 'approved',
        '经管理员授权，按历史作品复制流程归档并公开。', createdAt, createdAt,
      );
    }
    database.exec('COMMIT');
    transactionOpen = false;
    return { campId, projects: entries.map(({ source, username, slug, title, bundleSize, fileCount }) => ({ source, username, slug, title, bundleSize, fileCount, url: worksUrl(username, slug) })) };
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* 已由数据库自动中止时无需覆盖原始错误 */ }
    }
    cleanupPartialImport(entries, { versionDirs, siteLinks });
    throw error;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  (async () => {
    try {
    const { sourceRoot, dryRun } = parseArgs(process.argv.slice(2));
    const { db: database } = await import('../src/lib/db.js');
    const inspected = inspectImport({ sourceRoot, database });
    if (dryRun) {
      console.log(JSON.stringify({ dry_run: true, camp: AI_GAME_SH_CAMP, projects: inspected.map(({ source, username, slug, title, totalBytes, files }) => ({ source, username, slug, title, total_bytes: totalBytes, file_count: files.length })) }, null, 2));
    } else {
      console.log(JSON.stringify(importHistoricalProjects({ sourceRoot, database }), null, 2));
    }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  })();
}
