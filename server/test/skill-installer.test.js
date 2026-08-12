import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

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
    const result = await run(process.execPath, [resolve('../skill/bin/install.mjs'), '--home', home], {
      cwd: resolve('..'), env: { ...process.env },
    });
    assert.equal(result.code, 0, result.stderr);
    const roots = [
      join(home, '.agents', 'skills', 'vibehub'),
      join(home, '.claude', 'skills', 'vibehub'),
      join(home, '.codebuddy', 'skills', 'vibehub'),
    ];
    for (const root of roots) {
      for (const file of ['SKILL.md', 'AGENTS.md', 'bin/vibehub', 'lib/platform.mjs', 'agents/openai.yaml']) {
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
    const result = await run(process.execPath, [resolve('../skill/bin/install.mjs'), '--home', home, '--targets', 'unknown'], {
      cwd: resolve('..'), env: { ...process.env },
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
    const result = await run(process.execPath, [resolve('../skill/bin/install.mjs'), '--dir', destination], {
      cwd: resolve('..'), env: { ...process.env },
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
        const result = await run(process.execPath, [resolve('../skill/bin/install.mjs'), '--home', home, '--dir', target], {
          cwd: resolve('..'), env: { ...process.env },
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
    const result = await run(process.execPath, [resolve('../skill/bin/install.mjs'), '--home', home, '--targets', 'codex'], {
      cwd: resolve('..'), env: { ...process.env },
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
      const result = await run(process.execPath, [resolve('../skill/bin/install.mjs'), '--home', home, '--targets', 'codex'], {
        cwd: resolve('..'),
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

test('npm 包只发布 Skill 运行所需文件并提供安装与部署命令', async () => {
  const pkg = JSON.parse(readFileSync(resolve('../skill/package.json'), 'utf8'));
  assert.equal(pkg.name, '@supermind/vibehub-skill');
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.bin['vibehub-skill'], 'bin/install.mjs');
  assert.equal(pkg.bin.vibehub, 'bin/vibehub');
  assert.deepEqual(pkg.files, ['SKILL.md', 'AGENTS.md', 'agents', 'bin', 'lib']);

  const output = mkdtempSync(join(tmpdir(), 'vh-skill-pack-'));
  try {
    const packageManager = process.env.npm_execpath;
    assert.ok(packageManager, '测试必须由 npm/pnpm 脚本启动');
    const packed = await run(process.execPath, [packageManager, 'pack', '--json', '--pack-destination', output], {
      cwd: resolve('../skill'), env: { ...process.env },
    });
    assert.equal(packed.code, 0, packed.stderr);
    const manifest = JSON.parse(packed.stdout);
    const files = (Array.isArray(manifest) ? manifest[0] : manifest).files.map((file) => file.path).sort();
    assert.deepEqual(files, [
      'AGENTS.md',
      'SKILL.md',
      'agents/openai.yaml',
      'bin/install.mjs',
      'bin/vibehub',
      'lib/platform.mjs',
      'package.json',
    ]);
    assert.equal(readdirSync(output).filter((name) => name.endsWith('.tgz')).length, 1);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
