import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AI_GAME_SH_MANIFEST,
  assertImportIsSafe,
  cleanupPartialImport,
  isMainModule,
  makeArtifactPublicReadable,
  prepareImportEntries,
} from '../scripts/import-ai-game-sh.mjs';
import {
  AI_GAME_SH_COMPLETE_MANIFEST,
  AI_GAME_SH_HIDDEN_PROJECTS,
  classifyReconciliation,
  prepareReconciliationEntries,
  recoverInterruptedReconciliation,
  resolveDisplayName,
} from '../scripts/reconcile-ai-game-sh.mjs';

test('上海营历史导入清单只包含已确认的 15 个游戏作品', () => {
  assert.equal(AI_GAME_SH_MANIFEST.length, 15);
  assert.deepEqual(
    AI_GAME_SH_MANIFEST.map(({ source, username, slug }) => ({ source, username, slug })),
    [
      { source: 'ailidego/jianyiwei', username: 'ailidego', slug: 'jianyiwei' },
      { source: 'andyl/space-game', username: 'andyl', slug: 'space-game' },
      { source: 'dudongzhe/lunhui', username: 'dudongzhe', slug: 'lunhui' },
      { source: 'dudongzhe/lunhui-front', username: 'dudongzhe', slug: 'lunhui-front' },
      { source: 'dudongzhe/lunhui-quick', username: 'dudongzhe', slug: 'lunhui-quick' },
      { source: 'dudongzhe/wujin-lunhui', username: 'dudongzhe', slug: 'wujin-lunhui' },
      { source: 'elon/chentuxing', username: 'elon', slug: 'chentuxing' },
      { source: 'jingliu/grey-zone', username: 'jingliu', slug: 'grey-zone' },
      { source: 'player/endless-reincarnation', username: 'player', slug: 'endless-reincarnation' },
      { source: 'renhaoxun/neon-shooter', username: 'renhaoxun', slug: 'neon-shooter' },
      { source: 'rita/aetherglow', username: 'rita', slug: 'aetherglow' },
      { source: 'ruanminghao/huaxi', username: 'ruanminghao', slug: 'huaxi' },
      { source: 'wangcheche/jingxiuzhonghua', username: 'wangcheche', slug: 'jingxiuzhonghua' },
      { source: 'zhangyuhang/paoku', username: 'zhangyuhang', slug: 'paoku' },
      { source: 'feiyang/codex-godot', username: 'feiyang', slug: 'codex-godot' },
    ],
  );
  assert.equal(AI_GAME_SH_MANIFEST.some(({ source }) => /smoke|test|speedtest|complaint|gdd-wizard/.test(source)), false);
});

test('上海营历史导入拒绝已有营地、账号或项目，防止重复覆盖', () => {
  const existing = {
    camp: null,
    usernames: new Set(),
    projectSlugs: new Set(),
  };
  assert.doesNotThrow(() => assertImportIsSafe(existing));

  assert.throws(
    () => assertImportIsSafe({ ...existing, camp: { id: 'c_existing' } }),
    /营地已存在/,
  );
  assert.throws(
    () => assertImportIsSafe({ ...existing, usernames: new Set(['player']) }),
    /账号已存在: player/,
  );
  assert.throws(
    () => assertImportIsSafe({ ...existing, projectSlugs: new Set(['lunhui']) }),
    /项目已存在: lunhui/,
  );
});

test('同一学员的多部历史作品共用同一个有效账号', () => {
  const entries = prepareImportEntries(AI_GAME_SH_MANIFEST.map((item) => ({
    ...item,
    totalBytes: 1,
    files: ['index.html'],
    source: `/tmp/${item.source}`,
  })));
  const reincarnationWorks = entries.filter(({ username }) => username === 'dudongzhe');

  assert.equal(reincarnationWorks.length, 4);
  assert.equal(new Set(reincarnationWorks.map(({ userId }) => userId)).size, 1);
});

test('历史副本会将网页文件设为 nginx 可读取、目录可进入', () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-import-perms-'));
  const assets = join(root, 'assets');
  mkdirSync(assets);
  const index = join(root, 'index.html');
  const image = join(assets, 'cover.png');
  writeFileSync(index, '<h1>game</h1>');
  writeFileSync(image, 'asset');
  chmodSync(root, 0o770);
  chmodSync(assets, 0o770);
  chmodSync(index, 0o660);
  chmodSync(image, 0o660);

  makeArtifactPublicReadable(root);

  assert.equal(statSync(root).mode & 0o777, 0o755);
  assert.equal(statSync(assets).mode & 0o777, 0o755);
  assert.equal(statSync(index).mode & 0o777, 0o644);
  assert.equal(statSync(image).mode & 0o777, 0o644);
});

test('复制在建立完整版本目录前中断时会清理半成品目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-import-cleanup-'));
  const partialVersion = join(root, 'v_partial');
  mkdirSync(partialVersion);
  writeFileSync(join(partialVersion, 'copied-first-file.html'), 'partial');

  cleanupPartialImport([], { versionDirs: [partialVersion], siteLinks: [] });

  assert.equal(existsSync(partialVersion), false);
});

test('通过当前 release 软链执行历史脚本时仍识别为命令行入口', () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-import-main-'));
  const actual = join(root, 'actual.mjs');
  const link = join(root, 'current.mjs');
  writeFileSync(actual, 'export default true;');
  symlinkSync(actual, link);

  assert.equal(isMainModule(pathToFileURL(actual).href, link), true);
});

test('上海营补全清单包含七个本地找回作品族，且入口规范为 index.html', () => {
  assert.deepEqual(
    AI_GAME_SH_COMPLETE_MANIFEST.map(({ username, slug, title }) => ({ username, slug, title })),
    [
      { username: 'yijianlou', slug: 'yijianlou', title: '异检楼' },
      { username: 'angela', slug: 'zhaiyuan', title: '宅怨·老宅探秘' },
      { username: 'radiance', slug: 'justinrush', title: 'JustinRush' },
      { username: 'gaodabao', slug: 'ward-castle', title: '沃德古堡' },
      { username: 'gaodabao', slug: 'spirit-contract', title: '精灵契约' },
      { username: 'gaodabao', slug: 'soul-drift-bottle', title: '心灵漂流瓶' },
      { username: 'gaodabao', slug: 'huangshan-wingsuit', title: '黄山翼装飞行' },
    ],
  );
  assert.equal(AI_GAME_SH_COMPLETE_MANIFEST.every(({ source }) => !source.includes('..')), true);
  // 仓库不保存学员姓名：署名默认取账号，需要保留公开角色名时由 --authors 从仓库外注入。
  assert.equal(AI_GAME_SH_COMPLETE_MANIFEST.every((item) => !('displayName' in item)), true);
});

test('补全时展示名默认取账号，仓库外传入的署名优先', () => {
  assert.equal(resolveDisplayName(undefined, 'radiance'), 'radiance');
  assert.equal(resolveDisplayName({}, 'gaodabao'), 'gaodabao');
  assert.equal(resolveDisplayName({ gaodabao: '   ' }, 'gaodabao'), 'gaodabao');
  assert.equal(resolveDisplayName({ radiance: ' Radiance ' }, 'radiance'), 'Radiance');
});

test('合集去重只隐藏四个轮回变体和课程页，不删除项目或网址', () => {
  assert.deepEqual(AI_GAME_SH_HIDDEN_PROJECTS, [
    'lunhui-front',
    'lunhui-quick',
    'wujin-lunhui',
    'endless-reincarnation',
    'codex-godot',
  ]);
});

test('增量导入只创建缺失项目，已完成项按内容指纹跳过', () => {
  const artifacts = AI_GAME_SH_COMPLETE_MANIFEST.map((item, index) => ({
    ...item,
    source: `/tmp/${item.source}`,
    totalBytes: index + 1,
    files: ['index.html'],
    bundleSha: `sha-${index}`,
  }));
  const existing = new Map([
    ['yijianlou', { slug: 'yijianlou', bundle_sha: 'sha-0', username: 'yijianlou' }],
  ]);

  const plan = classifyReconciliation(artifacts, existing);

  assert.deepEqual(plan.skipped.map(({ slug }) => slug), ['yijianlou']);
  assert.equal(plan.created.length, 6);
  assert.throws(
    () => classifyReconciliation(artifacts, new Map([
      ['yijianlou', { slug: 'yijianlou', bundle_sha: 'different', username: 'yijianlou' }],
    ])),
    /已有项目内容与补全清单不一致/,
  );
});

test('路径重写改变正式版本指纹后，历史导入台账仍能让相同源副本幂等跳过', () => {
  const artifact = {
    ...AI_GAME_SH_COMPLETE_MANIFEST[0],
    sourceKey: 'ai-game-shanghai:yijianlou/yijianlou',
    source: '/tmp/yijianlou',
    totalBytes: 1,
    files: ['index.html'],
    bundleSha: 'source-sha',
  };
  const existing = new Map([[
    artifact.slug,
    { project_id: 'p_existing', slug: artifact.slug, bundle_sha: 'rewritten-version-sha', username: artifact.username },
  ]]);
  const imports = new Map([[
    artifact.sourceKey,
    { project_id: 'p_existing', source_sha: 'source-sha', version_sha: 'rewritten-version-sha' },
  ]]);

  const plan = classifyReconciliation([artifact], existing, imports);

  assert.equal(plan.created.length, 0);
  assert.deepEqual(plan.skipped.map(({ slug }) => slug), ['yijianlou']);
});

test('同一作者的多个补全作品复用一个账号 id', () => {
  const artifacts = AI_GAME_SH_COMPLETE_MANIFEST.map((item) => ({
    ...item,
    source: `/tmp/${item.source}`,
    totalBytes: 1,
    files: ['index.html'],
    bundleSha: 'sha',
  }));
  const entries = prepareReconciliationEntries(artifacts, new Map());
  const gaodabao = entries.filter(({ username }) => username === 'gaodabao');

  assert.equal(gaodabao.length, 4);
  assert.equal(new Set(gaodabao.map(({ userId }) => userId)).size, 1);
});

test('崩溃恢复会删除未提交导入的专属链接和目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-reconcile-recover-'));
  const finalDir = join(root, 'versions', 'v_orphan');
  const stagingDir = `${finalDir}.staging-run`;
  const link = join(root, 'sites', 'student', 'game');
  mkdirSync(finalDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(join(link, '..'), { recursive: true });
  symlinkSync(finalDir, link);
  const journalPath = join(root, 'journal.json');
  writeFileSync(journalPath, JSON.stringify({ entries: [{ projectId: 'p_orphan', finalDir, stagingDir, siteLink: link }] }));
  const database = { prepare: () => ({ get: () => undefined }) };

  recoverInterruptedReconciliation({ database, journalPath });

  assert.equal(existsSync(finalDir), false);
  assert.equal(existsSync(stagingDir), false);
  assert.equal(existsSync(link), false);
  assert.equal(existsSync(journalPath), false);
});

test('崩溃恢复保留已经提交的正式版本和链接', () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-reconcile-committed-'));
  const finalDir = join(root, 'versions', 'v_committed');
  const link = join(root, 'sites', 'student', 'game');
  mkdirSync(finalDir, { recursive: true });
  mkdirSync(join(link, '..'), { recursive: true });
  symlinkSync(finalDir, link);
  const journalPath = join(root, 'journal.json');
  writeFileSync(journalPath, JSON.stringify({ entries: [{ projectId: 'p_committed', finalDir, stagingDir: `${finalDir}.staging-run`, siteLink: link }] }));
  const database = { prepare: () => ({ get: () => ({ id: 'p_committed' }) }) };

  recoverInterruptedReconciliation({ database, journalPath });

  assert.equal(existsSync(finalDir), true);
  assert.equal(readlinkSync(link), finalDir);
  assert.equal(existsSync(journalPath), false);
});
