import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
      'camp-a:p1': { token: 'token-a', api, camp: { slug: 'camp-a', name: '营地 A' }, project: { id: 'p1' } },
      'camp-b:p2': { token: 'token-b', api, camp: { slug: 'camp-b', name: '营地 B' }, project: { id: 'p2' } },
    },
  }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { build: 'build' } }));
  writeFileSync(join(project, 'index.html'), '<main>作品</main>');
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
