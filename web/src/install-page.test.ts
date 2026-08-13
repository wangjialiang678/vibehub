import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InstallPageView,
  buildAiInstallPrompt,
  buildInstallCommand,
  copyInstallText,
} from './pages/InstallPage';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('./pages/InstallPage.tsx', import.meta.url), 'utf8');
const login = readFileSync(new URL('./pages/LoginPage.tsx', import.meta.url), 'utf8');

function render(platform: 'macOS' | 'Windows') {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(InstallPageView, { initialPlatform: platform, origin: 'https://hub.example.test' })));
  } finally {
    console.error = originalError;
  }
}

afterEach(() => vi.restoreAllMocks());

describe('学生安装部署 Skill', () => {
  it('提供独立安装入口并从登录页可到达', () => {
    expect(app).toContain('path="/install"');
    expect(login).toContain('to="/install"');
  });

  it('只使用 VibeHub 同源安装资源，不依赖外部包发布渠道', () => {
    expect(page).not.toMatch(/VITE_SKILL_INSTALL_COMMAND|npx|npm|SkillHub|即将开放/i);
    expect(page).toContain('/downloads/vibehub-skill/install.mjs');
    expect(page).toContain('复制给 AI');
    expect(page).toContain('node --version');
    expect(page).not.toMatch(/深圳|上海|CAMP-[A-Z0-9]+/i);
  });

  it('macOS 显示 curl 命令，并把同源分发根传给安装器', () => {
    const command = buildInstallCommand('macOS', 'https://hub.example.test');
    expect(command).toContain('curl --fail --silent --show-error --location');
    expect(command).toContain('https://hub.example.test/downloads/vibehub-skill/install.mjs');
    expect(command).toContain('node "$tmp" --base-url "https://hub.example.test/downloads/vibehub-skill/"');

    const html = render('macOS');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('curl --fail');
    expect(html).toContain('终端 Terminal');
    expect(html).toContain('role="status"');
  });

  it('Windows 显示 PowerShell 命令，并把同源分发根传给安装器', () => {
    const command = buildInstallCommand('Windows', 'https://hub.example.test');
    expect(command).toContain('Invoke-WebRequest');
    expect(command).toContain("'https://hub.example.test/downloads/vibehub-skill/install.mjs'");
    expect(command).toContain("--base-url 'https://hub.example.test/downloads/vibehub-skill/'");

    const html = render('Windows');
    expect(html).toContain('PowerShell');
    expect(html).toContain('Invoke-WebRequest');
    expect(html).toContain('role="status"');
  });

  it('复制当前平台的精确命令，并报告成功和失败', async () => {
    const command = buildInstallCommand('Windows', 'https://hub.example.test');
    const copy = vi.fn(async () => undefined);
    const setNotice = vi.fn();
    await copyInstallText(command, '安装命令已复制', copy, setNotice);
    expect(copy).toHaveBeenCalledWith(command);
    expect(setNotice).toHaveBeenCalledWith('安装命令已复制');

    copy.mockRejectedValueOnce(new Error('denied'));
    await copyInstallText(command, '安装命令已复制', copy, setNotice);
    expect(setNotice).toHaveBeenLastCalledWith('复制失败，请手动选中文字复制');
  });

  it('复制给 AI 的说明包含官方安装页但不含真实邀请码或城市', async () => {
    const prompt = buildAiInstallPrompt('https://hub.example.test');
    expect(prompt).toContain('https://hub.example.test/install');
    expect(prompt).toContain('macOS');
    expect(prompt).toContain('Windows');
    expect(prompt).toContain('向我询问营地邀请码');
    expect(prompt).not.toMatch(/深圳|上海|CAMP-[A-Z0-9]+/i);

    const copy = vi.fn(async () => undefined);
    const setNotice = vi.fn();
    await copyInstallText(prompt, '给 AI 的说明已复制', copy, setNotice);
    expect(copy).toHaveBeenCalledWith(prompt);
    expect(render('macOS')).toContain('复制给 AI');
  });

  it('把安装、邀请码接入和部署作品分成三步，并说明 Node 20 要求', () => {
    const html = render('macOS');
    expect(html).toContain('安装部署助手');
    expect(html).toContain('输入邀请码');
    expect(html).toContain('部署游戏');
    expect(html).toContain('Node.js 20');
    expect(html).toContain('Codex');
    expect(html).toContain('WorkBuddy');
  });
});
