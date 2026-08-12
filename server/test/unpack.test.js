import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { safeExtract, rewriteAbsolutePaths, flattenSingleRoot, UnpackError } from '../src/services/unpack.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'vh-test-'));

function tarball(buildFn) {
  const src = tmp();
  buildFn(src);
  const out = join(tmp(), 'b.tgz');
  execFileSync('tar', ['-czf', out, '-C', src, '.']);
  return out;
}

function tarballWithPath(archivePath) {
  const tgz = tarball((d) => writeFileSync(join(d, 'payload.txt'), 'x'));
  const bytes = gunzipSync(readFileSync(tgz));
  let headerOffset = -1;
  for (let offset = 0; offset < bytes.length; offset += 512) {
    const name = bytes.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/, '');
    if (name.endsWith('payload.txt')) {
      headerOffset = offset;
      break;
    }
  }
  assert.notEqual(headerOffset, -1, 'fixture tar header should be present');
  bytes.fill(0, headerOffset, headerOffset + 100);
  bytes.write(archivePath, headerOffset, 'utf8');
  bytes.fill(0x20, headerOffset + 148, headerOffset + 156);
  let checksum = 0;
  for (let i = headerOffset; i < headerOffset + 512; i += 1) checksum += bytes[i];
  bytes.write(checksum.toString(8).padStart(6, '0'), headerOffset + 148, 6, 'ascii');
  bytes[headerOffset + 154] = 0;
  bytes[headerOffset + 155] = 0x20;
  const out = join(tmp(), 'malicious.tgz');
  writeFileSync(out, gzipSync(bytes));
  return out;
}

test('正常内容能解开', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), '<html><head></head><body>hi</body></html>');
    mkdirSync(join(d, 'assets'));
    writeFileSync(join(d, 'assets', 'a.css'), 'body{color:red}');
  });
  const dest = tmp();
  const res = await safeExtract(tgz, dest);
  assert.ok(existsSync(join(dest, 'index.html')));
  assert.ok(existsSync(join(dest, 'assets', 'a.css')));
  assert.equal(res.fileCount, 4);
});

test('含符号链接的归档整体无效——防止逃逸到版本目录之外', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), 'x');
    symlinkSync('/etc/passwd', join(d, 'evil.txt'));
  });
  const dest = tmp();
  await assert.rejects(
    safeExtract(tgz, dest),
    (error) => error instanceof UnpackError && error.code === 'bundle_invalid',
  );
});

test('含可执行文件的归档整体无效', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), 'x');
    const executable = join(d, 'tool.js');
    writeFileSync(executable, 'console.log("x")');
    chmodSync(executable, 0o755);
  });
  const dest = tmp();
  await assert.rejects(
    safeExtract(tgz, dest),
    (error) => error instanceof UnpackError && error.code === 'bundle_invalid',
  );
});

test('tar 路径穿越会让整个归档无效，而不是只跳过危险条目', async () => {
  const tgz = tarballWithPath('../outside.txt');
  await assert.rejects(
    safeExtract(tgz, tmp()),
    (error) => error instanceof UnpackError && error.code === 'bundle_invalid',
  );
});

test('敏感文件即使被绕过 CLI 打进包也不会落盘，并记录拒绝原因', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), '<main>安全作品</main>');
    writeFileSync(join(d, '.env'), 'API_KEY=sk-test-secret');
    mkdirSync(join(d, 'nested'));
    writeFileSync(join(d, 'nested', '.env.production'), 'TOKEN=secret');
    writeFileSync(join(d, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----');
    mkdirSync(join(d, '.git'));
    writeFileSync(join(d, '.git', 'config'), '[core]');
  });
  const dest = tmp();
  const res = await safeExtract(tgz, dest);
  assert.ok(existsSync(join(dest, 'index.html')));
  assert.ok(!existsSync(join(dest, '.env')));
  assert.ok(!existsSync(join(dest, 'nested', '.env.production')));
  assert.ok(!existsSync(join(dest, 'deploy.pem')));
  assert.ok(!existsSync(join(dest, '.git')));
  const rejected = res.rejected.filter((item) => item.reason === '敏感文件不允许上传');
  assert.ok(rejected.length >= 4);
  assert.ok(rejected.some((item) => item.path.includes('.git')));
});

test('空目录也计入 5000 条目上限', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), 'x');
    for (let i = 0; i <= 5000; i += 1) mkdirSync(join(d, `empty-${i}`));
  });
  await assert.rejects(
    safeExtract(tgz, tmp()),
    (error) => error instanceof UnpackError && error.code === 'too_many_files',
  );
});

test('tar 命中硬限制后立即中止底层输入流并清理 staging', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), 'x');
    writeFileSync(join(d, 'oversized.dat'), randomBytes(20 * 1024 * 1024 + 1));
    writeFileSync(join(d, 'must-not-be-consumed.dat'), randomBytes(8 * 1024 * 1024));
  });
  const destination = tmp();
  let bytesRead = 0;
  const source = createReadStream(tgz, { highWaterMark: 1024 });
  source.on('data', (chunk) => { bytesRead += chunk.length; });

  await assert.rejects(
    safeExtract(tgz, destination, { source }),
    (error) => error instanceof UnpackError && error.code === 'file_too_large',
  );

  assert.ok(bytesRead > 0, '测试输入流必须真实进入解包器');
  assert.ok(bytesRead < readFileSync(tgz).length, '命中限制后不应继续消费完整压缩流');
  assert.equal(existsSync(destination), false, '失败 staging 必须整体清理');
});

test('tar 超过解压缩比例上限会中止并清理 staging', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), 'x');
    writeFileSync(join(d, 'highly-compressed.dat'), Buffer.alloc(2 * 1024 * 1024));
  });
  const destination = tmp();

  await assert.rejects(
    safeExtract(tgz, destination),
    (error) => error instanceof UnpackError && error.code === 'zip_bomb',
  );
  assert.equal(existsSync(destination), false, '压缩炸弹失败 staging 必须整体清理');
});

test('node_modules 不会被解出来', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), 'x');
    mkdirSync(join(d, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'pkg', 'i.js'), 'x');
  });
  const dest = tmp();
  await safeExtract(tgz, dest);
  assert.ok(!existsSync(join(dest, 'node_modules')));
});

test('绝对路径引用被改写成相对路径', () => {
  const d = tmp();
  writeFileSync(join(d, 'index.html'),
    '<html><head><link rel="stylesheet" href="/style.css"></head><body><img src="/img/a.png"></body></html>');
  writeFileSync(join(d, 'style.css'), 'body{background:url(/img/a.png)}');
  mkdirSync(join(d, 'img'));
  writeFileSync(join(d, 'img', 'a.png'), 'x');

  const rewrites = rewriteAbsolutePaths(d, '/vibehub/u/p/');
  const html = readFileSync(join(d, 'index.html'), 'utf8');
  const css = readFileSync(join(d, 'style.css'), 'utf8');

  assert.match(html, /href="\.\/style\.css"/);
  assert.match(html, /src="\.\/img\/a\.png"/);
  assert.match(css, /url\(\.\/img\/a\.png\)/);
  assert.ok(rewrites.length >= 3);
});

test('base 是运行时算的，同一份产物在预览和正式两个路径下都对', () => {
  const d = tmp();
  writeFileSync(join(d, 'index.html'), '<html><head></head><body>x</body></html>');
  rewriteAbsolutePaths(d, '/vibehub/u/p/');
  const html = readFileSync(join(d, 'index.html'), 'utf8');
  // 不能写死路径——同一份产物会在 /vibehub/_preview/<pid>/ 和 /vibehub/<u>/<p>/ 两处被访问
  assert.doesNotMatch(html, /<base href="\/vibehub\/u\/p\/">/);
  assert.match(html, /location\.pathname/);
});

test('大写属性名 / 等号空格的绝对引用也会被改写成相对路径（与诊断采集正则一致）', () => {
  const d = tmp();
  // 包内确实有 main.css，但首页用大写 HREF 写绝对路径。若不改写，运行时会请求域名根 /main.css → 404，
  // 而诊断看包内有同名文件误判「不缺失」。改写正则必须大小写不敏感且允许 = 两侧空格。
  writeFileSync(join(d, 'main.css'), 'body{}');
  writeFileSync(join(d, 'index.html'), '<link HREF = "/main.css"><script SRC="/main.css"></script>');
  rewriteAbsolutePaths(d, '/vibehub/u/p/');
  const html = readFileSync(join(d, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /["']\/main\.css["']/, '不应残留根绝对路径');
  assert.match(html, /HREF\s*=\s*["']\.\/main\.css["']/i);
});

test('指向包外的绝对路径不动它——那可能是有意的外链', () => {
  const d = tmp();
  writeFileSync(join(d, 'index.html'), '<a href="/about">关于</a><img src="https://x.com/a.png">');
  rewriteAbsolutePaths(d, '/vibehub/u/p/');
  const html = readFileSync(join(d, 'index.html'), 'utf8');
  assert.match(html, /href="\/about"/);
  assert.match(html, /src="https:\/\/x\.com\/a\.png"/);
});

test('内容打在单层子目录里时会被提上来', () => {
  const d = tmp();
  mkdirSync(join(d, 'dist'));
  writeFileSync(join(d, 'dist', 'index.html'), 'x');
  writeFileSync(join(d, 'dist', 'a.js'), 'x');
  assert.equal(flattenSingleRoot(d), true);
  assert.ok(existsSync(join(d, 'index.html')));
  assert.ok(existsSync(join(d, 'a.js')));
});
