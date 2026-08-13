#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeDistributionPath,
  DISTRIBUTION_FILES,
  SKILL_VERSION,
} from '../distribution-files.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function canonicalizeProposedPath(filePath) {
  const missingParts = [];
  let existingAncestor = filePath;
  while (!existsSync(existingAncestor)) {
    missingParts.unshift(basename(existingAncestor));
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingParts);
}

function parseOutput(args) {
  if (args.length !== 2 || args[0] !== '--out' || !args[1] || args[1].startsWith('--')) {
    throw new Error('用法：node skill/scripts/build-distribution.mjs --out <目录>');
  }
  const output = resolve(args[1]);
  const canonicalOutput = canonicalizeProposedPath(output);
  const canonicalSkillRoot = realpathSync(skillRoot);
  const skillFromOutput = relative(canonicalOutput, canonicalSkillRoot);
  const outputFromSkill = relative(canonicalSkillRoot, canonicalOutput);
  const outputContainsSkill = skillFromOutput === ''
    || (!skillFromOutput.startsWith('..') && !isAbsolute(skillFromOutput));
  const outputIsInsideSkill = outputFromSkill === ''
    || (!outputFromSkill.startsWith('..') && !isAbsolute(outputFromSkill));
  if (canonicalOutput === parse(canonicalOutput).root || outputContainsSkill || outputIsInsideSkill) {
    throw new Error(`拒绝清空不安全的输出目录：${output}`);
  }
  return output;
}

function writeBootstrap(output) {
  const destination = join(output, 'install.mjs');
  const source = join(skillRoot, 'bootstrap', 'install.mjs');
  if (!lstatSync(source).isFile()) {
    throw new Error('在线安装器源文件不是普通文件。');
  }
  copyFileSync(source, destination);
  if (process.platform !== 'win32') chmodSync(destination, 0o755);
}

function copyDistributionFiles(output) {
  return [...DISTRIBUTION_FILES]
    .map(assertSafeDistributionPath)
    .sort()
    .map((filePath) => {
      const source = join(skillRoot, filePath);
      if (!lstatSync(source).isFile()) {
        throw new Error(`分发源文件不是普通文件：${filePath}`);
      }
      const destination = join(output, 'files', filePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      const content = readFileSync(destination);
      return {
        path: filePath,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
    });
}

try {
  const output = parseOutput(process.argv.slice(2));
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeBootstrap(output);
  const files = copyDistributionFiles(output);
  const manifest = {
    schema_version: 1,
    skill_version: SKILL_VERSION,
    generated_at: new Date().toISOString(),
    files,
  };
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : '生成 Skill 分发文件失败。');
  process.exitCode = 1;
}
