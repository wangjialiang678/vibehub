import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './components/Ui';
import type { SubmissionResponse } from './lib/types';
import { buildVibeHubDeployPrompt } from './lib/vibehubDeployPrompt';
import type { SubmissionUiState } from './pages/StudentSubmitPage';
import {
  StudentSubmitPageView,
  SubmitWorkspace,
  copyAiSubmissionPrompt,
  executeSubmission,
  parseSubmissionFlows,
  validateSubmissionFlows,
} from './pages/StudentSubmitPage';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
afterEach(() => vi.unstubAllGlobals());
const me = {
  user: { id: 'u1', username: 'student', display_name: '小明' },
  camp: { id: 'c1', slug: 'summer-camp', name: '暑期营', kind: 'camp' },
  role: 'student',
  project_id: 'project-1',
};

const response: SubmissionResponse = {
  version_id: 'v2', seq: 2, label: 'v0.2.0',
  preview_url: 'https://preview.example.test/game?claim=secret-value',
  preview_expires_at: '2026-08-13T12:00:00.000Z', rewrites: 0,
  deployment: { status: 'ready' }, diagnosis: { id: 'd1', status: 'running' },
  review: { status: 'waiting_for_diagnosis' }, message: 'ok',
};

function render(component: React.ReactNode) {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null, component));
  } finally {
    console.error = originalError;
  }
}

function renderWorkspace(initialSubmissionState?: Parameters<typeof SubmitWorkspace>[0]['initialSubmissionState'], initialMode?: 'web' | 'ai') {
  const queryClient = new QueryClient();
  return render(createElement(QueryClientProvider, { client: queryClient }, createElement(SubmitWorkspace, {
    projectId: 'project-1', campName: '暑期营', campSlug: 'summer-camp', userName: '小明', publicOrigin: 'https://hub.example.test', initialSubmissionState, initialMode,
  })));
}

describe('学员提交作品页', () => {
  it('真实渲染加载、登录失效和无项目状态', () => {
    expect(render(createElement(StudentSubmitPageView, { state: { status: 'pending' } }))).toContain('正在加载');
    expect(render(createElement(StudentSubmitPageView, { state: { status: 'error' } }))).toContain('前往登录');
    const noProject = render(createElement(StudentSubmitPageView, { state: { status: 'ready', me: { ...me, project_id: null } } }));
    expect(noProject).toContain('让 AI 创建并提交第一个作品');
    expect(noProject).toContain('不用等老师先创建');
    expect(noProject).toContain('复制完整指令给 AI');
    expect(noProject).toContain('project create');
    expect(noProject).toContain('立即部署当前游戏');
    expect(noProject).not.toContain('老师为你创建项目后');
    expect(noProject).toContain('提交作品');
  });

  it('真实渲染有标签的文件输入、格式、摘要上限和禁用中的提交按钮', () => {
    const idle = renderWorkspace(undefined, 'web');
    expect(idle).toContain('accept=".html,.htm,.zip,.tar.gz,.tgz"');
    expect(idle).toContain('选择网页文件夹');
    expect(idle).toContain('maxLength="500"');
    expect(idle).toMatch(/<label[^>]*>[^<]*<span[^>]*>↥<\/span><strong>选择文件<\/strong>/);

    const busy = renderWorkspace({ stage: 'uploading', progress: 40, error: null, result: null, hasFiles: true }, 'web');
    expect(busy).toContain('正在上传… 40%');
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>正在提交…<\/button>/);
  });

  it('解析最多五条流程，并拒绝 trim 后超过 80 字的条目', () => {
    expect(parseSubmissionFlows(' 打开首页 \n开始游戏, 查看结果\n再次挑战\n分享作品\n第六条')).toEqual([
      '打开首页', '开始游戏', '查看结果', '再次挑战', '分享作品',
    ]);
    expect(validateSubmissionFlows(['a'.repeat(80)])).toBeNull();
    expect(validateSubmissionFlows(['正常流程', ` ${'长'.repeat(81)} `])).toContain('80');
  });

  it('流程过长时明确报错且不准备文件或调用 API', async () => {
    const prepare = vi.fn();
    const submit = vi.fn();
    const updates: Array<{ stage?: string; error?: string | null }> = [];
    await executeSubmission({
      projectId: 'project-1', files: [new File(['game'], 'index.html')], summary: '', flowsText: '长'.repeat(81),
    }, { prepare, submit, invalidate: vi.fn() }, (update) => updates.push(update));

    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(updates.at(-1)?.error).toContain('80');
    expect(updates.at(-1)).toMatchObject({ stage: 'idle', progress: 0, result: null });
  });

  it.each(['prepare', 'submit'] as const)('%s 失败后恢复 idle 并保留可重试错误', async (failureAt) => {
    const prepare = vi.fn(async () => {
      if (failureAt === 'prepare') throw new Error('文件整理失败');
      return new File(['zip'], 'game.zip');
    });
    const submit = vi.fn(async () => {
      if (failureAt === 'submit') throw new Error('上传失败');
      return response;
    });
    let state: SubmissionUiState = { stage: 'idle', progress: 0, error: null, result: null };
    await executeSubmission({ projectId: 'project-1', files: [new File(['game'], 'index.html')], summary: '', flowsText: '' }, {
      prepare, submit, invalidate: vi.fn(),
    }, (update) => { state = { ...state, ...update }; });

    expect(state.stage).toBe('idle');
    expect(state.error).toContain(failureAt === 'prepare' ? '文件整理失败' : '上传失败');
    expect(renderWorkspace({ ...state, hasFiles: true }, 'web')).toContain('重新提交');
  });

  it('成功后刷新项目和版本，并且可见预览文本不含 claim', async () => {
    const invalidate = vi.fn(async () => undefined);
    let state: SubmissionUiState = { stage: 'idle', progress: 0, error: null, result: null };
    await executeSubmission({ projectId: 'project-1', files: [new File(['game'], 'index.html')], summary: '更新', flowsText: '开始游戏' }, {
      prepare: vi.fn(async (files: File[]) => files[0]),
      submit: vi.fn(async (_projectId, _bundle, _meta, onProgress) => { onProgress(100); return response; }),
      invalidate,
    }, (update) => { state = { ...state, ...update }; });

    expect(invalidate).toHaveBeenCalledWith(['project', 'project-1']);
    expect(invalidate).toHaveBeenCalledWith(['versions', 'project-1']);
    const success = renderWorkspace({ ...state, hasFiles: true }, 'web');
    const visibleText = success.replace(/<[^>]+>/g, '');
    expect(visibleText).toContain('打开预览');
    expect(visibleText).not.toContain('secret-value');
    expect(visibleText).not.toContain('claim=');
  });

  it('默认选择 AI，并一次复制安装、绑定和立即部署的共享提示词', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const notice = vi.fn();
    const prompt = buildVibeHubDeployPrompt('https://hub.example.test');
    await copyAiSubmissionPrompt(prompt, copyToClipboard, notice);

    expect(writeText).toHaveBeenCalledWith(prompt);
    expect(prompt).toContain('https://hub.example.test/downloads/vibehub-skill/install.mjs');
    expect(prompt).toContain('立即部署当前游戏');
    expect(notice).toHaveBeenCalledWith('提示词已复制，可以粘贴给 AI 助手了。');
    const html = renderWorkspace();
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('复制完整指令给 AI');
    expect(html).toContain('立即部署当前游戏');
    expect(html).not.toContain('安装部署助手 →');
  });

  it('保留路由、侧栏和复用 CTA 契约', () => {
    const app = readSource('./App.tsx');
    const shell = readSource('./components/Shell.tsx');
    const cta = readSource('./components/SubmissionCta.tsx');
    expect(app).toContain('path="/app/submit"');
    expect(shell).toContain("{ label: '提交作品', to: '/app/submit', icon: 'upload' }");
    expect(cta).toContain('to="/app/submit"');
  });

  it('在 720px 以下堆叠提交控件并让操作按钮占满宽度', () => {
    const styles = readSource('./styles.css');
    expect(styles).toContain('@media (max-width: 720px)');
    expect(styles).toContain('.submit-mode-tabs, .submit-file-options, .submit-form-grid { grid-template-columns: 1fr; }');
    expect(styles).toContain('.submit-success .button, .submit-actions .button { width: 100%; }');
  });
});
