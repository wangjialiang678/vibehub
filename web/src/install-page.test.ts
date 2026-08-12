import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve('src/App.tsx'), 'utf8');
const page = readFileSync(resolve('src/pages/InstallPage.tsx'), 'utf8');
const login = readFileSync(resolve('src/pages/LoginPage.tsx'), 'utf8');

describe('学生安装部署 Skill', () => {
  it('提供独立安装入口并从登录页可到达', () => {
    expect(app).toContain('path="/install"');
    expect(login).toContain('to="/install"');
  });

  it('macOS 与 Windows 共用同一条一键安装命令', () => {
    expect(page).toContain('VITE_SKILL_INSTALL_COMMAND');
    expect(page).toContain('macOS');
    expect(page).toContain('Windows');
    expect(page).toContain('copyToClipboard');
  });

  it('包未发布时关闭复制入口，并提供 Node 安装与排错入口', () => {
    expect(page).toContain('installEnabled');
    expect(page).toContain('部署助手即将开放');
    expect(page).toContain('https://nodejs.org/zh-cn/download');
    expect(page).toContain('npx --version');
  });

  it('把安装、邀请码接入和部署作品分成三步', () => {
    expect(page).toContain('安装部署助手');
    expect(page).toContain('输入邀请码');
    expect(page).toContain('部署游戏');
    expect(page).toContain('Codex');
    expect(page).toContain('WorkBuddy');
  });

  it('安装说明可复用于任意营地且不含内部 SkillHub 依赖', () => {
    expect(page).not.toMatch(/深圳|SkillHub|HUB_TOKEN|skillhub\.supermind/i);
  });
});
