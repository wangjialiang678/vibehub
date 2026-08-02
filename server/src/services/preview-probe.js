import { LIMITS } from '../lib/config.js';
import { redactPreviewClaim } from '../lib/preview-claims.js';
import { lookup } from 'node:dns/promises';

const STATIC_TAGS = new Set(['script', 'img', 'link', 'source', 'video', 'audio', 'iframe', 'object']);

function unknown(reason) {
  return {
    status: 'unknown',
    entry_status: null,
    resource_checked: 0,
    resource_failures: [],
    checked_at: new Date().toISOString(),
    console_errors: { status: 'unknown', items: [], reason },
    screenshot: { status: 'unknown', reason },
    visible_content: { status: 'unknown', reason },
    interactive_elements: { status: 'unknown', reason },
  };
}

function staticRefs(text, base) {
  const refs = [];
  for (const tag of text.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    if (!STATIC_TAGS.has(tag[1].toLowerCase())) continue;
    for (const attr of tag[0].matchAll(/(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) refs.push(attr[1]);
  }
  if (/text\/css/i.test(base.contentType || '')) {
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) refs.push(match[1]);
  }
  return refs;
}

function safeStaticUrl(value, entry, basePath) {
  if (!value || /^(?:data|javascript|mailto|tel):/i.test(value) || value.startsWith('#')) return null;
  let url;
  try { url = new URL(value, entry); } catch { return null; }
  // 页面中的任意 JS 都不能诱导探测器跳出这个预览目录访问内网或元数据地址。
  if (url.origin !== entry.origin || !url.pathname.startsWith(basePath)) return null;
  const claim = entry.searchParams.get('claim');
  if (claim) url.searchParams.set('claim', claim);
  return url;
}

function privateAddress(address) {
  const value = address.toLowerCase();
  if (value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function allowedPreviewOrigin(entry) {
  // 本地开发以 loopback 提供预览，生产环境则拒绝任何解析到内网的预览域名，
  // 以免作品资源诱使探测器接触云元数据或内网服务。
  if (process.env.NODE_ENV !== 'production' || process.env.VIBEHUB_ALLOW_PRIVATE_PREVIEW_PROBE === '1') return true;
  try {
    const addresses = await lookup(entry.hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((row) => !privateAddress(row.address));
  } catch {
    return false;
  }
}

async function readLimited(response, maxBytes) {
  if (!response.body || maxBytes <= 0) {
    response.body?.cancel().catch(() => {});
    return { text: '', bytes: 0 };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { size = maxBytes; break; }
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), bytes: size };
}

async function fetchStatic(url, signal, maxReadBytes) {
  const response = await fetch(url, { signal, redirect: 'manual' });
  const contentType = response.headers.get('content-type') || '';
  const wantsText = /(?:text\/html|text\/css|javascript)/i.test(contentType);
  const read = wantsText && response.ok ? await readLimited(response, maxReadBytes) : { text: '', bytes: 0 };
  if (!wantsText) response.body?.cancel().catch(() => {});
  return { status: response.status, contentType, ...read };
}

/**
 * P0 的低风险真实探测：只做 HTTP 请求，不执行学员 JavaScript。
 * 因而浏览器专属的 console、渲染指标和截图明确返回 unknown，不能拿来加分。
 */
export async function probePreviewHttp(previewUrl) {
  const startedAt = new Date().toISOString();
  let entry;
  try { entry = new URL(previewUrl); } catch { return unknown('预览地址格式不合法'); }
  if (!['http:', 'https:'].includes(entry.protocol)) return unknown('预览地址不是 HTTP(S)');
  if (!(await allowedPreviewOrigin(entry))) return unknown('生产环境拒绝探测内网或云元数据地址');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.probeTimeoutMs);
  const basePath = entry.pathname.endsWith('/') ? entry.pathname : `${entry.pathname}/`;
  const failures = [];
  const seen = new Set();
  const queued = [entry];
  let resourceChecked = 0;
  let remainingReadBytes = LIMITS.probeReadBytes;

  try {
    let entryStatus = null;
    while (queued.length && resourceChecked < LIMITS.probeResources) {
      const target = queued.shift();
      const resourceKey = target && `${target.origin}${target.pathname}`;
      if (!target || seen.has(resourceKey)) continue;
      seen.add(resourceKey);
      const result = await fetchStatic(target, controller.signal, remainingReadBytes);
      remainingReadBytes = Math.max(0, remainingReadBytes - result.bytes);
      resourceChecked += 1;
      if (entryStatus === null) entryStatus = result.status;
      if (result.status < 200 || result.status >= 300) failures.push({ url: redactPreviewClaim(target.href), status: result.status });
      if (!result.text) continue;
      for (const ref of staticRefs(result.text, result)) {
        const next = safeStaticUrl(ref, entry, basePath);
        if (next && !seen.has(next.href)) queued.push(next);
      }
    }
    const okay = entryStatus !== null && entryStatus >= 200 && entryStatus < 300 && failures.length === 0;
    const unavailable = '当前使用 HTTP 探测，不执行学员 JavaScript';
    return {
      status: okay ? 'ok' : 'fail',
      entry_status: entryStatus,
      resource_checked: resourceChecked,
      resource_failures: failures.slice(0, 30),
      checked_at: new Date().toISOString(),
      started_at: startedAt,
      console_errors: { status: 'unknown', items: [], reason: unavailable },
      screenshot: { status: 'unknown', reason: unavailable },
      visible_content: { status: 'unknown', reason: unavailable },
      interactive_elements: { status: 'unknown', reason: unavailable },
    };
  } catch (error) {
    const result = unknown(error?.name === 'AbortError' ? '探测超过 15 秒已停止' : 'HTTP 探测请求失败');
    result.started_at = startedAt;
    return result;
  } finally {
    clearTimeout(timer);
  }
}
