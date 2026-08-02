import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';

const dirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

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

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return `http://127.0.0.1:${server.address().port}`;
}

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test('deploy 在异步诊断未就绪时提示稍后查看状态而不输出 undefined', async () => {
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/api/skill/versions/preflight') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ duplicate: false }));
    }
    if (req.url === '/api/skill/versions') {
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        label: 'v0.1.0',
        preview_url: 'http://works.test/vibehub/_preview/demo/?claim=deploy-secret',
        diagnosis: { id: 'd_demo', status: 'running' },
        message: '已生成预览版本。',
      }));
    }
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-home-');
  const project = tempDir('vh-cli-project-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({ token: 'test-token', api }));
  writeFileSync(join(project, 'index.html'), '<main>测试作品</main>');

  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', project], {
      cwd: resolve('..'),
      env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /正在做诊断，稍后用 vibehub status 查看/);
    assert.doesNotMatch(result.stdout, /undefined/);
    assert.doesNotMatch(result.stdout, /deploy-secret|claim=/);
    assert.match(result.stdout, /http:\/\/works\.test\/vibehub\/_preview\/demo\//);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('deploy 的打包产物不会包含敏感文件或密钥目录', async () => {
  let receivedBundle = null;
  const server = createServer((req, res) => {
    if (req.url === '/api/skill/versions/preflight') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ duplicate: false }));
    }
    if (req.url === '/api/skill/versions') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'])?.[1];
        const fileStart = body.indexOf(Buffer.from('filename="bundle.tgz"'));
        const contentStart = body.indexOf(Buffer.from('\r\n\r\n'), fileStart) + 4;
        const contentEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
        receivedBundle = body.subarray(contentStart, contentEnd);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ label: 'v0.1.0', preview_url: 'http://works.test/vibehub/_preview/demo/', diagnosis: { id: 'd_demo', status: 'running' }, message: '已生成预览版本。' }));
      });
      return;
    }
    req.resume();
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-secure-home-');
  const project = tempDir('vh-cli-secure-project-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({ token: 'test-token', api }));
  writeFileSync(join(project, 'index.html'), '<main>测试作品</main>');
  for (const file of ['.env', '.env.local', 'server.pem', 'server.key', 'id_rsa_backup', 'id_ed25519_backup', 'cert.pfx', 'cert.p12', 'credentials.json', '.npmrc', 'debug.log']) {
    writeFileSync(join(project, file), '不应被打包');
  }
  for (const dir of ['.git', '.aws', '.ssh']) {
    mkdirSync(join(project, dir));
    writeFileSync(join(project, dir, 'secret'), '不应被打包');
  }

  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', project], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(receivedBundle, '假服务端应收到部署包');
    const archive = join(tempDir('vh-cli-secure-archive-'), 'bundle.tgz');
    writeFileSync(archive, receivedBundle);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.ok(entries.some((entry) => entry.endsWith('index.html')));
    for (const name of ['.env', '.env.local', 'server.pem', 'server.key', 'id_rsa_backup', 'id_ed25519_backup', 'cert.pfx', 'cert.p12', 'credentials.json', '.npmrc', 'debug.log']) {
      assert.ok(!entries.some((entry) => entry.endsWith(name)), `${name} 不应出现在部署包`);
    }
    for (const dir of ['.git', '.aws', '.ssh']) {
      assert.ok(!entries.some((entry) => entry.includes(`/${dir}/`)), `${dir} 不应出现在部署包`);
    }
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('status 同时展示完成度与验证覆盖率', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/skill/project') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        project: { title: '测试作品', publish_status: 'unpublished' },
        camp: { name: '测试营' },
        latest_diagnosis: {
          score: 82,
          completeness: 82,
          verified_ratio: 57,
          applicable_earned: 90,
          applicable_max: 110,
          items: [],
          summary: '诊断已完成。',
        },
      }));
    }
    req.resume();
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-status-home-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({ token: 'test-token', api }));

  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'status'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /完成度\s+\x1B\[1m82%/);
    assert.match(result.stdout, /验证覆盖率\s+57%/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('status 只显示无凭证预览地址，不签发或输出 bearer claim', async () => {
  let grants = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/skill/project') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        project: { title: '测试作品', publish_status: 'unpublished' },
        camp: { name: '测试营' },
        pending_version: { label: 'v0.2.0', preview_url: 'http://works.test/vibehub/_preview/preview123456789/' },
        latest_diagnosis: null,
      }));
    }
    if (req.method === 'POST' && req.url === '/api/previews/preview123456789/grant') {
      grants += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ preview_url: 'http://works.test/vibehub/_preview/preview123456789/?claim=short-lived' }));
    }
    req.resume();
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-status-preview-home-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({ token: 'test-token', api }));

  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'status'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(grants, 0);
    assert.doesNotMatch(result.stdout, /claim=short-lived|claim=/);
    assert.match(result.stdout, /http:\/\/works\.test\/vibehub\/_preview\/preview123456789\//);
    assert.match(result.stdout, /vibehub open/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('open 为待审版本换取短期预览地址后再打开', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/skill/project') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        project: { title: '测试作品', publish_status: 'published_with_pending', live_url: 'http://works.test/vibehub/learner/live/' },
        pending_version: { label: 'v0.2.0', preview_url: 'http://works.test/vibehub/_preview/preview123456789/' },
      }));
    }
    if (req.method === 'POST' && req.url === '/api/previews/preview123456789/grant') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ preview_url: 'http://works.test/vibehub/_preview/preview123456789/?claim=short-lived' }));
    }
    req.resume();
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-open-preview-home-');
  const bin = tempDir('vh-cli-open-bin-');
  const capture = join(tempDir('vh-cli-open-capture-'), 'url.txt');
  const openCommand = process.platform === 'darwin' ? 'open' : 'xdg-open';
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({ token: 'test-token', api }));
  writeFileSync(join(bin, openCommand), '#!/bin/sh\nprintf %s "$1" > "$VIBEHUB_OPEN_CAPTURE"\n');
  chmodSync(join(bin, openCommand), 0o755);

  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'open'], {
      cwd: resolve('..'),
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, VIBEHUB_API: api, VIBEHUB_OPEN_CAPTURE: capture },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(capture, 'utf8'), 'http://works.test/vibehub/_preview/preview123456789/?claim=short-lived');
    assert.doesNotMatch(result.stdout, /claim=short-lived|claim=/);
    assert.match(result.stdout, /已在浏览器打开安全预览/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('open 系统调用失败时错误消息也不回显完整 preview claim', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/skill/project') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        project: { title: '测试作品', publish_status: 'unpublished' },
        pending_version: { label: 'v0.2.0', preview_url: 'http://preview123456789.preview.test/vibehub/_preview/preview123456789/' },
      }));
    }
    if (req.method === 'POST' && req.url === '/api/previews/preview123456789/grant') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ preview_url: 'http://preview123456789.preview.test/vibehub/_preview/preview123456789/?claim=failure-secret' }));
    }
    req.resume();
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-open-failure-home-');
  const bin = tempDir('vh-cli-open-failure-bin-');
  const openCommand = process.platform === 'darwin' ? 'open' : 'xdg-open';
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({ token: 'test-token', api }));
  writeFileSync(join(bin, openCommand), '#!/bin/sh\nexit 42\n');
  chmodSync(join(bin, openCommand), 0o755);

  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'open'], {
      cwd: resolve('..'),
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, VIBEHUB_API: api },
    });
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /failure-secret|claim=|preview123456789\.preview\.test/);
    assert.match(result.stderr, /浏览器没有成功打开安全预览/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});
