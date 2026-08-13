#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const EXPECTED_FILES = Object.freeze([
  'AGENTS.md',
  'SKILL.md',
  'agents/openai.yaml',
  'bin/install.mjs',
  'bin/vibehub',
  'distribution-files.mjs',
  'lib/platform.mjs',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORWARDED_VALUE_OPTIONS = new Set(['--home', '--targets', '--dir']);
const FORWARDED_FLAG_OPTIONS = new Set(['--help', '-h']);

function parseArgs(args) {
  let baseUrlValue = null;
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--base-url') {
      if (baseUrlValue !== null) throw new Error('在线安装器不认识的参数。');
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('必须提供 --base-url。');
      baseUrlValue = value;
    } else if (FORWARDED_VALUE_OPTIONS.has(option)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('在线安装器参数不完整。');
      forwarded.push(option, value);
    } else if (FORWARDED_FLAG_OPTIONS.has(option)) {
      forwarded.push(option);
    } else {
      throw new Error('在线安装器不认识的参数。');
    }
  }
  if (baseUrlValue === null) throw new Error('必须提供 --base-url。');
  return { baseUrl: validateBaseUrl(baseUrlValue), forwarded };
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('安装来源地址不安全。');
  }
  const localTestHost = process.env.NODE_ENV === 'test'
    && url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (
    (url.protocol !== 'https:' && !localTestHost)
    || url.username
    || url.password
    || url.hash
    || url.search
    || !url.pathname.endsWith('/')
  ) {
    throw new Error('安装来源地址不安全。');
  }
  return url;
}

async function fetchWithoutRedirect(url, failureMessage) {
  let response;
  try {
    response = await fetch(url, { redirect: 'manual' });
  } catch {
    throw new Error(failureMessage);
  }
  if (REDIRECT_STATUSES.has(response.status)) throw new Error(`${failureMessage.replace(/。$/, '')}：禁止跳转。`);
  if (!response.ok) throw new Error(failureMessage);
  return response;
}

async function checkedContentLength(response, limit, tooLargeMessage) {
  const header = response.headers.get('content-length');
  if (header === null) return;
  if (!/^\d+$/.test(header)) throw new Error(tooLargeMessage);
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes) || bytes > limit) {
    try {
      await response.body?.cancel();
    } catch {
      // The fixed size-limit error below is more useful than a transport detail.
    }
    throw new Error(tooLargeMessage);
  }
}

async function readResponse(response, limit, messages) {
  await checkedContentLength(response, limit, messages.tooLarge);
  if (!response.body) throw new Error(messages.incomplete);
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw new Error(messages.tooLarge);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof Error && error.message === messages.tooLarge) throw error;
    throw new Error(messages.incomplete);
  }
  return Buffer.concat(chunks, bytes);
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('安装清单不安全。');
  }
  if (
    value.schema_version !== 1
    || typeof value.skill_version !== 'string'
    || !/^\d+\.\d+\.\d+$/.test(value.skill_version)
    || !Array.isArray(value.files)
  ) {
    throw new Error('安装清单不安全。');
  }

  const entries = new Map();
  for (const entry of value.files) {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || typeof entry.path !== 'string'
      || entries.has(entry.path)
      || !EXPECTED_FILES.includes(entry.path)
      || !Number.isInteger(entry.bytes)
      || entry.bytes < 1
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error('安装清单不安全。');
    }
    if (entry.bytes > MAX_FILE_BYTES) throw new Error('安装清单中的文件大小超过限制。');
    entries.set(entry.path, entry);
  }
  if (entries.size !== EXPECTED_FILES.length || EXPECTED_FILES.some((path) => !entries.has(path))) {
    throw new Error('安装清单不安全。');
  }
  return EXPECTED_FILES.map((path) => entries.get(path));
}

async function loadManifest(baseUrl) {
  const response = await fetchWithoutRedirect(new URL('manifest.json', baseUrl), '获取安装清单失败。');
  const body = await readResponse(response, MAX_MANIFEST_BYTES, {
    tooLarge: '安装清单超过大小限制。',
    incomplete: '获取安装清单失败。',
  });
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('安装清单不安全。');
  }
  return validateManifest(value);
}

async function downloadFile(baseUrl, entry, skillRoot) {
  const response = await fetchWithoutRedirect(
    new URL(`files/${entry.path}`, baseUrl),
    '下载文件失败或内容不完整。',
  );
  const body = await readResponse(response, entry.bytes, {
    tooLarge: '下载文件超过大小限制。',
    incomplete: '下载文件失败或内容不完整。',
  });
  if (body.byteLength !== entry.bytes) throw new Error('下载内容与清单不符。');
  const actualHash = createHash('sha256').update(body).digest('hex');
  if (actualHash !== entry.sha256) throw new Error('Skill 文件完整性校验失败。');
  const destination = join(skillRoot, ...entry.path.split('/'));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, body, { mode: entry.path === 'bin/vibehub' ? 0o755 : 0o644 });
}

function invokeInstaller(skillRoot, forwarded) {
  const installer = join(skillRoot, 'bin', 'install.mjs');
  const child = spawnSync(process.execPath, [installer, ...forwarded], {
    stdio: 'inherit',
    shell: false,
  });
  if (child.error || child.signal || child.status !== 0) {
    throw new Error('本地安装没有完成，请按上方提示检查后重试。');
  }
}

let downloadRoot = null;
try {
  const { baseUrl, forwarded } = parseArgs(process.argv.slice(2));
  const manifestFiles = await loadManifest(baseUrl);
  downloadRoot = mkdtempSync(join(tmpdir(), 'vibehub-skill-download-'));
  const skillRoot = join(downloadRoot, 'skill');
  for (const entry of manifestFiles) await downloadFile(baseUrl, entry, skillRoot);
  invokeInstaller(skillRoot, forwarded);
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : '在线安装失败，请稍后重试。'}`);
  process.exitCode = 1;
} finally {
  if (downloadRoot) {
    try {
      rmSync(downloadRoot, { recursive: true, force: true });
    } catch {
      console.error('✗ 下载临时文件未能自动清理，请联系老师或技术支持。');
      process.exitCode = 1;
    }
  }
}
