import * as tar from 'tar';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { LIMITS } from '../lib/config.js';

export class UnpackError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}

const BANNED_EXT = new Set(['.sh', '.bash', '.zsh', '.exe', '.dll', '.so', '.dylib', '.bin', '.app', '.command']);

/**
 * 安全解包学员上传的 tar.gz。
 * 学员产物是 AI 生成的不可信输入——这里的每一条检查都不能省。
 */
export async function safeExtract(tgzPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  let totalBytes = 0;
  let fileCount = 0;
  const rejected = [];

  await tar.x({
    file: tgzPath,
    cwd: destDir,
    strip: 0,
    // node-tar 默认就会剥掉绝对路径与 ..，这里再显式拦一道并记录
    preservePaths: false,
    filter: (path, entry) => {
      // 只要普通文件和目录，symlink / hardlink / 设备文件一律拒绝（防逃逸）
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        rejected.push({ path, reason: `不支持的条目类型 ${entry.type}` });
        return false;
      }
      if (path.startsWith('/') || path.includes('..')) {
        rejected.push({ path, reason: '路径不合法' });
        return false;
      }
      // 跳过打包时应该被排除但漏网的目录
      if (/(^|\/)(node_modules|\.git)(\/|$)/.test(path)) return false;
      // macOS 的 tar 会给每个文件附带一份 AppleDouble（`._xxx`）存扩展属性，
      // 还有 .DS_Store 和 __MACOSX/。这些对网页毫无意义，会污染文件数统计。
      if (/(^|\/)(\._[^/]*|\.DS_Store)$/.test(path)) return false;
      if (/(^|\/)__MACOSX(\/|$)/.test(path)) return false;

      if (entry.type === 'File') {
        if (entry.size > LIMITS.singleFileBytes) {
          throw new UnpackError('file_too_large',
            `文件 ${path} 超过 ${Math.round(LIMITS.singleFileBytes / 1024 / 1024)} MB 的单文件上限`,
            '大的图片、音频、视频建议用平台的文件上传接口，不要打进网页包里');
        }
        if (BANNED_EXT.has(extname(path).toLowerCase())) {
          rejected.push({ path, reason: '可执行文件不允许上传' });
          return false;
        }
        totalBytes += entry.size;
        fileCount += 1;
        if (totalBytes > LIMITS.unpackedBytes) {
          throw new UnpackError('bundle_too_large', '解压后的内容太大了',
            '把大文件挪出网页目录，或用平台的文件上传接口');
        }
        if (fileCount > LIMITS.fileCount) {
          throw new UnpackError('too_many_files', `文件数超过 ${LIMITS.fileCount} 个上限`,
            '检查一下是不是把 node_modules 之类的目录打进去了');
        }
      }
      return true;
    },
  });

  return { totalBytes, fileCount, rejected };
}

/** 递归列出目录下所有文件的相对路径 */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, base));
    else if (st.isFile()) out.push(relative(base, p));
  }
  return out;
}

/**
 * 有些学员的 AI 会把内容打进一层子目录（如 dist/ 或 项目名/）。
 * 如果根目录没有 index.html，但恰好只有一个子目录且里面有 index.html，就把它提上来。
 */
export function flattenSingleRoot(dir) {
  if (existsSync(join(dir, 'index.html'))) return false;
  const entries = readdirSync(dir);
  if (entries.length !== 1) return false;
  const inner = join(dir, entries[0]);
  if (!statSync(inner).isDirectory()) return false;
  if (!existsSync(join(inner, 'index.html'))) return false;
  for (const name of readdirSync(inner)) {
    renameSync(join(inner, name), join(dir, `__tmp_${name}`));
  }
  rmSync(inner, { recursive: true, force: true });
  for (const name of readdirSync(dir)) {
    if (name.startsWith('__tmp_')) renameSync(join(dir, name), join(dir, name.slice(6)));
  }
  return true;
}

/**
 * 决策 2 是路径式网址，作品跑在子目录下。
 * AI 很爱生成 `/style.css` 这种绝对路径，在子目录下必然 404。
 * 这里做两件事：给 HTML 注入 <base>，并把本地绝对路径引用改成相对路径。
 * 所有改动都记录下来返回给学员看——不偷偷改用户的东西。
 */
export function rewriteAbsolutePaths(dir, basePath) {
  const rewrites = [];
  const files = listFiles(dir);
  const localTargets = new Set(files.map((f) => '/' + f.split('\\').join('/')));

  const isLocal = (url) => {
    if (!url.startsWith('/') || url.startsWith('//')) return false;
    const clean = url.split('?')[0].split('#')[0];
    return localTargets.has(clean) || localTargets.has(clean.replace(/\/$/, '/index.html'));
  };

  for (const rel of files) {
    const ext = extname(rel).toLowerCase();
    if (!['.html', '.htm', '.css', '.js', '.mjs'].includes(ext)) continue;
    const full = join(dir, rel);
    let text;
    try { text = readFileSync(full, 'utf8'); } catch { continue; }
    const before = text;
    const depth = rel.split('/').length - 1;
    const up = depth === 0 ? './' : '../'.repeat(depth);

    // href="/x" src="/x" url(/x) —— 只改指向包内确实存在的文件的那些
    text = text.replace(/(href|src)=("|')(\/[^"']*)\2/g, (m, attr, q, url) => {
      if (!isLocal(url)) return m;
      const fixed = up + url.slice(1);
      rewrites.push({ file: rel, from: url, to: fixed });
      return `${attr}=${q}${fixed}${q}`;
    });
    text = text.replace(/url\(\s*("|'|)(\/[^"')]*)\1\s*\)/g, (m, q, url) => {
      if (!isLocal(url)) return m;
      const fixed = up + url.slice(1);
      rewrites.push({ file: rel, from: url, to: fixed });
      return `url(${q}${fixed}${q})`;
    });

    // HTML 注入 <base>，兜住运行时动态拼出来的绝对路径。
    // 注意：同一份版本产物会在两个路径下被访问——预览 /vibehub/_preview/<pid>/
    // 和正式 /vibehub/<user>/<project>/。写死任一个，另一个就会解析到错误的地址。
    // 所以用 document.write 在解析期按 location 动态写入，两种路径都正确。
    if (['.html', '.htm'].includes(ext) && !/<base\s/i.test(text) && !/data-vibehub-base/.test(text)) {
      const snippet = `<script data-vibehub-base>document.write('<base href="'+location.pathname.replace(/[^/]*$/,'')+'">')</script>`;
      if (/<head[^>]*>/i.test(text)) {
        text = text.replace(/<head([^>]*)>/i, `<head$1>\n${snippet}`);
        rewrites.push({ file: rel, from: '(无 base)', to: '按当前地址动态设置 <base>' });
      }
    }
    if (text !== before) writeFileSync(full, text, 'utf8');
  }
  return rewrites;
}

/** 在 HTML 里注入平台 SDK，学员作品可直接用 vibehub.* */
export function injectSdk(dir, sdkSrc) {
  for (const rel of listFiles(dir)) {
    if (!['.html', '.htm'].includes(extname(rel).toLowerCase())) continue;
    const full = join(dir, rel);
    let text = readFileSync(full, 'utf8');
    if (text.includes('vibehub-sdk')) continue;
    const tag = `<script src="${sdkSrc}" data-vibehub-sdk></script>`;
    if (/<\/head>/i.test(text)) text = text.replace(/<\/head>/i, `${tag}\n</head>`);
    else if (/<body[^>]*>/i.test(text)) text = text.replace(/<body([^>]*)>/i, `<body$1>\n${tag}`);
    else text = tag + '\n' + text;
    writeFileSync(full, text, 'utf8');
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
