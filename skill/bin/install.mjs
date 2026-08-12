#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDefinitions = {
  codex: { label: 'Codex', parts: ['.agents', 'skills', 'vibehub'] },
  claude: { label: 'Claude Code', parts: ['.claude', 'skills', 'vibehub'] },
  workbuddy: { label: 'WorkBuddy', parts: ['.codebuddy', 'skills', 'vibehub'] },
};
const files = ['SKILL.md', 'AGENTS.md', 'bin/vibehub', 'lib/platform.mjs', 'agents/openai.yaml'];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(args) {
  let home = homedir();
  let targets = null;
  const customDirs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--home') home = resolve(args[++i] || fail('--home 后需要目录'));
    else if (args[i] === '--targets') targets = String(args[++i] || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    else if (args[i] === '--dir') customDirs.push(resolve(args[++i] || fail('--dir 后需要完整的 Skill 目录')));
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('用法：vibehub-skill [--targets codex,claude,workbuddy] [--dir <其他 Agent 的 vibehub Skill 目录>]');
      process.exit(0);
    } else fail(`不认识的参数：${args[i]}`);
  }
  if (targets === null) targets = customDirs.length ? [] : Object.keys(targetDefinitions);
  if (!targets.length && !customDirs.length) fail('至少选择一个 AI 工具或自定义目录');
  const unknown = targets.filter((target) => !targetDefinitions[target]);
  if (unknown.length) fail(`不支持的 AI 工具：${unknown.join('、')}`);
  return { home, targets: [...new Set(targets)], customDirs: [...new Set(customDirs)] };
}

function installFile(relativePath, destinationRoot) {
  const source = join(packageRoot, relativePath);
  const destination = join(destinationRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (relativePath === 'bin/vibehub' && process.platform !== 'win32') chmodSync(destination, 0o755);
}

function backupExisting(destination, backupRoot) {
  if (!existsSync(destination)) return null;
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  mkdirSync(backupRoot, { recursive: true });
  const prefix = join(backupRoot, `${basename(destination)}-${timestamp}`);
  let backup = prefix;
  let suffix = 2;
  while (existsSync(backup)) backup = `${prefix}-${suffix++}`;
  renameSync(destination, backup);
  return backup;
}

function validateStaging(staging) {
  for (const relativePath of files) {
    const candidate = join(staging, relativePath);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new Error(`staging missing ${relativePath}`);
    }
  }
}

function testFault(name) {
  return process.env.NODE_ENV === 'test' && process.env.VIBEHUB_INSTALL_TEST_FAULT === name;
}

function install(destination, backupRoot) {
  const parent = dirname(destination);
  const staging = join(parent, `.${basename(destination)}.staging-${process.pid}-${Date.now()}`);
  let backup = null;
  mkdirSync(parent, { recursive: true });
  try {
    for (const [index, file] of files.entries()) {
      installFile(file, staging);
      if (index === 0 && testFault('copy')) throw new Error('injected copy failure');
    }
    validateStaging(staging);
    backup = backupExisting(destination, backupRoot);
    if (testFault('swap')) throw new Error('injected swap failure');
    renameSync(staging, destination);
    if (backup) console.log(`↳ 已备份旧版本：${backup}`);
  } catch {
    let stagingCleaned = true;
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      stagingCleaned = false;
    }
    let restored = !backup;
    if (backup && !existsSync(destination)) {
      try {
        renameSync(backup, destination);
        restored = true;
      } catch {
        restored = false;
      }
    }
    const recovery = restored
      ? '原版本已恢复，请检查目录权限和磁盘空间后重试。'
      : `自动恢复未完成，请保留现场并联系技术支持；旧版本位于 ${backup}。`;
    const cleanup = stagingCleaned ? '' : ` 暂存目录 ${staging} 也未能清理，请联系技术支持。`;
    throw new Error(`安装失败。${recovery}${cleanup}`);
  }
}

try {
  const { home, targets, customDirs } = parseArgs(process.argv.slice(2));
  const backupRoot = join(home, '.vibehub', 'skill-backups');
  for (const target of targets) {
    const definition = targetDefinitions[target];
    const destination = join(home, ...definition.parts);
    install(destination, backupRoot);
    console.log(`✓ ${definition.label}：${destination}`);
  }
  for (const destination of customDirs) {
    install(destination, backupRoot);
    console.log(`✓ 自定义 Agent：${destination}`);
  }
  console.log('\n安装完成。回到 AI 对话，告诉它：“使用邀请码加入 VibeHub 营地。”');
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : '安装失败。请检查目录权限后重试。'}`);
  process.exitCode = 1;
}
