import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './components/Ui';
import { ApiError } from './lib/api';
import { getProjectStatus } from './lib/presentation';
import type { ProjectSnapshot } from './lib/types';
import {
  StudentDashboard,
  StudentSubmissionHeadingActions,
  getStudentSubmissionAction,
  openStudentPreview,
} from './pages/StudentPage';
import { VersionSubmissionActions } from './pages/StudentVersionsPage';
import {
  RevealedInviteActions,
  buildStudentInviteMessages,
  copyStudentInviteMessage,
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

  it('打开待审预览时先获取短期授权，再把授权地址交给新窗口', async () => {
    const grantPreview = vi.fn(async () => ({ preview_url: 'https://works.example/vibehub/_preview/preview2/?claim=short-lived-secret', expires_at: '2026-08-13T09:00:00Z' }));
    const openWindow = vi.fn();
    const setNotice = vi.fn();

    await openStudentPreview('https://works.example/vibehub/_preview/preview2/', { grantPreview, openWindow, setNotice });

    expect(grantPreview).toHaveBeenCalledWith('preview2');
    expect(openWindow).toHaveBeenCalledWith('https://works.example/vibehub/_preview/preview2/?claim=short-lived-secret', '_blank', 'noopener,noreferrer');
    expect(setNotice).not.toHaveBeenCalled();
  });

  it('预览授权失败时不打开窗口，且提示中不泄露 claim', async () => {
    const grantPreview = vi.fn(async () => { throw new ApiError(503, '这个预览暂时打不开。'); });
    const openWindow = vi.fn();
    const setNotice = vi.fn();

    await openStudentPreview('https://works.example/vibehub/_preview/preview2/', { grantPreview, openWindow, setNotice });

    expect(openWindow).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenCalledWith('这个预览暂时打不开。');
    expect(setNotice.mock.calls.flat().join('')).not.toContain('claim=');
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

  it('每个邀请码生成独立文案，并包含地址、双提交方式和独立性提醒', () => {
    const messages = buildStudentInviteMessages(codes, '暑期创造营', origin);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('暑期创造营');
    expect(messages[0]).toContain(`${origin}/login`);
    expect(messages[0]).toContain('STUDENT-ONE');
    expect(messages[0]).not.toContain('STUDENT-TWO');
    expect(messages[1]).toContain('STUDENT-TWO');
    expect(messages[1]).not.toContain('STUDENT-ONE');
    expect(messages[0]).toContain('每人一码');
    expect(messages[0]).toContain('不可互换');
    expect(messages[0]).toContain('提交我的游戏');
    expect(messages[0]).toContain('HTML、ZIP 或网页文件夹');
    expect(messages[0]).toContain('AI 助手');
    expect(messages[0]).toContain(`${origin}/install`);
    expect(messages[0]).toContain('无需 SkillHub');
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
    expect(student).toContain('无需 SkillHub');
    expect(teacher).not.toContain('复制发给学员的说明');
    expect(teacher).not.toContain('无需 SkillHub');
  });

  it('只按本次生成时的角色展示说明，且不记录或持久化明码', () => {
    const source = readSource('./pages/AdminInvitesPage.tsx');
    expect(source).toContain('setRevealedRole(input.role)');
    expect(source).toContain('VITE_PUBLIC_APP_URL');
    expect(source).toContain('publicAppBaseUrl(');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('console.');
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
