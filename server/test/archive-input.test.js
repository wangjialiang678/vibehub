import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';

const tmp = () => mkdtempSync(join(tmpdir(), 'vh-archive-input-'));

function zipFile(entries, filename = 'bundle.zip') {
  const source = join(tmp(), filename);
  writeFileSync(source, zipSync(entries));
  return source;
}

function tarGzFile(filename = 'bundle.tgz') {
  const sourceDir = tmp();
  writeFileSync(join(sourceDir, 'index.html'), '<main>TAR</main>');
  const source = join(tmp(), filename);
  execFileSync('tar', ['-czf', source, '-C', sourceDir, '.']);
  return source;
}

test('single HTML upload becomes staging/index.html', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = join(tmp(), 'landing.HTML');
  const staging = tmp();
  writeFileSync(source, '<main>Hello</main>');

  const result = await normalizeUpload({ source, filename: 'landing.HTML', staging });

  assert.deepEqual(result, {
    format: 'html',
    totalBytes: 18,
    fileCount: 1,
    rejected: [],
  });
  assert.equal(readFileSync(join(staging, 'index.html'), 'utf8'), '<main>Hello</main>');
});

test('ZIP upload is recognized by its PK header and extracted', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = zipFile({
    'index.html': strToU8('<main>ZIP</main>'),
    'assets/site.css': strToU8('body{}'),
  }, 'browser-upload.bin');
  const staging = tmp();

  const result = await normalizeUpload({ source, filename: 'browser-upload.bin', staging });

  assert.equal(result.format, 'zip');
  assert.equal(result.totalBytes, 22);
  assert.equal(result.fileCount, 2);
  assert.deepEqual(result.rejected, []);
  assert.equal(readFileSync(join(staging, 'index.html'), 'utf8'), '<main>ZIP</main>');
  assert.equal(readFileSync(join(staging, 'assets', 'site.css'), 'utf8'), 'body{}');
});

test('ZIP traversal makes the entire upload invalid', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = zipFile({
    'index.html': strToU8('safe'),
    '../outside.txt': strToU8('escaped'),
  });
  const staging = tmp();
  const outside = join(staging, '..', 'outside.txt');

  await assert.rejects(
    normalizeUpload({ source, filename: 'bundle.zip', staging }),
    (error) => error.code === 'bundle_invalid',
  );
  assert.equal(existsSync(outside), false);
});

test('ZIP sensitive paths are filtered and harmless metadata is skipped', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = zipFile({
    'index.html': strToU8('safe'),
    '.env': strToU8('TOKEN=secret'),
    'nested/.ssh/id_ed25519': strToU8('secret'),
    '__MACOSX/._index.html': strToU8('metadata'),
    'node_modules/pkg/index.js': strToU8('noise'),
    'my..notes.txt': strToU8('allowed'),
  });
  const staging = tmp();

  const result = await normalizeUpload({ source, filename: 'bundle.zip', staging });

  assert.equal(existsSync(join(staging, '.env')), false);
  assert.equal(existsSync(join(staging, 'nested', '.ssh')), false);
  assert.equal(existsSync(join(staging, '__MACOSX')), false);
  assert.equal(existsSync(join(staging, 'node_modules')), false);
  assert.equal(readFileSync(join(staging, 'my..notes.txt'), 'utf8'), 'allowed');
  assert.ok(result.rejected.some((item) => item.path === '.env'));
  assert.ok(result.rejected.some((item) => item.path.includes('.ssh')));
});

test('ZIP sensitive executable entries are filtered and recorded before executable rejection', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = zipFile({
    'index.html': strToU8('safe'),
    '.env': [strToU8('TOKEN=secret'), { os: 3, attrs: 0o100755 << 16 }],
    '.git/hooks/pre-commit': [strToU8('#!/bin/sh'), { os: 3, attrs: 0o100755 << 16 }],
  });
  const staging = tmp();

  const result = await normalizeUpload({ source, filename: 'bundle.zip', staging });

  assert.equal(existsSync(join(staging, '.env')), false);
  assert.equal(existsSync(join(staging, '.git')), false);
  assert.ok(result.rejected.some((item) => item.path === '.env'));
  assert.ok(result.rejected.some((item) => item.path === '.git/hooks/pre-commit'));
});

test('ZIP filtered entries still consume the file-count budget', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const { LIMITS } = await import('../src/lib/config.js');
  const originalLimit = LIMITS.fileCount;
  const source = zipFile({
    'index.html': strToU8('safe'),
    'node_modules/a.js': strToU8('a'),
    'node_modules/b.js': strToU8('b'),
  });

  LIMITS.fileCount = 2;
  try {
    await assert.rejects(
      normalizeUpload({ source, filename: 'too-many-filtered.zip', staging: tmp() }),
      (error) => error.code === 'too_many_files',
    );
  } finally {
    LIMITS.fileCount = originalLimit;
  }
});

test('ZIP filtered entries still consume unpacked-size and compression-ratio budgets', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const { LIMITS } = await import('../src/lib/config.js');
  const originalLimit = LIMITS.unpackedBytes;
  const sizeSource = zipFile({
    'node_modules/a.dat': strToU8('123456'),
    'node_modules/b.dat': strToU8('abcdef'),
  });
  const ratioSource = zipFile({
    'node_modules/highly-compressible.dat': new Uint8Array(1024 * 1024),
  });

  LIMITS.unpackedBytes = 10;
  try {
    await assert.rejects(
      normalizeUpload({ source: sizeSource, filename: 'filtered-size.zip', staging: tmp() }),
      (error) => error.code === 'bundle_too_large',
    );
  } finally {
    LIMITS.unpackedBytes = originalLimit;
  }
  await assert.rejects(
    normalizeUpload({ source: ratioSource, filename: 'filtered-ratio.zip', staging: tmp() }),
    (error) => error.code === 'zip_bomb',
  );
});

test('ZIP rejected diagnostics are capped while all sensitive entries remain filtered', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const entries = { 'index.html': strToU8('safe') };
  for (let i = 0; i < 80; i += 1) entries[`.env.${i}`] = strToU8(`SECRET_${i}=value`);
  const staging = tmp();

  const result = await normalizeUpload({
    source: zipFile(entries), filename: 'many-sensitive.zip', staging,
  });

  assert.equal(result.rejected.length, 50);
  assert.equal(existsSync(join(staging, '.env.79')), false);
});

test('ZIP executable node_modules and macOS metadata entries are skipped before executable rejection', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = zipFile({
    'index.html': strToU8('safe'),
    'node_modules/pkg/cli.js': [strToU8('#!/usr/bin/env node'), { os: 3, attrs: 0o100755 << 16 }],
    '__MACOSX/._index.html': [strToU8('metadata'), { os: 3, attrs: 0o100755 << 16 }],
  });
  const staging = tmp();

  const result = await normalizeUpload({ source, filename: 'bundle.zip', staging });

  assert.equal(result.format, 'zip');
  assert.equal(existsSync(join(staging, 'node_modules')), false);
  assert.equal(existsSync(join(staging, '__MACOSX')), false);
});

test('ZIP entry larger than the single-file limit rejects the bundle before extraction', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = zipFile({
    'index.html': strToU8('safe'),
    'oversized.dat': new Uint8Array(20 * 1024 * 1024 + 1),
  });
  const staging = tmp();

  await assert.rejects(
    normalizeUpload({ source, filename: 'bundle.zip', staging }),
    (error) => error.code === 'file_too_large',
  );
  assert.equal(existsSync(join(staging, 'oversized.dat')), false);
});

test('single HTML larger than the single-file limit is rejected without writing staging', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = join(tmp(), 'oversized.html');
  const staging = tmp();
  writeFileSync(source, Buffer.alloc(20 * 1024 * 1024 + 1, 0x20));

  await assert.rejects(
    normalizeUpload({ source, filename: 'oversized.html', staging }),
    (error) => error.code === 'file_too_large',
  );
  assert.equal(existsSync(join(staging, 'index.html')), false);
});

test('ZIP exceeding the 100:1 decompression ratio is rejected as a zip bomb', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = zipFile({ 'highly-compressible.txt': new Uint8Array(10 * 1024 * 1024) });
  const staging = tmp();

  await assert.rejects(
    normalizeUpload({ source, filename: 'bomb.zip', staging }),
    (error) => error.code === 'zip_bomb' && /压缩比/.test(error.message),
  );
  assert.equal(existsSync(join(staging, 'highly-compressible.txt')), false);
});

test('ZIP failure removes files extracted before a later dangerous entry', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const source = zipFile({
    'index.html': strToU8('was written first'),
    'later.sh': strToU8('#!/bin/sh'),
  });
  const staging = tmp();

  await assert.rejects(
    normalizeUpload({ source, filename: 'partial.zip', staging }),
    (error) => error.code === 'bundle_invalid',
  );
  assert.equal(existsSync(join(staging, 'index.html')), false);
  assert.equal(existsSync(join(staging, 'later.sh')), false);
});

test('ZIP executable and special Unix entries make the entire upload invalid', async () => {
  const { normalizeUpload } = await import('../src/services/archive-input.js');
  const executable = zipFile({
    'index.html': strToU8('safe'),
    'run.js': [strToU8('console.log(1)'), { os: 3, attrs: 0o100755 << 16 }],
  });
  const special = zipFile({
    'index.html': strToU8('safe'),
    'link.txt': [strToU8('index.html'), { os: 3, attrs: 0o120777 << 16 }],
  });

  await assert.rejects(
    normalizeUpload({ source: executable, filename: 'executable.zip', staging: tmp() }),
    (error) => error.code === 'bundle_invalid',
  );
  await assert.rejects(
    normalizeUpload({ source: special, filename: 'special.zip', staging: tmp() }),
    (error) => error.code === 'bundle_invalid',
  );
});

test('tar.gz upload requires both a gzip header and tar.gz/tgz extension', async () => {
  const { normalizeUpload, UploadFormatError } = await import('../src/services/archive-input.js');
  const valid = tarGzFile('bundle.tgz');
  const staging = tmp();

  const result = await normalizeUpload({ source: valid, filename: 'bundle.tgz', staging });

  assert.equal(result.format, 'tar.gz');
  assert.equal(readFileSync(join(staging, 'index.html'), 'utf8'), '<main>TAR</main>');

  const gzipWrongExtension = join(tmp(), 'bundle.bin');
  writeFileSync(gzipWrongExtension, gzipSync('not a tar archive'));
  await assert.rejects(
    normalizeUpload({ source: gzipWrongExtension, filename: 'bundle.bin', staging: tmp() }),
    (error) => error instanceof UploadFormatError,
  );

  const extensionWrongHeader = join(tmp(), 'bundle.tgz');
  writeFileSync(extensionWrongHeader, 'plain text');
  await assert.rejects(
    normalizeUpload({ source: extensionWrongHeader, filename: 'bundle.tgz', staging: tmp() }),
    (error) => error instanceof UploadFormatError,
  );
});

test('a .zip filename without a PK header is rejected with a human-readable format error', async () => {
  const { normalizeUpload, UploadFormatError } = await import('../src/services/archive-input.js');
  const source = join(tmp(), 'fake.zip');
  writeFileSync(source, 'this is not a zip');

  await assert.rejects(
    normalizeUpload({ source, filename: 'fake.zip', staging: tmp() }),
    (error) => error instanceof UploadFormatError
      && /HTML|ZIP|tar\.gz/.test(`${error.message} ${error.hint}`),
  );
});
