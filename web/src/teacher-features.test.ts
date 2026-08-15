import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as presentation from './lib/presentation';
import { getCollectionUpdates } from './pages/AdminProjectsPage';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('老师端 P0 功能', () => {
  it('only polls active, visible work that still needs a diagnosis result', () => {
    const getPollInterval = Reflect.get(presentation, 'getProjectPollInterval') as undefined | ((input: {
      visible: boolean;
      diagnosis?: { status?: string; stale?: boolean } | null;
      pending?: boolean;
    }) => number | false);

    expect(getPollInterval).toEqual(expect.any(Function));
    expect(getPollInterval?.({ visible: true, diagnosis: { status: 'running' } })).toBe(3000);
    expect(getPollInterval?.({ visible: true, diagnosis: { stale: true } })).toBe(3000);
    expect(getPollInterval?.({ visible: true, diagnosis: { status: 'ready' }, pending: true })).toBe(3000);
    expect(getPollInterval?.({ visible: false, diagnosis: { status: 'running' } })).toBe(false);
    expect(getPollInterval?.({ visible: true, diagnosis: { status: 'ready' }, pending: false })).toBe(false);
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
    expect(source).toContain('revoked_devices');
  });

  it('shows overview metrics, stalled projects, and recent activity', () => {
    const source = readSource('./pages/AdminOverviewPage.tsx');

    expect(source).toContain('参与人数');
    expect(source).toContain('卡住了的人');
    expect(source).toContain('最近动态');
    expect(source).toContain("to={`/admin/projects/${item.id}`}");
  });

  it('shows verification coverage beside development completeness to students and reviewers', () => {
    const student = readSource('./pages/StudentPage.tsx');
    const review = readSource('./pages/AdminPage.tsx');

    expect(student).toContain('验证覆盖率');
    expect(student).toContain('开发完成度');
    expect(review).toContain('title="开发完成度"');
    expect(review).toContain('验证覆盖率');
  });

  it('connects student submission history and teacher collection controls to existing APIs', () => {
    const app = readSource('./App.tsx');
    const shell = readSource('./components/Shell.tsx');
    const api = readSource('./lib/api.ts');
    const projects = readSource('./pages/AdminProjectsPage.tsx');
    const collection = readSource('./pages/CollectionPage.tsx');

    expect(app).toContain('path="/app/versions"');
    expect(shell).toContain("{ label: '提交记录', to: '/app/versions'");
    expect(api).toContain('versions: (id: string)');
    expect(api).toContain('updateCollection: (campId: string, items:');
    expect(projects).toContain('集合页编排');
    expect(projects).toContain('设为推荐');
    expect(projects).toContain('上移');
    expect(projects).toContain('下移');
    expect(collection).toContain('item.featured');
  });

  it('persists both projects when two adjacent collection positions are swapped', () => {
    const before = [
      { id: 'project-a', title: 'A', owner_name: '甲', collection_order: 0, collection_recommended: false },
      { id: 'project-b', title: 'B', owner_name: '乙', collection_order: 1, collection_recommended: false },
    ];
    const after = [
      { ...before[1], collection_order: 0 },
      { ...before[0], collection_order: 1 },
    ];

    expect(getCollectionUpdates(before, after)).toEqual([
      { project_id: 'project-b', order: 0, recommended: false },
      { project_id: 'project-a', order: 1, recommended: false },
    ]);
  });
});
