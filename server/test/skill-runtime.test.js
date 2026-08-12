import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { platformCommands } from '../../skill/lib/platform.mjs';

test('Windows 使用系统自带命令构建、打包并打开浏览器', () => {
  assert.deepEqual(platformCommands('win32'), {
    npm: { command: 'cmd.exe', prefix: ['/d', '/s', '/c', 'npm.cmd'] },
    tar: 'tar.exe',
    opener: { command: 'rundll32.exe', prefix: ['url.dll,FileProtocolHandler'] },
  });
});

test('macOS 使用对应的 npm、tar 和浏览器打开命令', () => {
  assert.deepEqual(platformCommands('darwin'), {
    npm: { command: 'npm', prefix: [] },
    tar: 'tar',
    opener: { command: 'open', prefix: [] },
  });
});

test('Skill 明确区分 AI 判断与脚本安全边界', () => {
  for (const relativePath of ['../skill/SKILL.md', '../skill/AGENTS.md']) {
    const content = readFileSync(resolve(relativePath), 'utf8');
    assert.match(content, /AI 负责/);
    assert.match(content, /脚本负责/);
    assert.match(content, /不要.*猜.*API/);
    assert.match(content, /macOS.*Windows/);
    assert.match(content, /营地.*邀请码/);
    assert.doesNotMatch(content, /```text\s+vibehub /);
  }
});

test('CLI 的用户提示不依赖未安装到 PATH 的裸 vibehub 命令', () => {
  const content = readFileSync(resolve('../skill/bin/vibehub'), 'utf8');
  assert.match(content, /CLI_DISPLAY/);
  assert.doesNotMatch(content, /\bvibehub (?:bind|deploy|status|open|camps|use|logs)\b/);
});

test('安装器、CLI 与学生入口不依赖 SkillHub 地址或内部令牌', () => {
  for (const relativePath of [
    '../skill/bin/install.mjs',
    '../skill/bin/vibehub',
    '../web/src/pages/InstallPage.tsx',
    '../web/src/pages/StudentSubmitPage.tsx',
  ]) {
    const content = readFileSync(resolve(relativePath), 'utf8');
    assert.doesNotMatch(content, /skillhub|skill[-_]?hub[-_]?(?:url|token)|hub[_-]token/i, relativePath);
  }
});

test('生产控制台构建同时注入 API 和公开学生地址', () => {
  const deployment = readFileSync(resolve('../docs/handbook/deployment.md'), 'utf8');
  assert.match(deployment, /VITE_API_BASE=https:\/\/hub\.supermind-ai\.cn/);
  assert.match(deployment, /VITE_PUBLIC_APP_URL=https:\/\/hub\.supermind-ai\.cn/);
});
