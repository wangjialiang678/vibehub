import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { buildRedeemInput, LoginPage } from './pages/LoginPage';

describe('长期记住网页登录身份', () => {
  it('默认勾选记住我，并提醒公用电脑主动退出', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).toContain('记住我');
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toContain('公用电脑');
    expect(html).toContain('退出登录');
    expect(html).not.toMatch(/30\s*天/);
  });

  it('把记住我选择随登录资料一起提交，默认值和取消值都不会丢失', () => {
    expect(buildRedeemInput({ code: ' camp-7k3p ', rememberMe: true })).toEqual({
      code: 'CAMP-7K3P', remember_me: true,
    });
    expect(buildRedeemInput({ code: ' camp-7k3p ', rememberMe: false, profileRequired: true, realName: ' 学员 ', displayName: ' 小V ' })).toEqual({
      code: 'CAMP-7K3P', remember_me: false, real_name: '学员', display_name: '小V',
    });
  });
});
