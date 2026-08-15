import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildVibeHubDeployPrompt } from './lib/vibehubDeployPrompt';
import { InstallPageView, copyInstallText } from './pages/InstallPage';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('./pages/InstallPage.tsx', import.meta.url), 'utf8');
const login = readFileSync(new URL('./pages/LoginPage.tsx', import.meta.url), 'utf8');

function render() {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(InstallPageView, { origin: 'https://hub.example.test' })));
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

  it('只显示共享的自然语言提示词和唯一主按钮', () => {
    const prompt = buildVibeHubDeployPrompt('https://hub.example.test');
    const html = render();

    expect(html).toContain('复制这段话给 AI');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('VibeHub Deploy');
    expect(html).toContain('https://hub.example.test/downloads/vibehub-skill/install.mjs');
    expect(html).toContain('立即部署当前游戏');
    for (const paragraph of prompt.split('\n\n')) expect(html).toContain(paragraph);
    expect(html).toContain('href="/login"');
    expect(html).toContain('直接网页登录提交');
    expect(html).toContain('role="status"');
  });

  it('源码和页面都没有旧平台切换、命令安装或内部渠道内容', () => {
    const html = render();
    const forbidden = /buildInstallCommand|platform-tabs|shell|PowerShell|node --version|\bnpm\b|SkillHub|深圳|上海/i;

    expect(page).not.toMatch(forbidden);
    expect(html).not.toMatch(forbidden);
    expect(page).not.toContain('/downloads/vibehub-skill/install.mjs');
    expect(html).not.toContain('复制命令');
  });

  it('复制共享 builder 的精确提示词，并报告成功和失败', async () => {
    const prompt = buildVibeHubDeployPrompt('https://hub.example.test');
    const copy = vi.fn(async () => undefined);
    const setNotice = vi.fn();

    await copyInstallText(prompt, '这段话已复制，可以粘贴给 AI 了', copy, setNotice);
    expect(copy).toHaveBeenCalledWith(prompt);
    expect(setNotice).toHaveBeenCalledWith('这段话已复制，可以粘贴给 AI 了');

    copy.mockRejectedValueOnce(new Error('denied'));
    await copyInstallText(prompt, '这段话已复制，可以粘贴给 AI 了', copy, setNotice);
    expect(setNotice).toHaveBeenLastCalledWith('复制失败，请手动选中文字复制');
  });

  it('说明一次粘贴即可安装、绑定并部署，不要求第二次发指令', () => {
    const html = render();
    expect(html).toContain('复制这段话');
    expect(html).toContain('粘贴给 AI');
    expect(html).toContain('一次完成安装与部署');
    expect(html).not.toContain('游戏做好后，说');
    expect(html.match(/<article/g)).toHaveLength(3);
  });
});
