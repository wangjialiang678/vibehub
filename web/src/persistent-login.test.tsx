import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LoginPage } from './pages/LoginPage';

describe('长期记住网页登录身份', () => {
  it('默认说明当前设备会记住身份，并提醒公用电脑主动退出', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).toContain('登录后会在这台设备上记住你');
    expect(html).toContain('公用电脑');
    expect(html).toContain('退出登录');
    expect(html).not.toMatch(/30\s*天/);
    expect(html).not.toContain('type="checkbox"');
  });
});
