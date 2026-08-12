import { closeSync, copyFileSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { LIMITS } from '../lib/config.js';
import { safeExtract, safeExtractZip, UnpackError } from './unpack.js';

export class UploadFormatError extends Error {
  constructor(message, hint) {
    super(message);
    this.code = 'upload_format_invalid';
    this.hint = hint;
  }
}

export async function normalizeUpload({ source, filename, staging }) {
  const normalizedFilename = String(filename).toLowerCase();
  const extension = extname(normalizedFilename);
  if (extension === '.html' || extension === '.htm') {
    const totalBytes = statSync(source).size;
    if (totalBytes > LIMITS.singleFileBytes) {
      throw new UnpackError('file_too_large',
        `HTML 文件超过 ${Math.round(LIMITS.singleFileBytes / 1024 / 1024)} MB 的单文件上限`,
        '请压缩图片、音频或视频后再提交');
    }
    if (totalBytes > LIMITS.unpackedBytes) {
      throw new UnpackError('bundle_too_large', 'HTML 文件太大了', '请压缩页面资源后再提交');
    }
    mkdirSync(staging, { recursive: true });
    copyFileSync(source, join(staging, 'index.html'));
    return {
      format: 'html',
      totalBytes,
      fileCount: 1,
      rejected: [],
    };
  }

  const header = Buffer.alloc(4);
  const fd = openSync(source, 'r');
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (header[0] === 0x50 && header[1] === 0x4b) {
    return { format: 'zip', ...await safeExtractZip(source, staging) };
  }
  const tarGzExtension = normalizedFilename.endsWith('.tar.gz') || normalizedFilename.endsWith('.tgz');
  if (tarGzExtension && header[0] === 0x1f && header[1] === 0x8b) {
    return { format: 'tar.gz', ...await safeExtract(source, staging) };
  }

  throw new UploadFormatError(
    '不支持这种文件格式',
    '请提交单个 HTML 文件、ZIP 压缩包或 tar.gz 压缩包',
  );
}
