import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, readableError } from '../lib/api';
import { postLoginPath } from '../lib/presentation';

export function LoginPage() {
  const [code, setCode] = useState('');
  const redeem = useMutation({
    mutationFn: async (inviteCode: string) => {
      const redeemed = await api.redeem(inviteCode);
      const session = await api.me();
      return session.role || redeemed.role;
    },
    onSuccess: (role) => {
      window.location.assign(postLoginPath(role));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (normalized) redeem.mutate(normalized);
  };
  return (
    <main className="login-page">
      <section className="login-panel">
        <LinkMark />
        <p className="eyebrow">AI 产品共创课</p>
        <h1>带着邀请码，<br />进入你的营地。</h1>
        <p className="login-copy">这里没有密码。邀请码就是你在课程里的身份；学员进入项目，老师进入营地管理台。</p>
        <form onSubmit={submit} className="invite-form">
          <label htmlFor="invite-code">邀请码</label>
          <input id="invite-code" autoCapitalize="characters" autoComplete="off" placeholder="例如 CAMP-7K3P" value={code} onChange={(event) => setCode(event.target.value)} disabled={redeem.isPending} />
          {redeem.isError && <p className="form-error" role="alert">{readableError(redeem.error, '邀请码没有验证成功，请检查后重试。')}</p>}
          <button className="button button-coral button-wide" type="submit" disabled={!code.trim() || redeem.isPending}>{redeem.isPending ? '正在进入…' : '进入 VibeHub'}</button>
        </form>
        <p className="login-help">邀请码找不到了？请联系老师重新获取。<br /><Link to="/install">第一次用 AI 提交作品？安装部署助手 →</Link></p>
      </section>
      <aside className="login-aside" aria-hidden="true"><span>V</span><p>VibeHub</p><small>把每个人的想法，vibe 在一起</small></aside>
    </main>
  );
}

function LinkMark() {
  return <span className="brand-mark">V</span>;
}
