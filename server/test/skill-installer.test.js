import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

async function buildHostedDistribution() {
  const output = mkdtempSync(join(tmpdir(), 'vh-skill-hosted-dist-'));
  const generated = await run(process.execPath, [join(skillRoot, 'scripts/build-distribution.mjs'), '--out', output], {
    cwd: repoRoot, env: { ...process.env },
  });
  assert.equal(generated.code, 0, generated.stderr);
  return output;
}

async function createHostedFixture(t, intercept = null) {
  const distribution = await buildHostedDistribution();
  const downloadTmp = mkdtempSync(join(tmpdir(), 'vh-skill-download-root-'));
  const requests = [];
  const prefix = '/downloads/vibehub-skill/';
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (!requestUrl.pathname.startsWith(prefix)) {
      response.writeHead(404).end('not found');
      return;
    }
    const relativePath = decodeURIComponent(requestUrl.pathname.slice(prefix.length));
    requests.push(relativePath);
    if (intercept?.({ relativePath, request, response, distribution })) return;
    const filePath = join(distribution, relativePath);
    if (!existsSync(filePath)) {
      response.writeHead(404).end('not found');
      return;
    }
    const body = readFileSync(filePath);
    response.writeHead(200, { 'content-length': body.byteLength });
    response.end(body);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}${prefix}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(distribution, { recursive: true, force: true });
    rmSync(downloadTmp, { recursive: true, force: true });
  });
  return { baseUrl, distribution, downloadTmp, requests };
}

function hostedInstallArgs(fixture, ...args) {
  return [
    join(fixture.distribution, 'install.mjs'),
    '--base-url', fixture.baseUrl,
    ...args,
  ];
}

function assertNoDownloadTemps(downloadTmp) {
  assert.deepEqual(
    readdirSync(downloadTmp).filter((name) => name.startsWith('vibehub-skill-download-')),
    [],
  );
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

test('自托管分发拒绝清空仓库外的宽目录并保留哨兵文件', async () => {
  const unsafeRoot = mkdtempSync(join(tmpdir(), 'vh-unsafe-wide-'));
  const sentinel = join(unsafeRoot, 'must-survive.txt');
  writeFileSync(sentinel, 'keep');

  try {
    const generated = await run(process.execPath, [
      join(skillRoot, 'scripts/build-distribution.mjs'),
      '--out',
      unsafeRoot,
    ], { cwd: repoRoot, env: { ...process.env } });

    assert.notEqual(generated.code, 0);
    assert.match(generated.stderr, /拒绝清空不安全的输出目录/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally {
    rmSync(unsafeRoot, { recursive: true, force: true });
  }
});

test('在线安装从真实 HTTP 分发下载精确七个文件、转发参数并清理临时目录', async (t) => {
  const fixture = await createHostedFixture(t);
  const home = mkdtempSync(join(tmpdir(), 'vh-skill-online-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = await run(process.execPath, hostedInstallArgs(
    fixture,
    '--home', home,
    '--targets', 'codex',
  ), {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'test', TMPDIR: fixture.downloadTmp },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /安装完成/);
  const installed = join(home, '.agents', 'skills', 'vibehub');
  for (const filePath of [
    'AGENTS.md',
    'SKILL.md',
    'agents/openai.yaml',
    'bin/install.mjs',
    'bin/vibehub',
    'distribution-files.mjs',
    'lib/platform.mjs',
  ]) {
    assert.ok(existsSync(join(installed, filePath)), `应安装 ${filePath}`);
  }
  assert.deepEqual(fixture.requests.sort(), [
    'files/AGENTS.md',
    'files/SKILL.md',
    'files/agents/openai.yaml',
    'files/bin/install.mjs',
    'files/bin/vibehub',
    'files/distribution-files.mjs',
    'files/lib/platform.mjs',
    'manifest.json',
  ].sort());
  assertNoDownloadTemps(fixture.downloadTmp);
});

test('在线安装在文件哈希被篡改时保护已有 Skill 并清理下载目录', async (t) => {
  const fixture = await createHostedFixture(t, ({ relativePath, response, distribution }) => {
    if (relativePath !== 'files/SKILL.md') return false;
    const body = Buffer.from(readFileSync(join(distribution, relativePath)));
    body[0] ^= 0xff;
    response.writeHead(200, { 'content-length': body.byteLength });
    response.end(body);
    return true;
  });
  const home = mkdtempSync(join(tmpdir(), 'vh-skill-online-existing-'));
  const destination = join(home, '.agents', 'skills', 'vibehub');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'SKILL.md'), 'student customization');
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = await run(process.execPath, hostedInstallArgs(
    fixture,
    '--home', home,
    '--targets', 'codex',
  ), {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'test', TMPDIR: fixture.downloadTmp },
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /完整性校验失败/);
  assert.doesNotMatch(result.stderr, /\n\s+at\s|install\.mjs:\d+/);
  assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'student customization');
  assert.equal(existsSync(join(home, '.vibehub', 'skill-backups')), false);
  assertNoDownloadTemps(fixture.downloadTmp);
});

test('在线安装拒绝清单缺失、跳转、超限、重复、危险路径与无效元数据', async (t) => {
  const cases = [
    {
      label: '清单 404',
      expected: /获取安装清单失败/,
      intercept: ({ relativePath, response }) => {
        if (relativePath !== 'manifest.json') return false;
        response.writeHead(404).end('missing');
        return true;
      },
    },
    {
      label: '清单跳转',
      expected: /禁止跳转/,
      intercept: ({ relativePath, response }) => {
        if (relativePath !== 'manifest.json') return false;
        response.writeHead(302, { location: '/other/manifest.json' }).end();
        return true;
      },
    },
    {
      label: '清单响应超限',
      expected: /安装清单超过大小限制/,
      intercept: ({ relativePath, response }) => {
        if (relativePath !== 'manifest.json') return false;
        const body = Buffer.alloc((64 * 1024) + 1, 0x20);
        response.writeHead(200, { 'content-length': body.byteLength });
        response.end(body);
        return true;
      },
    },
    {
      label: '清单缺少白名单文件',
      expected: /安装清单不安全/,
      mutate: (manifest) => { manifest.files.pop(); },
    },
    {
      label: '清单重复路径',
      expected: /安装清单不安全/,
      mutate: (manifest) => { manifest.files[1] = { ...manifest.files[0] }; },
    },
    {
      label: '清单危险路径',
      expected: /安装清单不安全/,
      mutate: (manifest) => { manifest.files[0].path = '../AGENTS.md'; },
    },
    {
      label: '文件声明超过上限',
      expected: /文件大小超过限制/,
      mutate: (manifest) => { manifest.files[0].bytes = (2 * 1024 * 1024) + 1; },
    },
    {
      label: '哈希必须为小写十六进制',
      expected: /安装清单不安全/,
      mutate: (manifest) => { manifest.files[0].sha256 = manifest.files[0].sha256.toUpperCase(); },
    },
    {
      label: '版本号格式无效',
      expected: /安装清单不安全/,
      mutate: (manifest) => { manifest.skill_version = 'latest'; },
    },
    {
      label: '清单版本无效',
      expected: /安装清单不安全/,
      mutate: (manifest) => { manifest.schema_version = 2; },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async (subtest) => {
      const fixture = await createHostedFixture(subtest, (context) => {
        if (entry.intercept?.(context)) return true;
        if (!entry.mutate || context.relativePath !== 'manifest.json') return false;
        const manifest = JSON.parse(readFileSync(join(context.distribution, 'manifest.json'), 'utf8'));
        entry.mutate(manifest);
        const body = Buffer.from(`${JSON.stringify(manifest)}\n`);
        context.response.writeHead(200, { 'content-length': body.byteLength });
        context.response.end(body);
        return true;
      });
      const home = mkdtempSync(join(tmpdir(), 'vh-skill-online-invalid-manifest-'));
      subtest.after(() => rmSync(home, { recursive: true, force: true }));
      const result = await run(process.execPath, hostedInstallArgs(
        fixture,
        '--home', home,
        '--targets', 'codex',
      ), {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: 'test', TMPDIR: fixture.downloadTmp },
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, entry.expected);
      assertNoDownloadTemps(fixture.downloadTmp);
    });
  }
});

test('在线安装拒绝文件跳转、响应超出清单与中断下载', async (t) => {
  const cases = [
    {
      label: '文件跳转',
      expected: /禁止跳转/,
      intercept: ({ relativePath, response }) => {
        if (relativePath !== 'files/SKILL.md') return false;
        response.writeHead(307, { location: '/other/SKILL.md' }).end();
        return true;
      },
    },
    {
      label: '文件响应超出清单',
      expected: /下载文件超过大小限制|下载内容与清单不符/,
      intercept: ({ relativePath, response, distribution }) => {
        if (relativePath !== 'files/SKILL.md') return false;
        const body = Buffer.concat([readFileSync(join(distribution, relativePath)), Buffer.from('extra')]);
        response.writeHead(200);
        response.end(body);
        return true;
      },
    },
    {
      label: '文件响应中断',
      expected: /下载文件失败或内容不完整/,
      intercept: ({ relativePath, response, distribution }) => {
        if (relativePath !== 'files/SKILL.md') return false;
        const body = readFileSync(join(distribution, relativePath));
        response.writeHead(200, { 'content-length': body.byteLength });
        response.write(body.subarray(0, Math.max(1, Math.floor(body.byteLength / 2))));
        response.destroy();
        return true;
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async (subtest) => {
      const fixture = await createHostedFixture(subtest, entry.intercept);
      const home = mkdtempSync(join(tmpdir(), 'vh-skill-online-bad-file-'));
      subtest.after(() => rmSync(home, { recursive: true, force: true }));
      const result = await run(process.execPath, hostedInstallArgs(
        fixture,
        '--home', home,
        '--targets', 'codex',
      ), {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: 'test', TMPDIR: fixture.downloadTmp },
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, entry.expected);
      assert.equal(existsSync(join(home, '.agents')), false);
      assertNoDownloadTemps(fixture.downloadTmp);
    });
  }
});

test('在线安装要求显式安全来源并只接受安装器参数白名单', async (t) => {
  const fixture = await createHostedFixture(t);
  const cases = [
    {
      label: '缺少来源',
      args: [join(fixture.distribution, 'install.mjs'), '--targets', 'codex'],
      expected: /必须提供 --base-url/,
    },
    {
      label: '生产环境拒绝 HTTP',
      args: [join(fixture.distribution, 'install.mjs'), '--base-url', 'http://example.com/downloads/', '--targets', 'codex'],
      env: { NODE_ENV: 'production' },
      expected: /安装来源地址不安全/,
    },
    {
      label: '测试环境只放行本机 HTTP',
      args: [join(fixture.distribution, 'install.mjs'), '--base-url', 'http://192.0.2.1/downloads/', '--targets', 'codex'],
      env: { NODE_ENV: 'test' },
      expected: /安装来源地址不安全/,
    },
    {
      label: '拒绝带凭证和片段的来源',
      args: [join(fixture.distribution, 'install.mjs'), '--base-url', 'https://student:secret@example.com/downloads/#token', '--targets', 'codex'],
      expected: /安装来源地址不安全/,
      forbidden: /student|secret|token/,
    },
    {
      label: '拒绝未知参数',
      args: [...hostedInstallArgs(fixture), '--eval', 'console.log(1)'],
      expected: /在线安装器不认识的参数/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const result = await run(process.execPath, entry.args, {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: 'test', ...entry.env, TMPDIR: fixture.downloadTmp },
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, entry.expected);
      if (entry.forbidden) assert.doesNotMatch(result.stderr, entry.forbidden);
      assertNoDownloadTemps(fixture.downloadTmp);
    });
  }
});
