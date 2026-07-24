import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeExtract, rewriteAbsolutePaths, flattenSingleRoot, UnpackError } from '../src/services/unpack.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'vh-test-'));

function tarball(buildFn) {
  const src = tmp();
  buildFn(src);
  const out = join(tmp(), 'b.tgz');
  execFileSync('tar', ['-czf', out, '-C', src, '.']);
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
  assert.equal(res.fileCount, 2);
});

test('符号链接被拒绝——防止逃逸到版本目录之外', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), 'x');
    symlinkSync('/etc/passwd', join(d, 'evil.txt'));
  });
  const dest = tmp();
  const res = await safeExtract(tgz, dest);
  assert.ok(!existsSync(join(dest, 'evil.txt')), '符号链接不该被解出来');
  assert.ok(res.rejected.some((r) => r.path.includes('evil')), '应记录拒绝原因');
});

test('可执行文件被拒绝', async () => {
  const tgz = tarball((d) => {
    writeFileSync(join(d, 'index.html'), 'x');
    writeFileSync(join(d, 'run.sh'), '#!/bin/sh\necho hi');
  });
  const dest = tmp();
  const res = await safeExtract(tgz, dest);
  assert.ok(!existsSync(join(dest, 'run.sh')));
  assert.ok(res.rejected.some((r) => r.path.includes('run.sh')));
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
