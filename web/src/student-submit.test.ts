import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSubmissionFlows } from './pages/StudentSubmitPage';

const readSource = (path: string) => readFileSync(resolve(path), 'utf8');

describe('学员提交作品页', () => {
  it('注册提交路由，并在学员侧栏提供上传入口', () => {
    const app = readSource('src/App.tsx');
    const shell = readSource('src/components/Shell.tsx');

    expect(app).toContain('path="/app/submit"');
    expect(app).toContain('<StudentSubmitPage />');
    expect(shell).toContain("{ label: '提交作品', to: '/app/submit', icon: 'upload' }");
  });

  it('提供网页上传和 AI 助手两种方式', () => {
    const page = readSource('src/pages/StudentSubmitPage.tsx');

    expect(page).toContain("useState<SubmissionMode>('web')");
    expect(page).toContain('直接上传网页');
    expect(page).toContain('交给 AI 助手');
    expect(page).toContain('to="/install"');
  });

  it('支持约定格式和整个网页文件夹', () => {
    const page = readSource('src/pages/StudentSubmitPage.tsx');

    expect(page).toContain('accept=".html,.htm,.zip,.tar.gz,.tgz"');
    expect(page).toContain("setAttribute('webkitdirectory', '')");
    expect(page).toContain('maxLength={500}');
    expect(parseSubmissionFlows('打开首页\n开始游戏, 查看结果\n再次挑战\n分享作品\n第六条')).toEqual([
      '打开首页', '开始游戏', '查看结果', '再次挑战', '分享作品',
    ]);
  });

  it('串联准备、上传进度、缓存刷新和可重试错误状态', () => {
    const page = readSource('src/pages/StudentSubmitPage.tsx');

    expect(page).toContain('prepareSubmissionFiles');
    expect(page).toContain('api.submitProjectVersion');
    expect(page).toContain("'preparing'");
    expect(page).toContain("'uploading'");
    expect(page).toContain("'checking'");
    expect(page).toContain("'success'");
    expect(page).toContain("invalidateQueries({ queryKey: ['project', projectId] })");
    expect(page).toContain("invalidateQueries({ queryKey: ['versions', projectId] })");
    expect(page).toContain('重新提交');
  });

  it('只展示安全的 AI 提示，不泄露会话、邀请码或内部入口', () => {
    const page = readSource('src/pages/StudentSubmitPage.tsx');

    expect(page).toContain('使用邀请码加入 VibeHub，然后部署我的游戏。');
    expect(page).not.toContain('document.cookie');
    expect(page).not.toContain('SkillHub');
    expect(page).not.toContain('HUB token');
    expect(page).toContain('React / Vite');
  });

  it('提供只指向提交页的复用 CTA', () => {
    const cta = readSource('src/components/SubmissionCta.tsx');

    expect(cta).toContain("to=\"/app/submit\"");
    expect(cta).toContain('label');
    expect(cta).toContain('className');
  });
});
