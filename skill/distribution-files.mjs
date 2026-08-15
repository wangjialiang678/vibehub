import { posix, win32 } from 'node:path';

export const SKILL_VERSION = '1.0.1';

export function assertSafeDistributionPath(filePath) {
  const segments = typeof filePath === 'string' ? filePath.split('/') : [];
  if (
    typeof filePath !== 'string'
    || !/^[A-Za-z0-9._/-]+$/.test(filePath)
    || posix.isAbsolute(filePath)
    || win32.isAbsolute(filePath)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe distribution path: ${filePath}`);
  }
  return filePath;
}

export const DISTRIBUTION_FILES = Object.freeze([
  'AGENTS.md',
  'SKILL.md',
  'agents/openai.yaml',
  'bin/install.mjs',
  'bin/vibehub',
  'distribution-files.mjs',
  'lib/platform.mjs',
].map(assertSafeDistributionPath));
