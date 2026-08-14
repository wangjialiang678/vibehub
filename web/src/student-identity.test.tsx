import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StudentIdentityCard } from './pages/StudentPage';
import { parseRosterImport, parseRosterNames } from './pages/AdminInvitesPage';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('灵活学员身份', () => {
  it('名单可选且历史码补录同时支持中英文逗号和昵称', () => {
    expect(parseRosterNames(' 李同学 \n\n王同学')).toEqual(['李同学', '王同学']);
    expect(parseRosterImport('李同学，aigame-code，游戏达人\n王同学,AIGAME-2')).toEqual([
      { real_name: '李同学', code: 'AIGAME-CODE', display_name: '游戏达人' },
      { real_name: '王同学', code: 'AIGAME-2' },
    ]);
  });

  it('学生看到私有真实姓名和公开昵称的明确边界', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><StudentIdentityCard identity={{
      user: { id: 'u1', username: 'student', real_name: '真实姓名', display_name: '公开昵称' },
      profile: { id: 'r1', source: 'student', verification_status: 'self_reported' },
      camp: { id: 'c1', slug: 'camp', name: '营地', kind: 'game' }, role: 'student', project_id: 'p1',
    }} /></QueryClientProvider>);
    expect(html).toContain('真实姓名');
    expect(html).toContain('仅老师可见');
    expect(html).toContain('公开昵称');
    expect(html).toContain('作品集合会显示');
    expect(html).toContain('学员自填 · 等待老师确认');
  });

  it('老师确认后学生仍可改昵称，但真实姓名输入锁定', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><StudentIdentityCard identity={{
      user: { id: 'u1', username: 'student', real_name: '真实姓名', display_name: '公开昵称' },
      profile: { id: 'r1', source: 'teacher', verification_status: 'verified' },
      camp: { id: 'c1', slug: 'camp', name: '营地', kind: 'game' }, role: 'student', project_id: 'p1',
    }} /></QueryClientProvider>);
    expect(html).toMatch(/id="student-real-name"[^>]*disabled=""/);
    expect(html).not.toMatch(/id="student-display-name"[^>]*disabled=""/);
    expect(html).toContain('老师已确认真实姓名');
  });

  it('登录页和老师端都提供可选补名入口，并保持邀请码说明', () => {
    const login = readSource('./pages/LoginPage.tsx');
    const admin = readSource('./pages/AdminInvitesPage.tsx');
    expect(login).toContain("error.code === 'profile_required'");
    expect(login).toContain('真实姓名只给老师看');
    expect(login).toContain('公开昵称会显示在作品集合里');
    expect(admin).toContain('学员名单（可选，一行一个）');
    expect(admin).toContain('补录已有邀请码');
    expect(admin).toContain('每人一码，不可互换或与他人共用');
  });
});
