import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

for (const scenario of [
  { name: '成功提交', preflight: { status: 200, body: { duplicate: false } }, upload: { status: 201 }, expectedCode: 0 },
  { name: '判定重复', preflight: { status: 200, body: { duplicate: true, message: '相同版本已提交' } }, expectedCode: 0 },
  { name: '上传被服务端拒绝', preflight: { status: 200, body: { duplicate: false } }, upload: { status: 503 }, expectedCode: 1 },
]) {
  test(`deploy ${scenario.name}后都会清理临时 tgz`, async () => {
    const artifacts = tempDir('vh-cli-artifacts-');
    let sawTarball = false;
    const server = createServer((req, res) => {
      if (req.url === '/api/skill/versions/preflight') {
        sawTarball ||= readdirSync(artifacts).some((name) => name.endsWith('.tgz'));
        req.resume();
        res.writeHead(scenario.preflight.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(scenario.preflight.body));
      }
      if (req.url === '/api/skill/versions') {
        sawTarball ||= readdirSync(artifacts).some((name) => name.endsWith('.tgz'));
        req.resume();
        res.writeHead(scenario.upload.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(scenario.upload.status === 201 ? {
          label: 'v0.1.0',
          preview_url: 'http://works.test/vibehub/_preview/demo/',
          diagnosis: { status: 'running' },
          message: '已生成预览版本。',
        } : { error: { message: '上传服务暂时不可用', hint: '稍后重试' } }));
      }
      req.resume();
      res.writeHead(404).end();
    });
    const api = await listen(server);
    const home = tempDir('vh-cli-cleanup-home-');
    const project = tempDir('vh-cli-cleanup-project-');
    mkdirSync(join(home, '.vibehub'));
    writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({ token: 'test-token', api }));
    writeFileSync(join(project, 'index.html'), '<main>测试作品</main>');

    try {
      const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', project], {
        cwd: resolve('..'),
        env: {
          ...process.env,
          HOME: home,
          NODE_ENV: 'test',
          VIBEHUB_API: api,
          VIBEHUB_TEST_TMPDIR: artifacts,
        },
      });
      assert.equal(result.code, scenario.expectedCode, result.stderr);
      assert.equal(sawTarball, true, '请求发生时应存在本次部署的临时包');
      assert.deepEqual(readdirSync(artifacts), [], '命令结束后不应残留临时包');
    } finally {
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });
}

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
    assert.match(result.stdout, /正在做诊断，稍后用 node ".*vibehub" status 查看/);
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
  for (const dir of ['.git', '.aws', '.ssh', '.vibehub']) {
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
    for (const dir of ['.git', '.aws', '.ssh', '.vibehub']) {
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
    assert.match(result.stdout, /node ".*vibehub" open/);
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

test('help 正常退出且不输出异常堆栈', async () => {
  const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'help'], {
    cwd: resolve('..'),
    env: { ...process.env },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /node ".*vibehub" bind/);
  assert.equal(result.stderr, '');
});

test('bind 可把真实姓名和公开昵称交给平台且不把真实姓名写入凭证', async () => {
  let received;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'profile-token', camp: { id: 'c1', slug: 'camp', name: '测试营' },
        project: { id: 'p1', title: '作品' },
        user: { id: 'u1', username: 'student', real_name: '真实学员', display_name: '公开昵称' },
        message: '已连接到《测试营》',
      }));
    });
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-profile-home-');
  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'bind', 'CAMP-CODE', '--name', '真实学员', '--nickname', '公开昵称'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(received.real_name, '真实学员');
    assert.equal(received.display_name, '公开昵称');
    const saved = readFileSync(join(home, '.vibehub', 'credentials.json'), 'utf8');
    assert.doesNotMatch(saved, /真实学员/);
    assert.match(saved, /公开昵称/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('重复绑定不同营地后可以列出并切换当前营地', async () => {
  const tokens = new Map([
    ['CAMP-ONE', { token: 'token-one', camp: { id: 'c1', slug: 'camp-one', name: '一号营' }, project: { id: 'p1', title: '作品一' } }],
    ['CAMP-TWO', { token: 'token-two', camp: { id: 'c2', slug: 'camp-two', name: '二号营' }, project: { id: 'p2', title: '作品二' } }],
  ]);
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/skill/bind') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const { code } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const item = tokens.get(code);
        res.writeHead(item ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(item ? { ...item, user: { id: `u-${code}` }, message: `已连接到《${item.camp.name}》` } : { error: { message: '邀请码不存在' } }));
      });
      return;
    }
    req.resume();
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-multicamp-home-');

  try {
    for (const code of tokens.keys()) {
      const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'bind', code], {
        cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
      });
      assert.equal(result.code, 0, result.stderr);
    }

    const listed = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'camps'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /一号营/);
    assert.match(listed.stdout, /二号营/);
    assert.match(listed.stdout, /二号营[^\n]*当前/);

    const switched = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'use', 'camp-one'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.equal(switched.code, 0, switched.stderr);
    assert.match(switched.stdout, /已切换到《一号营》/);

    const saved = JSON.parse(readFileSync(join(home, '.vibehub', 'credentials.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(Object.keys(saved.connections).length, 2);
    assert.equal(saved.connections[saved.active].camp.slug, 'camp-one');
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('旧版单连接凭证会在绑定新营地时迁移并保留', async () => {
  const server = createServer((req, res) => {
    req.resume();
    if (req.method === 'POST' && req.url === '/api/skill/bind') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        token: 'new-token', camp: { id: 'c2', slug: 'new-camp', name: '新营地' },
        project: { id: 'p2', title: '新作品' }, user: { id: 'u2' }, message: '已连接到《新营地》',
      }));
    }
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-legacy-home-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    token: 'old-token', api, camp: { id: 'c1', slug: 'old-camp', name: '旧营地' },
    project: { id: 'p1', title: '旧作品' }, user: { id: 'u1' },
  }));
  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'bind', 'NEW-CAMP'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    assert.equal(result.code, 0, result.stderr);
    const saved = JSON.parse(readFileSync(join(home, '.vibehub', 'credentials.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(Object.keys(saved.connections).length, 2);
    assert.ok(Object.values(saved.connections).some((cred) => cred.token === 'old-token'));
    assert.equal(saved.connections[saved.active].token, 'new-token');
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('损坏的本地凭证会在兑换邀请码前停止', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-corrupt-home-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), '{broken');
  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'bind', 'CAMP-CODE'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    assert.notEqual(result.code, 0);
    assert.equal(requests, 0);
    assert.match(result.stderr, /本地连接信息无法读取/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('同一营地多个作品时 camps 展示唯一连接标识并可精确切换', async () => {
  const home = tempDir('vh-cli-same-camp-home-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2,
    active: 'game-camp:p2',
    connections: {
      'game-camp:p1': { token: 't1', api: 'http://unused', camp: { slug: 'game-camp', name: '游戏营' }, project: { id: 'p1', title: '作品一' } },
      'game-camp:p2': { token: 't2', api: 'http://unused', camp: { slug: 'game-camp', name: '游戏营' }, project: { id: 'p2', title: '作品二' } },
    },
  }));
  const listed = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'camps'], {
    cwd: resolve('..'), env: { ...process.env, HOME: home },
  });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /game-camp:p1/);
  assert.match(listed.stdout, /game-camp:p2/);
  const switched = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'use', 'game-camp:p1'], {
    cwd: resolve('..'), env: { ...process.env, HOME: home },
  });
  assert.equal(switched.code, 0, switched.stderr);
  const saved = JSON.parse(readFileSync(join(home, '.vibehub', 'credentials.json'), 'utf8'));
  assert.equal(saved.active, 'game-camp:p1');
});

test('deploy 的预检和上传固定使用启动时的同一营地连接', async () => {
  const auth = [];
  const server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    req.resume();
    if (req.url === '/api/skill/versions/preflight') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ duplicate: false }));
    }
    if (req.url === '/api/skill/versions') {
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ label: 'v1', preview_url: 'http://works.test/vibehub/_preview/demo/', diagnosis: { status: 'running' }, message: '已提交' }));
    }
    res.writeHead(404).end();
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-deploy-lock-home-');
  const project = tempDir('vh-cli-deploy-lock-project-');
  const bin = tempDir('vh-cli-deploy-lock-bin-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-a', api, camp: { slug: 'camp-a', name: '营地 A' }, project: { id: 'p1' }, local_paths: [realpathSync(project)] },
      'camp-b:p2': { token: 'token-b', api, camp: { slug: 'camp-b', name: '营地 B' }, project: { id: 'p2' } },
    },
  }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { build: 'build' } }));
  writeFileSync(join(project, 'index.html'), '<main>作品</main>');
  mkdirSync(join(project, '.vibehub'));
  writeFileSync(join(project, '.vibehub', 'project.json'), JSON.stringify({
    version: 1, connection_key: 'camp-a:p1', project_id: 'p1',
  }));
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf started > "$BUILD_MARKER"\nsleep 0.2\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const marker = join(tempDir('vh-cli-deploy-lock-marker-'), 'started');
  try {
    const deployment = run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', project], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BUILD_MARKER: marker },
    });
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    assert.ok(existsSync(marker), '构建应已经开始');
    const switched = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'use', 'camp-b'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.equal(switched.code, 0, switched.stderr);
    const result = await deployment;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(auth, ['Bearer token-a', 'Bearer token-a']);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('project create 先落 pending request_id，失败重试复用它并保存目录绑定', async () => {
  const requestIds = [];
  const auth = [];
  let calls = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls += 1;
      auth.push(req.headers.authorization);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requestIds.push(body.request_id);
      assert.deepEqual(Object.keys(body).sort(), ['request_id', 'title']);
      assert.equal(body.title, '第二个作品');
      if (calls === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: '暂时失败' } }));
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'token-new', message: '作品已创建',
        camp: { id: 'c1', slug: 'camp-a', name: '营地 A' },
        project: { id: 'p2', title: '第二个作品' },
      }));
    });
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-create-home-');
  const project = tempDir('vh-cli-create-project-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-old', api, camp: { id: 'c1', slug: 'camp-a', name: '营地 A' }, project: { id: 'p1', title: '第一个作品' }, user: { id: 'u1' } },
      'camp-b:p9': { token: 'token-other', api, camp: { id: 'c2', slug: 'camp-b', name: '营地 B' }, project: { id: 'p9', title: '其他作品' }, user: { id: 'u1' } },
    },
  }));
  try {
    const command = [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'create', '--title', '第二个作品', '--from', 'camp-a:p1', project];
    const first = await run(process.execPath, command, { cwd: resolve('..'), env: { ...process.env, HOME: home } });
    assert.notEqual(first.code, 0);
    const pending = JSON.parse(readFileSync(join(project, '.vibehub', 'project.json'), 'utf8'));
    assert.match(pending.pending_request_id, /^pc_[A-Za-z0-9_-]+$/);

    const switched = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'use', 'camp-b:p9'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.equal(switched.code, 0, switched.stderr);

    const second = await run(process.execPath, command, { cwd: resolve('..'), env: { ...process.env, HOME: home } });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(requestIds, [pending.pending_request_id, pending.pending_request_id]);
    assert.deepEqual(auth, ['Bearer token-old', 'Bearer token-old']);
    assert.deepEqual(JSON.parse(readFileSync(join(project, '.vibehub', 'project.json'), 'utf8')), {
      version: 1, connection_key: 'camp-a:p2', project_id: 'p2',
    });
    const storePath = join(home, '.vibehub', 'credentials.json');
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    assert.equal(saved.active, 'camp-a:p2');
    assert.equal(saved.connections['camp-a:p2'].token, 'token-new');
    assert.deepEqual(saved.connections['camp-a:p2'].local_paths, [realpathSync(project)]);
    if (process.platform !== 'win32') assert.equal(statSync(storePath).mode & 0o777, 0o600);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('project link 只接受完整连接标识并写入本地 git exclude', async () => {
  const home = tempDir('vh-cli-link-home-');
  const project = tempDir('vh-cli-link-project-');
  mkdirSync(join(home, '.vibehub'));
  mkdirSync(join(project, '.git', 'info'), { recursive: true });
  const excludePath = join(project, '.git', 'info', 'exclude');
  writeFileSync(excludePath, '# local ignores\n');
  chmodSync(excludePath, 0o640);
  const excludeInodeBefore = statSync(excludePath).ino;
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 't1', api: 'http://unused', camp: { slug: 'camp-a' }, project: { id: 'p1' } },
      'camp-a:p2': { token: 't2', api: 'http://unused', camp: { slug: 'camp-a' }, project: { id: 'p2' } },
    },
  }));
  const ambiguous = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'link', 'camp-a', project], {
    cwd: resolve('..'), env: { ...process.env, HOME: home },
  });
  assert.notEqual(ambiguous.code, 0);
  assert.equal(existsSync(join(project, '.vibehub')), false);

  const linked = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'link', 'camp-a:p2', project], {
    cwd: resolve('..'), env: { ...process.env, HOME: home },
  });
  assert.equal(linked.code, 0, linked.stderr);
  const bindingText = readFileSync(join(project, '.vibehub', 'project.json'), 'utf8');
  assert.deepEqual(JSON.parse(bindingText), { version: 1, connection_key: 'camp-a:p2', project_id: 'p2' });
  assert.doesNotMatch(bindingText, /t2|token|invite|cookie|real_name/i);
  assert.equal(readFileSync(excludePath, 'utf8'), '# local ignores\n.vibehub/\n');
  if (process.platform !== 'win32') {
    assert.notEqual(statSync(excludePath).ino, excludeInodeBefore, 'exclude 应通过同目录临时文件原子替换');
    assert.equal(statSync(excludePath).mode & 0o777, 0o640);
  }
});

test('deploy 遇到含敏感字段的目录绑定时 fail closed 且不回显秘密', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests += 1; req.resume(); res.writeHead(500).end(); });
  const api = await listen(server);
  const home = tempDir('vh-cli-binding-secret-home-');
  const project = tempDir('vh-cli-binding-secret-project-');
  mkdirSync(join(home, '.vibehub'));
  mkdirSync(join(project, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({ token: 'home-token', api, camp: { slug: 'camp-a' }, project: { id: 'p1' } }));
  writeFileSync(join(project, '.vibehub', 'project.json'), JSON.stringify({ version: 1, connection_key: 'camp-a:p1', project_id: 'p1', token: 'DO-NOT-ECHO' }));
  writeFileSync(join(project, 'index.html'), '<main>作品</main>');
  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', project], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.notEqual(result.code, 0);
    assert.equal(requests, 0);
    assert.match(result.stderr, /目录绑定.*不安全|目录绑定.*损坏/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO-NOT-ECHO/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('deploy 在多连接且目录未绑定时停止，不构建也不回退 active', async () => {
  const home = tempDir('vh-cli-no-fallback-home-');
  const project = tempDir('vh-cli-no-fallback-project-');
  const bin = tempDir('vh-cli-no-fallback-bin-');
  const marker = join(tempDir('vh-cli-no-fallback-marker-'), 'built');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 't1', api: 'http://127.0.0.1:1', camp: { slug: 'camp-a' }, project: { id: 'p1' } },
      'camp-a:p2': { token: 't2', api: 'http://127.0.0.1:1', camp: { slug: 'camp-a' }, project: { id: 'p2' } },
    },
  }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { build: 'build' } }));
  writeFileSync(join(project, 'index.html'), '<main>作品</main>');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf built > "$BUILD_MARKER"\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', project], {
    cwd: resolve('..'), env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BUILD_MARKER: marker },
  });
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(marker), false);
  assert.match(result.stderr, /project link|目录.*绑定/);
});

test('deploy 按目录绑定锁定精确作品凭证，不受 active 切换影响', async () => {
  const auth = [];
  const server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    req.resume();
    res.writeHead(req.url === '/api/skill/versions' ? 201 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/skill/versions'
      ? { label: 'v1', preview_url: 'http://works.test/vibehub/_preview/demo/', diagnosis: { status: 'running' }, message: '已提交' }
      : { duplicate: false }));
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-exact-home-');
  const project = tempDir('vh-cli-exact-project-');
  mkdirSync(join(home, '.vibehub'));
  mkdirSync(join(project, '.vibehub'));
  writeFileSync(join(project, '.vibehub', 'project.json'), JSON.stringify({ version: 1, connection_key: 'camp-a:p2', project_id: 'p2' }));
  writeFileSync(join(project, 'index.html'), '<main>作品二</main>');
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-one', api, camp: { slug: 'camp-a', name: '营地 A' }, project: { id: 'p1', title: '作品一' } },
      'camp-a:p2': { token: 'token-two', api, camp: { slug: 'camp-a', name: '营地 A' }, project: { id: 'p2', title: '作品二' }, local_paths: [realpathSync(project)] },
    },
  }));
  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', project], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(auth, ['Bearer token-two', 'Bearer token-two']);
    assert.match(result.stdout, /营地 A.*作品二|作品二.*营地 A/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('已有正式 binding 但没有本地路径记录时必须显式 link，不静默认领', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests += 1; req.resume(); res.writeHead(500).end(); });
  const api = await listen(server);
  const home = tempDir('vh-cli-empty-path-home-');
  const project = tempDir('vh-cli-empty-path-project-');
  mkdirSync(join(home, '.vibehub'));
  mkdirSync(join(project, '.vibehub'));
  writeFileSync(join(project, '.vibehub', 'project.json'), JSON.stringify({ version: 1, connection_key: 'camp-a:p1', project_id: 'p1' }));
  writeFileSync(join(project, 'index.html'), '<main>作品</main>');
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-a', api, camp: { slug: 'camp-a' }, project: { id: 'p1' }, local_paths: [] },
    },
  }));
  try {
    const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', project], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /project link|复制|另一个目录/);
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('复制已有 binding 到新目录不能直接 deploy，显式 link 后才登记第二个目录', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests += 1; req.resume(); res.writeHead(500).end(); });
  const api = await listen(server);
  const home = tempDir('vh-cli-copy-home-');
  const original = tempDir('vh-cli-copy-original-');
  const copied = tempDir('vh-cli-copy-copied-');
  const bin = tempDir('vh-cli-copy-bin-');
  const marker = join(tempDir('vh-cli-copy-marker-'), 'built');
  for (const dir of [original, copied]) {
    mkdirSync(join(dir, '.vibehub'));
    writeFileSync(join(dir, '.vibehub', 'project.json'), JSON.stringify({ version: 1, connection_key: 'camp-a:p1', project_id: 'p1' }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'build' } }));
    writeFileSync(join(dir, 'index.html'), '<main>作品</main>');
  }
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-a', api, camp: { slug: 'camp-a' }, project: { id: 'p1' }, local_paths: [realpathSync(original)] },
    },
  }));
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf built > "$BUILD_MARKER"\n');
  chmodSync(join(bin, 'npm'), 0o755);
  try {
    const rejected = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', copied], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BUILD_MARKER: marker },
    });
    assert.notEqual(rejected.code, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(requests, 0);
    assert.match(rejected.stderr, /复制|project link|另一个目录/);

    const linked = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'link', 'camp-a:p1', copied], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.equal(linked.code, 0, linked.stderr);
    const saved = JSON.parse(readFileSync(join(home, '.vibehub', 'credentials.json'), 'utf8'));
    assert.deepEqual(saved.connections['camp-a:p1'].local_paths.sort(), [realpathSync(original), realpathSync(copied)].sort());
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('同一连接重复 bind 保留已验证 local_paths，复制 binding 仍 fail closed', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    if (req.url === '/api/skill/bind') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        token: 'token-refreshed', message: '已重新连接',
        camp: { id: 'c1', slug: 'camp-a', name: '营地 A' },
        project: { id: 'p1', title: '作品一' }, user: { id: 'u1' },
      }));
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-rebind-home-');
  const original = tempDir('vh-cli-rebind-original-');
  const copied = tempDir('vh-cli-rebind-copied-');
  for (const dir of [original, copied]) {
    mkdirSync(join(dir, '.vibehub'));
    writeFileSync(join(dir, '.vibehub', 'project.json'), JSON.stringify({ version: 1, connection_key: 'camp-a:p1', project_id: 'p1' }));
    writeFileSync(join(dir, 'index.html'), '<main>作品</main>');
  }
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-old', api, camp: { id: 'c1', slug: 'camp-a' }, project: { id: 'p1' }, local_paths: [realpathSync(original)] },
    },
  }));
  try {
    const rebound = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'bind', 'SAME-CODE'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    assert.equal(rebound.code, 0, rebound.stderr);
    const saved = JSON.parse(readFileSync(join(home, '.vibehub', 'credentials.json'), 'utf8'));
    assert.deepEqual(saved.connections['camp-a:p1'].local_paths, [realpathSync(original)]);
    assert.equal(saved.connections['camp-a:p1'].token, 'token-refreshed');

    const rejected = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'deploy', copied], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /复制|project link|另一个目录/);
    assert.deepEqual(requests, ['/api/skill/bind']);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('bind 联网期间发生的 project link 不会被旧快照覆盖', async () => {
  let bindArrived = false;
  const server = createServer((req, res) => {
    req.resume();
    bindArrived = true;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'token-refreshed', message: '已重新连接',
        camp: { id: 'c1', slug: 'camp-a', name: '营地 A' },
        project: { id: 'p1', title: '作品一' }, user: { id: 'u1' },
      }));
    }, 200);
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-bind-link-race-home-');
  const project = tempDir('vh-cli-bind-link-race-project-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-old', api, camp: { id: 'c1', slug: 'camp-a' }, project: { id: 'p1' }, local_paths: [] },
    },
  }));
  try {
    const binding = run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'bind', 'SAME-CODE'], {
      cwd: resolve('..'), env: { ...process.env, HOME: home, VIBEHUB_API: api },
    });
    const deadline = Date.now() + 2000;
    while (!bindArrived && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    assert.equal(bindArrived, true);
    const linked = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'link', 'camp-a:p1', project], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.equal(linked.code, 0, linked.stderr);
    const rebound = await binding;
    assert.equal(rebound.code, 0, rebound.stderr);
    const saved = JSON.parse(readFileSync(join(home, '.vibehub', 'credentials.json'), 'utf8'));
    assert.deepEqual(saved.connections['camp-a:p1'].local_paths, [realpathSync(project)]);
    assert.equal(saved.connections['camp-a:p1'].token, 'token-refreshed');
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('多连接新目录 project create 必须用 --from 指定完整授权连接', async () => {
  const auth = [];
  const server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    req.resume();
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: 'token-created', camp: { slug: 'camp-b', name: '营地 B' }, project: { id: 'p3', title: '新作品' }, message: '已创建' }));
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-create-from-home-');
  const project = tempDir('vh-cli-create-from-project-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-a', api, camp: { slug: 'camp-a' }, project: { id: 'p1' } },
      'camp-b:p2': { token: 'token-b', api, camp: { slug: 'camp-b' }, project: { id: 'p2' } },
    },
  }));
  try {
    const ambiguous = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'create', '--title', '新作品', project], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.notEqual(ambiguous.code, 0);
    assert.equal(auth.length, 0);
    assert.equal(existsSync(join(project, '.vibehub')), false);
    assert.match(ambiguous.stderr, /--from.*完整连接标识|camps/);

    const created = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'create', '--title', '新作品', '--from', 'camp-b:p2', project], {
      cwd: resolve('..'), env: { ...process.env, HOME: home },
    });
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(auth, ['Bearer token-b']);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('同一目录并发 project create 只创建一个服务端作品', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      const call = calls;
      setTimeout(() => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          token: `token-created-${call}`, message: '已创建',
          camp: { id: 'c1', slug: 'camp-a', name: '营地 A' },
          project: { id: `p-created-${call}`, title: '并发作品' },
        }));
      }, 200);
    });
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-create-lock-home-');
  const project = tempDir('vh-cli-create-lock-project-');
  mkdirSync(join(home, '.vibehub'));
  mkdirSync(join(project, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-a', api, camp: { id: 'c1', slug: 'camp-a' }, project: { id: 'p1' }, local_paths: [] },
    },
  }));
  const command = [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'create', '--title', '并发作品', project];
  try {
    const results = await Promise.all([
      run(process.execPath, command, { cwd: resolve('..'), env: { ...process.env, HOME: home } }),
      run(process.execPath, command, { cwd: resolve('..'), env: { ...process.env, HOME: home } }),
    ]);
    assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => result.code !== 0).length, 1, JSON.stringify(results));
    assert.match(results.find((result) => result.code !== 0).stderr, /正在创建|稍后重试|未完成/);
    assert.equal(calls, 1);
    const binding = JSON.parse(readFileSync(join(project, '.vibehub', 'project.json'), 'utf8'));
    assert.equal(binding.connection_key, 'camp-a:p-created-1');
    assert.equal(existsSync(join(project, '.vibehub', 'project-create.lock')), false);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('进程退出遗留的 project create 锁可安全恢复 pending 请求', async () => {
  const requestIds = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestIds.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).request_id);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'token-recovered', message: '已恢复',
        camp: { id: 'c1', slug: 'camp-a', name: '营地 A' },
        project: { id: 'p2', title: '恢复作品' },
      }));
    });
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-stale-lock-home-');
  const project = tempDir('vh-cli-stale-lock-project-');
  mkdirSync(join(home, '.vibehub'));
  mkdirSync(join(project, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-a', api, camp: { id: 'c1', slug: 'camp-a' }, project: { id: 'p1' }, local_paths: [] },
    },
  }));
  writeFileSync(join(project, '.vibehub', 'project.json'), JSON.stringify({ version: 1, pending_request_id: 'pc_74222876ab08_existing-request' }));
  writeFileSync(join(project, '.vibehub', 'project-create.lock'), JSON.stringify({
    version: 1, pid: process.pid, nonce: 'reused-or-stuck-owner', created_at: 0,
  }));
  try {
    const command = [resolve('..', 'skill', 'bin', 'vibehub'), 'project', 'create', '--title', '恢复作品', project];
    const results = await Promise.all([
      run(process.execPath, command, { cwd: resolve('..'), env: { ...process.env, HOME: home } }),
      run(process.execPath, command, { cwd: resolve('..'), env: { ...process.env, HOME: home } }),
    ]);
    assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
    assert.equal(results.filter((result) => result.code !== 0).length, 1, JSON.stringify(results));
    assert.deepEqual(requestIds, ['pc_74222876ab08_existing-request']);
    assert.equal(existsSync(join(project, '.vibehub', 'project-create.lock')), false);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('status、open、logs 按 cwd binding 使用精确凭证，多连接无 binding 时 fail closed', async () => {
  const auth = [];
  const server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      project: { title: '作品二', publish_status: 'published', live_url: 'https://works.example.test/b/' },
      camp: { name: '营地 A' }, timeline: [], latest_diagnosis: null,
    }));
  });
  const api = await listen(server);
  const home = tempDir('vh-cli-read-binding-home-');
  const project = tempDir('vh-cli-read-binding-project-');
  const unbound = tempDir('vh-cli-read-unbound-');
  const bin = tempDir('vh-cli-read-binding-bin-');
  mkdirSync(join(home, '.vibehub'));
  mkdirSync(join(project, '.vibehub'));
  writeFileSync(join(project, '.vibehub', 'project.json'), JSON.stringify({ version: 1, connection_key: 'camp-a:p2', project_id: 'p2' }));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-one', api, camp: { slug: 'camp-a' }, project: { id: 'p1' }, local_paths: [] },
      'camp-a:p2': { token: 'token-two', api, camp: { slug: 'camp-a' }, project: { id: 'p2' }, local_paths: [realpathSync(project)] },
    },
  }));
  writeFileSync(join(bin, 'open'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'open'), 0o755);
  try {
    for (const command of ['status', 'open', 'logs']) {
      const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), command], {
        cwd: project, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    }
    assert.deepEqual(auth, ['Bearer token-two', 'Bearer token-two', 'Bearer token-two']);

    for (const command of ['status', 'open', 'logs']) {
      const result = await run(process.execPath, [resolve('..', 'skill', 'bin', 'vibehub'), command], {
        cwd: unbound, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.notEqual(result.code, 0, command);
      assert.match(result.stderr, /目录.*绑定|project link/);
    }
    assert.equal(auth.length, 3);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('项目与 Git 元数据中的符号链接或越界 pointer 一律拒绝且不改外部哨兵', { skip: process.platform === 'win32' }, async (t) => {
  const home = tempDir('vh-cli-symlink-home-');
  mkdirSync(join(home, '.vibehub'));
  writeFileSync(join(home, '.vibehub', 'credentials.json'), JSON.stringify({
    version: 2, active: 'camp-a:p1', connections: {
      'camp-a:p1': { token: 'token-a', api: 'http://127.0.0.1:1', camp: { slug: 'camp-a' }, project: { id: 'p1' }, local_paths: [] },
    },
  }));
  const cli = resolve('..', 'skill', 'bin', 'vibehub');
  const link = (project) => run(process.execPath, [cli, 'project', 'link', 'camp-a:p1', project], {
    cwd: resolve('..'), env: { ...process.env, HOME: home },
  });

  await t.test('.vibehub 目录符号链接', async () => {
    const project = tempDir('vh-cli-symlink-binding-dir-');
    const outside = tempDir('vh-cli-symlink-binding-outside-');
    writeFileSync(join(outside, 'project.json'), JSON.stringify({ version: 1, connection_key: 'camp-a:p1', project_id: 'p1' }));
    writeFileSync(join(outside, 'sentinel'), 'unchanged');
    symlinkSync(outside, join(project, '.vibehub'), 'dir');
    const result = await link(project);
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'unchanged');
  });

  await t.test('project.json 文件符号链接', async () => {
    const project = tempDir('vh-cli-symlink-binding-file-');
    const outside = tempDir('vh-cli-symlink-binding-file-outside-');
    mkdirSync(join(project, '.vibehub'));
    const target = join(outside, 'binding.json');
    const original = JSON.stringify({ version: 1, connection_key: 'camp-a:p1', project_id: 'p1' });
    writeFileSync(target, original);
    symlinkSync(target, join(project, '.vibehub', 'project.json'));
    const result = await link(project);
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(target, 'utf8'), original);
  });

  await t.test('.git 目录符号链接', async () => {
    const project = tempDir('vh-cli-symlink-git-dir-');
    const outside = tempDir('vh-cli-symlink-git-dir-outside-');
    mkdirSync(join(outside, 'info'));
    writeFileSync(join(outside, 'info', 'exclude'), 'outside\n');
    symlinkSync(outside, join(project, '.git'), 'dir');
    const result = await link(project);
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(join(outside, 'info', 'exclude'), 'utf8'), 'outside\n');
  });

  await t.test('gitdir pointer 不能指向任意外部目录', async () => {
    const project = tempDir('vh-cli-gitdir-pointer-');
    const outside = tempDir('vh-cli-gitdir-pointer-outside-');
    mkdirSync(join(outside, 'info'));
    writeFileSync(join(outside, 'info', 'exclude'), 'outside\n');
    writeFileSync(join(project, '.git'), `gitdir: ${outside}\n`);
    const result = await link(project);
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(join(outside, 'info', 'exclude'), 'utf8'), 'outside\n');
  });

  await t.test('.git/info 目录符号链接', async () => {
    const project = tempDir('vh-cli-symlink-git-info-');
    const outside = tempDir('vh-cli-symlink-git-info-outside-');
    mkdirSync(join(project, '.git'));
    writeFileSync(join(outside, 'exclude'), 'outside\n');
    symlinkSync(outside, join(project, '.git', 'info'), 'dir');
    const result = await link(project);
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(join(outside, 'exclude'), 'utf8'), 'outside\n');
  });

  await t.test('.git/info/exclude 文件符号链接', async () => {
    const project = tempDir('vh-cli-symlink-git-exclude-');
    const outside = tempDir('vh-cli-symlink-git-exclude-outside-');
    mkdirSync(join(project, '.git', 'info'), { recursive: true });
    const target = join(outside, 'exclude');
    writeFileSync(target, 'outside\n');
    symlinkSync(target, join(project, '.git', 'info', 'exclude'));
    const result = await link(project);
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(target, 'utf8'), 'outside\n');
  });

  await t.test('合法 worktree gitdir backlink 可写 common exclude', async () => {
    const project = tempDir('vh-cli-worktree-project-');
    const common = tempDir('vh-cli-worktree-common-');
    const gitDir = join(common, 'worktrees', 'student');
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(join(common, 'info'));
    writeFileSync(join(project, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, 'gitdir'), `${join(project, '.git')}\n`);
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(common, 'info', 'exclude'), '# common\n');
    const result = await link(project);
    assert.equal(result.code, 0, result.stderr);
    assert.match(readFileSync(join(common, 'info', 'exclude'), 'utf8'), /(?:^|\n)\.vibehub\/(?:\n|$)/);
  });
});
