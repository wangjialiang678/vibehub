import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as presentation from './lib/presentation';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('老师端 P0 功能', () => {
  it('only polls active, visible work that still needs a diagnosis result', () => {
    const getPollInterval = Reflect.get(presentation, 'getProjectPollInterval') as undefined | ((input: {
      visible: boolean;
      diagnosis?: { status?: string; stale?: boolean } | null;
    }) => number | false);

    expect(getPollInterval).toEqual(expect.any(Function));
    expect(getPollInterval?.({ visible: true, diagnosis: { status: 'running' } })).toBe(3000);
    expect(getPollInterval?.({ visible: true, diagnosis: { stale: true } })).toBe(3000);
    expect(getPollInterval?.({ visible: false, diagnosis: { status: 'running' } })).toBe(false);
    expect(getPollInterval?.({ visible: true, diagnosis: { status: 'ready' } })).toBe(false);
  });

  it('removes query-token login and routes the teacher workspace through its four pages', () => {
    const admin = readSource('./pages/AdminPage.tsx');
    const shell = readSource('./components/Shell.tsx');
    const app = readSource('./App.tsx');

    expect(admin).not.toContain('URLSearchParams');
    expect(admin).not.toContain('document.cookie');
    expect(shell).toContain("{ label: '总览', to: '/admin/overview'");
    expect(shell).toContain("{ label: '项目', to: '/admin/projects'");
    expect(shell).toContain("{ label: '审核', to: '/admin'");
    expect(shell).toContain("{ label: '集合页', to: `/c/${campSlug}`");
    expect(app).toContain('path="/admin/overview"');
    expect(app).toContain('path="/admin/invites"');
    expect(app).toContain('path="/admin/projects"');
  });

  it('keeps invite generation, one-time codes, export, and cascading revoke visible to teachers', () => {
    const source = readSource('./pages/AdminInvitesPage.tsx');

    expect(source).toContain('只显示这一次');
    expect(source).toContain('复制全部');
    expect(source).toContain('导出 CSV');
    expect(source).toContain('revoked_tokens');
  });

  it('shows overview metrics, stalled projects, and recent activity', () => {
    const source = readSource('./pages/AdminOverviewPage.tsx');

    expect(source).toContain('参与人数');
    expect(source).toContain('卡住了的人');
    expect(source).toContain('最近动态');
    expect(source).toContain("to={`/admin/projects/${item.id}`}");
  });
});
