import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = join(repoRoot, 'skill');

function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('一条命令把同一份提示词和脚本安装到 Codex、Claude Code 与 WorkBuddy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vh-skill-install-'));
  try {
    const result = await run(process.execPath, [join(skillRoot, 'bin/install.mjs'), '--home', home], {
      cwd: repoRoot, env: { ...process.env },
    });
    assert.equal(result.code, 0, result.stderr);
    const roots = [
      join(home, '.agents', 'skills', 'vibehub'),
      join(home, '.claude', 'skills', 'vibehub'),
      join(home, '.codebuddy', 'skills', 'vibehub'),
    ];
    for (const root of roots) {
      for (const file of ['SKILL.md', 'AGENTS.md', 'distribution-files.mjs', 'bin/vibehub', 'lib/platform.mjs', 'agents/openai.yaml']) {
        assert.ok(existsSync(join(root, file)), `${root} 应包含 ${file}`);
      }
      assert.match(readFileSync(join(root, 'SKILL.md'), 'utf8'), /AI 负责/);
    }
    assert.match(result.stdout, /Codex/);
    assert.match(result.stdout, /Claude Code/);
    assert.match(result.stdout, /WorkBuddy/);
    assert.match(result.stdout, /邀请码/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('安装器拒绝未知 Agent 且不创建目标目录', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vh-skill-install-invalid-'));
  try {
    const result = await run(process.execPath, [join(skillRoot, 'bin/install.mjs'), '--home', home, '--targets', 'unknown'], {
      cwd: repoRoot, env: { ...process.env },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /不支持的 AI 工具/);
    assert.equal(existsSync(join(home, '.agents')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('其他兼容 Agent 可以把完整 Skill 安装到自定义目录', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vh-skill-install-custom-home-'));
  const destination = join(home, 'my-agent', 'skills', 'vibehub');
  try {
    const result = await run(process.execPath, [join(skillRoot, 'bin/install.mjs'), '--dir', destination], {
      cwd: repoRoot, env: { ...process.env },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(join(destination, 'SKILL.md')));
    assert.ok(existsSync(join(destination, 'bin', 'vibehub')));
    assert.match(result.stdout, /自定义 Agent/);
    assert.equal(existsSync(join(home, '.agents')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--dir 在任何复制或重命名前拒绝危险目录，且不破坏其他 Skills', async (t) => {
  const cases = [
    { label: '用户主目录', target: (home) => home },
    { label: 'skills 根目录', target: (home) => join(home, 'custom-agent', 'skills') },
    { label: 'Codex skills 根目录', target: (home) => join(home, '.agents', 'skills') },
    { label: 'Claude skills 根目录', target: (home) => join(home, '.claude', 'skills') },
    { label: 'WorkBuddy skills 根目录', target: (home) => join(home, '.codebuddy', 'skills') },
    { label: '明显宽泛的工作区目录', target: (home) => join(home, 'workspace') },
    { label: '不在 skills 下的 vibehub 目录', target: (home) => join(home, 'projects', 'vibehub') },
    { label: '名为 vibehub 的文件', target: (home) => join(home, 'custom-agent', 'skills', 'vibehub'), file: true },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const home = mkdtempSync(join(tmpdir(), 'vh-skill-install-danger-'));
      const target = entry.target(home);
      const sibling = join(home, 'custom-agent', 'skills', 'other-skill');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'SKILL.md'), 'must survive');
      if (entry.file) writeFileSync(target, 'must remain a file');
      else mkdirSync(target, { recursive: true });

      try {
        const result = await run(process.execPath, [join(skillRoot, 'bin/install.mjs'), '--home', home, '--dir', target], {
          cwd: repoRoot, env: { ...process.env },
        });
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /自定义目录.*(?:skills.*vibehub|文件)/);
        assert.doesNotMatch(result.stderr, /\n\s+at\s|install\.mjs:\d+/);
        assert.equal(readFileSync(join(sibling, 'SKILL.md'), 'utf8'), 'must survive');
        assert.equal(existsSync(join(home, '.vibehub', 'skill-backups')), false);
        assert.equal(readdirSync(join(target, '..')).some((name) => name.includes('.staging-')), false);
        if (entry.file) assert.equal(readFileSync(target, 'utf8'), 'must remain a file');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test('重复安装会备份已有 Skill 后再更新', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vh-skill-install-backup-'));
  const destination = join(home, '.agents', 'skills', 'vibehub');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'SKILL.md'), 'student customization');
  try {
    const result = await run(process.execPath, [join(skillRoot, 'bin/install.mjs'), '--home', home, '--targets', 'codex'], {
      cwd: repoRoot, env: { ...process.env },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(readFileSync(join(destination, 'SKILL.md'), 'utf8'), /student customization/);
    const backupRoot = join(home, '.vibehub', 'skill-backups');
    const backup = readdirSync(backupRoot).find((name) => name.startsWith('vibehub-'));
    assert.ok(backup, '应创建带时间戳的备份目录');
    assert.equal(readFileSync(join(backupRoot, backup, 'SKILL.md'), 'utf8'), 'student customization');
    assert.equal(readdirSync(join(home, '.agents', 'skills')).some((name) => name.startsWith('vibehub.backup-')), false);
    assert.match(result.stdout, /已备份旧版本/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const fault of [
  { value: 'copy', label: '复制文件失败' },
  { value: 'swap', label: '原子换入失败' },
]) {
  test(`${fault.label}时恢复已有版本、清理暂存目录并给出可操作提示`, async () => {
    const home = mkdtempSync(join(tmpdir(), `vh-skill-install-${fault.value}-`));
    const parent = join(home, '.agents', 'skills');
    const destination = join(parent, 'vibehub');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'SKILL.md'), 'student customization');
    try {
      const result = await run(process.execPath, [join(skillRoot, 'bin/install.mjs'), '--home', home, '--targets', 'codex'], {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: 'test', VIBEHUB_INSTALL_TEST_FAULT: fault.value },
      });
      assert.notEqual(result.code, 0);
      assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'student customization');
      assert.deepEqual(readdirSync(parent), ['vibehub']);
      assert.match(result.stderr, /安装失败/);
      assert.match(result.stderr, /重试|检查/);
      assert.doesNotMatch(result.stderr, /\n\s+at\s|install\.mjs:\d+/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('自托管分发只生成固定白名单并提供可复算的完整性清单', async () => {
  const expectedFiles = [
    'AGENTS.md',
    'SKILL.md',
    'agents/openai.yaml',
    'bin/install.mjs',
    'bin/vibehub',
    'distribution-files.mjs',
    'lib/platform.mjs',
  ].sort();
  const output = mkdtempSync(join(tmpdir(), 'vh-skill-dist-'));
  try {
    writeFileSync(join(output, 'repository-secret-token'), 'must be removed');
    const generated = await run(process.execPath, [join(skillRoot, 'scripts/build-distribution.mjs'), '--out', output], {
      cwd: repoRoot, env: { ...process.env },
    });
    assert.equal(generated.code, 0, generated.stderr);

    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.skill_version, '1.0.0');
    assert.deepEqual(manifest.files.map((file) => file.path), expectedFiles);
    for (const entry of manifest.files) {
      assert.equal(entry.path.startsWith('/') || entry.path.split('/').includes('..'), false);
      const content = readFileSync(join(output, 'files', entry.path));
      assert.equal(content.byteLength, entry.bytes);
      assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256);
    }
    assert.ok(existsSync(join(output, 'install.mjs')));

    const outputPaths = [
      'install.mjs',
      'manifest.json',
      ...expectedFiles.map((path) => `files/${path}`),
    ].sort();
    const actualPaths = readdirSync(output, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(output, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'))
      .sort();
    assert.deepEqual(actualPaths, outputPaths);
    assert.doesNotMatch(actualPaths.join('\n'), /(?:^|\/)(?:package\.json|\.npmrc)(?:$|\/)|token/i);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('自托管分发共享白名单不可变且拒绝危险路径', async () => {
  const moduleUrl = pathToFileURL(join(skillRoot, 'distribution-files.mjs')).href;
  const { assertSafeDistributionPath, DISTRIBUTION_FILES, SKILL_VERSION } = await import(moduleUrl);

  assert.equal(SKILL_VERSION, '1.0.0');
  assert.ok(Object.isFrozen(DISTRIBUTION_FILES));
  assert.throws(() => assertSafeDistributionPath('/absolute/path'), /unsafe distribution path/);
  assert.throws(() => assertSafeDistributionPath('../secret'), /unsafe distribution path/);
  assert.throws(() => assertSafeDistributionPath('files/../secret'), /unsafe distribution path/);
  assert.throws(() => assertSafeDistributionPath('C:/absolute/path'), /unsafe distribution path/);
  assert.equal(assertSafeDistributionPath('agents/openai.yaml'), 'agents/openai.yaml');
});

test('自托管分发源只保留私有本地版本元数据', () => {
  const pkg = JSON.parse(readFileSync(join(skillRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg, {
    name: 'vibehub-skill-source',
    version: '1.0.0',
    description: '让 AI 助手把网页游戏提交到 VibeHub 营地',
    type: 'module',
    engines: { node: '>=20' },
    license: 'UNLICENSED',
    private: true,
  });
});

test('自托管分发拒绝通过符号链接把输出目录指回 Skill 源码', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'vh-skill-dist-link-'));
  const sourceSentinel = join(skillRoot, 'scripts', `.source-safety-${process.pid}`);
  mkdirSync(sourceSentinel);
  writeFileSync(join(sourceSentinel, 'must-survive'), 'source');
  symlinkSync(skillRoot, join(sandbox, 'skill-link'), 'dir');

  try {
    const generated = await run(process.execPath, [
      join(skillRoot, 'scripts/build-distribution.mjs'),
      '--out',
      join(sandbox, 'skill-link', 'scripts', `.source-safety-${process.pid}`),
    ], { cwd: repoRoot, env: { ...process.env } });

    assert.notEqual(generated.code, 0);
    assert.match(generated.stderr, /拒绝清空不安全的输出目录/);
    assert.equal(readFileSync(join(sourceSentinel, 'must-survive'), 'utf8'), 'source');
  } finally {
    rmSync(sourceSentinel, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});
