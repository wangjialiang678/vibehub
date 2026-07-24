import { mkdirSync, symlinkSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/config.js';

/**
 * 原子切换软链：访客要么看到旧版，要么看到新版，绝不会看到 404。
 * 先建临时链再 rename 覆盖（rename 在同一文件系统上是原子的）；
 * 不能用「先删后建」——那中间有个窗口是 404。
 */
export function pointTo(linkPath, targetDir) {
  mkdirSync(join(linkPath, '..'), { recursive: true });
  const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    symlinkSync(targetDir, tmp);
    renameSync(tmp, linkPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export const versionDir = (versionId) => join(paths.versions, versionId);
export const siteLink = (username, slug) => join(paths.sites, username, slug);
export const previewLink = (previewId) => join(paths.previews, previewId);

export function publishVersion({ username, slug, versionId }) {
  const target = versionDir(versionId);
  if (!existsSync(target)) throw new Error(`版本目录不存在: ${versionId}`);
  pointTo(siteLink(username, slug), target);
  return target;
}

export function makePreview({ previewId, versionId }) {
  pointTo(previewLink(previewId), versionDir(versionId));
}
