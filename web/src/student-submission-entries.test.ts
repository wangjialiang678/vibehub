import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './components/Ui';
import { ApiError } from './lib/api';
import { getProjectStatus } from './lib/presentation';
import type { ProjectSnapshot } from './lib/types';
import { buildVibeHubDeployPrompt } from './lib/vibehubDeployPrompt';
import {
  StudentDashboard,
  StudentSubmissionHeadingActions,
  getStudentSubmissionAction,
  openStudentPreview,
} from './pages/StudentPage';
import { VersionSubmissionActions } from './pages/StudentVersionsPage';
import {
  RevealedInviteActions,
  TeacherStudentGuide,
  buildStudentAiGuide,
  buildStudentInviteMessages,
  copyStudentInviteMessage,
  copyTeacherStudentGuide,
  publicAppBaseUrl,
} from './pages/AdminInvitesPage';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function render(component: React.ReactNode) {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null, component));
  } finally {
    console.error = originalError;
  }
}

describe('学员提交入口', () => {
  it('按当前项目状态给出明确动作，新的待审版本优先于旧退回记录', () => {
    expect(getStudentSubmissionAction({ pending: false, live: false, rejected: false })).toEqual({ label: '提交我的游戏', note: null });
    expect(getStudentSubmissionAction({ pending: true, live: false, rejected: false })).toEqual({ label: '提交新版本', note: '新提交会替代当前待审版本。' });
    expect(getStudentSubmissionAction({ pending: true, live: true, rejected: true })).toEqual({ label: '提交新版本', note: '新提交会替代当前待审版本。' });
    expect(getStudentSubmissionAction({ pending: false, live: true, rejected: true })).toEqual({ label: '修改并重新提交', note: null });
    expect(getStudentSubmissionAction({ pending: false, live: true, rejected: false })).toEqual({ label: '提交下一版本', note: null });
  });

  it('已有新待审版本时，页面不再显示旧退回警告或退回状态', () => {
    const snapshot: ProjectSnapshot = {
      project: { id: 'project-1', slug: 'game', title: '小游戏', publish_status: 'published_with_pending', live_url: 'https://works.example/game/', updated_at: '2026-08-13T08:00:00Z' },
      owner: { id: 'user-1', username: 'student', display_name: '小明' },
      camp: { id: 'camp-1', slug: 'shenzhen', name: '深圳营', kind: 'game' },
      live_version: { id: 'version-1', label: 'v1', preview_url: null },
      pending_version: { id: 'version-2', label: 'v2', preview_url: 'https://works.example/vibehub/_preview/preview2/' },
      latest_diagnosis: null,
      last_review: { status: 'rejected', comment: '这是上一次提交的退回意见', version_id: 'version-1' },
      stats: { total_views: 0, today_views: 0 },
      timeline: [],
    };

    const html = render(createElement(StudentDashboard, { snapshot, userName: '小明' }));
    expect(getProjectStatus({ publish_status: snapshot.project.publish_status, pending_version: snapshot.pending_version, last_review: snapshot.last_review })).toEqual({ label: '等待审核', tone: 'warning' });
    expect(html).toContain('等待审核');
    expect(html).toContain('提交新版本');
    expect(html).not.toContain('老师退回了这次提交');
    expect(html).not.toContain('这是上一次提交的退回意见');
    expect(html).not.toContain('已退回修改');
  });

  it('点击时同步预留安全窗口，授权成功后在该窗口替换地址', async () => {
    const grantPreview = vi.fn(async () => ({ preview_url: 'https://works.example/vibehub/_preview/preview2/?claim=short-lived-secret', expires_at: '2026-08-13T09:00:00Z' }));
    const child = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
    const openWindow = vi.fn(() => child);
    const setNotice = vi.fn();

    await openStudentPreview('https://works.example/vibehub/_preview/preview2/', { grantPreview, openWindow, setNotice });

    expect(openWindow).toHaveBeenCalledWith('about:blank', '_blank');
    expect(openWindow.mock.invocationCallOrder[0]).toBeLessThan(grantPreview.mock.invocationCallOrder[0]);
    expect(child.opener).toBeNull();
    expect(grantPreview).toHaveBeenCalledWith('preview2');
    expect(child.location.replace).toHaveBeenCalledWith('https://works.example/vibehub/_preview/preview2/?claim=short-lived-secret');
    expect(child.close).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
  });

  it('弹窗被浏览器拦截时立即提示，不再请求预览授权', async () => {
    const grantPreview = vi.fn(async () => ({ preview_url: 'unused', expires_at: 'unused' }));
    const openWindow = vi.fn(() => null);
    const setNotice = vi.fn();

    await openStudentPreview('https://works.example/vibehub/_preview/preview2/', { grantPreview, openWindow, setNotice });

    expect(grantPreview).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenCalledWith('浏览器拦截了预览窗口，请允许弹窗后重试。');
  });

  it('预览授权失败时关闭预留窗口，且提示不泄露 claim', async () => {
    const grantPreview = vi.fn(async () => { throw new ApiError(503, '授权失败 https://works.example/?claim=server-secret'); });
    const child = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
    const openWindow = vi.fn(() => child);
    const setNotice = vi.fn();

    await openStudentPreview('https://works.example/vibehub/_preview/preview2/', { grantPreview, openWindow, setNotice });

    expect(child.close).toHaveBeenCalledOnce();
    expect(child.location.replace).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenCalledWith('这个预览暂时打不开。');
    expect(setNotice.mock.calls.flat().join('')).not.toMatch(/server-secret|claim=/);
  });

  it('待审预览刚被审核失效时刷新项目状态并给出同步提示', async () => {
    const grantPreview = vi.fn(async () => { throw new ApiError(404, '找不到这个预览'); });
    const child = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
    const openWindow = vi.fn(() => child);
    const setNotice = vi.fn();
    const refreshProject = vi.fn(async () => undefined);

    await openStudentPreview('https://works.example/vibehub/_preview/preview2/', { grantPreview, openWindow, setNotice, refreshProject });

    expect(child.close).toHaveBeenCalledOnce();
    expect(refreshProject).toHaveBeenCalledOnce();
    expect(setNotice).toHaveBeenCalledWith('作品状态刚刚变化，正在同步最新地址…');
  });

  it('在项目标题区渲染提交入口和待审替代说明', () => {
    const html = render(createElement(StudentSubmissionHeadingActions, { pending: true, live: true, rejected: false, campSlug: 'summer' }));
    expect(html).toContain('href="/app/submit"');
    expect(html).toContain('提交新版本');
    expect(html).toContain('新提交会替代当前待审版本');
  });

  it('有预览才显示打开预览，并彻底移除继续开发和灰色假按钮', () => {
    const source = readSource('./pages/StudentPage.tsx');
    expect(source).toContain('打开预览');
    expect(source).not.toContain('继续开发');
    expect(source).not.toContain('button is-disabled');
    expect(source).toContain('previewUrl ?');
  });

  it('提交记录页顶部始终有新版本入口，空态另有第一次提交入口', () => {
    const heading = render(createElement(VersionSubmissionActions, { empty: false, campSlug: 'summer' }));
    const empty = render(createElement(VersionSubmissionActions, { empty: true, campSlug: 'summer' }));
    expect(heading).toContain('提交新版本');
    expect(heading).toContain('href="/app/submit"');
    expect(empty).toContain('开始第一次提交');
    expect(`${heading}${empty}`.match(/href="\/app\/submit"/g)).toHaveLength(2);
  });

  it('项目尚未创建时不提供无法完成的提交入口', () => {
    const student = readSource('./pages/StudentPage.tsx');
    const versions = readSource('./pages/StudentVersionsPage.tsx');
    const studentNoProject = student.slice(student.indexOf('function NoProject'), student.indexOf('export function getStudentSubmissionAction'));
    const versionsNoProject = versions.slice(versions.indexOf('if (!me.data.project_id)'), versions.indexOf('if (versions.isPending)'));
    expect(studentNoProject).not.toContain('SubmissionCta');
    expect(studentNoProject).toContain('联系老师');
    expect(versionsNoProject).not.toContain('VersionSubmissionActions');
    expect(versionsNoProject).toContain('联系老师');
  });

  it('提交入口在移动端堆叠并占满可用宽度', () => {
    const styles = readSource('./styles.css');
    expect(styles).toContain('.submission-entry-heading { align-items: stretch; flex-direction: column; }');
    expect(styles).toContain('.submission-heading-actions .button { width: 100%; }');
  });
});

describe('学员邀请码转发说明', () => {
  const codes = ['STUDENT-ONE', 'STUDENT-TWO'];
  const origin = 'https://hub.example.test';

  it('每个邀请码生成 AI 优先的一段式文案，并保留网页备用入口', () => {
    const messages = buildStudentInviteMessages(codes, '暑期创造营', origin);
    const firstAiPrompt = buildVibeHubDeployPrompt(origin, codes[0]);
    const secondAiPrompt = buildVibeHubDeployPrompt(origin, codes[1]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('暑期创造营');
    expect(messages[0]).toContain(`${origin}/login`);
    expect(messages[0]).toContain('STUDENT-ONE');
    expect(messages[0]).not.toContain('STUDENT-TWO');
    expect(messages[1]).toContain('STUDENT-TWO');
    expect(messages[1]).not.toContain('STUDENT-ONE');
    expect(messages[0]).toContain('每人一码');
    expect(messages[0]).toContain('不可互换');
    expect(messages[0]).toContain('立即部署当前游戏');
    expect(messages[0]).toContain('HTML、ZIP 或网页文件夹');
    expect(messages[0]).toContain('AI 助手');
    expect(messages[0]).toContain('网页备用');
    expect(messages[0]).toContain(firstAiPrompt);
    expect(messages[1]).toContain(secondAiPrompt);
    expect(firstAiPrompt.match(/STUDENT-ONE/g)).toHaveLength(1);
    expect(secondAiPrompt.match(/STUDENT-TWO/g)).toHaveLength(1);
    expect(messages[0]).toContain('manifest.json');
    expect(messages[0]).toContain('install.mjs');
    expect(messages[0].match(/STUDENT-ONE/g)).toHaveLength(1);
    expect(messages[1].match(/STUDENT-TWO/g)).toHaveLength(1);
    expect(messages[0]).not.toMatch(/shell|PowerShell|node --version|\bnpm\b|SkillHub/i);
  });

  it('未生成邀请码前只渲染一张可转发说明卡和一次复制动作', () => {
    const aiGuide = buildStudentAiGuide('星际创造营', origin);
    const html = render(createElement(TeacherStudentGuide, {
      campName: '星际创造营',
      origin,
      onCopy: vi.fn(),
    }));

    expect(aiGuide).toContain('星际创造营');
    expect(aiGuide).toContain(`${origin}/login`);
    expect(aiGuide).toContain('网页备用');
    expect(aiGuide).toContain(buildVibeHubDeployPrompt(origin, 'CAMP-XXXX'));
    expect(aiGuide.match(/CAMP-XXXX/g)).toHaveLength(1);
    expect(aiGuide).toContain('manifest.json');
    expect(aiGuide).not.toMatch(/shell|PowerShell|node --version|\bnpm\b|SkillHub/i);
    expect(aiGuide).not.toMatch(/深圳|STUDENT-ONE|hub\.supermind-ai\.cn/);
    expect(html).toContain('发给学员的使用说明');
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('复制完整说明');
    expect(html).not.toContain('复制网页登录说明');
    expect(html).toContain('CAMP-XXXX');
  });

  it('优先规范化公开构建地址，仅缺失时回退浏览器地址', () => {
    expect(publicAppBaseUrl(' https://hub.example.test/path/ ', 'https://localhost:5173')).toBe('https://hub.example.test/path');
    expect(publicAppBaseUrl('', 'https://localhost:5173/')).toBe('https://localhost:5173');
    expect(publicAppBaseUrl(undefined, 'https://localhost:5173/')).toBe('https://localhost:5173');
  });

  it('有公开构建地址时不依赖 window，无浏览器环境也安全', () => {
    expect(publicAppBaseUrl(' https://hub.example.test/ ')).toBe('https://hub.example.test');
    expect(publicAppBaseUrl(undefined)).toBe('');
  });

  it('student 显示每码独立复制按钮，teacher 不显示学员说明', () => {
    const student = render(createElement(RevealedInviteActions, { role: 'student', codes, campName: '暑期创造营', origin, onCopy: vi.fn(), onExport: vi.fn() }));
    const teacher = render(createElement(RevealedInviteActions, { role: 'teacher', codes, campName: '暑期创造营', origin, onCopy: vi.fn(), onExport: vi.fn() }));
    expect(student.match(/复制发给学员的说明/g)).toHaveLength(2);
    expect(student).toContain('aria-label="复制第 1 位学员的说明"');
    expect(student).toContain('aria-label="复制第 2 位学员的说明"');
    expect(student).toContain(`${origin}/login`);
    expect(student).toContain(`${origin}/downloads/vibehub-skill/install.mjs`);
    expect(student).toContain('manifest.json');
    expect(student).toContain('立即部署当前游戏');
    expect(teacher).not.toContain('复制发给学员的说明');
    expect(teacher).not.toContain(`${origin}/login`);
    expect(teacher).not.toContain(`${origin}/downloads/vibehub-skill/install.mjs`);
    expect(teacher).not.toContain('manifest.json');
    expect(teacher).not.toContain('立即部署当前游戏');
  });

  it('只按本次生成时的角色展示说明，且不记录或持久化明码', () => {
    const source = readSource('./pages/AdminInvitesPage.tsx');
    expect(source).toContain('setRevealedRole(input.role)');
    expect(source).toContain('VITE_PUBLIC_APP_URL');
    expect(source).toContain('publicAppBaseUrl(');
    expect(source).toContain("from '../lib/vibehubDeployPrompt';");
    expect(source).toContain('buildVibeHubDeployPrompt(baseUrl, code)');
    expect(source).toContain('role="status"');
    expect(source.indexOf('<TeacherStudentGuide')).toBeGreaterThan(-1);
    expect(source.indexOf('<TeacherStudentGuide')).toBeLessThan(source.indexOf('<section className="panel invite-reveal"'));
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('console.');
  });

  it('复制统一模板时使用固定成功或失败提示，不回显邀请码', async () => {
    const setNotice = vi.fn();
    const guide = buildStudentAiGuide('星际创造营', origin);
    await copyTeacherStudentGuide(guide, vi.fn(async () => undefined), setNotice);
    expect(setNotice).toHaveBeenLastCalledWith('学员完整说明已复制');

    await copyTeacherStudentGuide(guide, vi.fn(async () => { throw new Error('CAMP-SECRET'); }), setNotice);
    expect(setNotice).toHaveBeenLastCalledWith('学员完整说明暂时无法复制。');
    expect(setNotice.mock.calls.flat().join('')).not.toContain('CAMP-SECRET');
  });

  it('320px 宽度下说明卡和复制按钮改为单列布局', () => {
    const styles = readSource('./styles.css');
    expect(styles).toContain('.student-guide-grid { grid-template-columns: 1fr; }');
    expect(styles).toContain('.student-guide-card .button { width: 100%; }');
  });

  it('复制单个学员文案并给出不泄露邀请码的反馈', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const setNotice = vi.fn();
    const message = buildStudentInviteMessages([codes[0]], '暑期创造营', origin)[0];
    await copyStudentInviteMessage(message, 0, copyToClipboard, setNotice);

    expect(writeText).toHaveBeenCalledWith(message);
    expect(setNotice).toHaveBeenCalledWith('第 1 位学员的转发说明已复制');
    expect(setNotice.mock.calls.flat().join('')).not.toContain(codes[0]);
    vi.unstubAllGlobals();
  });
});
