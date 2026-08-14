import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import QRCode from 'qrcode';
import { Link } from 'react-router-dom';
import { ApiError, api, readableError } from '../lib/api';

export function PageState({ title = '正在加载…', error, action }: { title?: string; error?: unknown; action?: ReactNode }) {
  return (
    <main className="state-page">
      <div className={error ? 'state-card is-error' : 'state-card'}>
        <span className="state-mark" aria-hidden="true">{error ? '!' : '·'}</span>
        <h1>{error ? '这里暂时打不开' : title}</h1>
        <p>{error ? readableError(error) : '正在连接 VibeHub 的真实数据。'}</p>
        {action}
      </div>
    </main>
  );
}

export function LoginRequired({ admin = false }: { admin?: boolean }) {
  return <PageState error={new Error(admin ? '老师审核台需要有效的老师会话。' : '请先用邀请码进入你的项目。')} action={<Link className="button button-coral" to="/login">前往登录</Link>} />;
}

export function Avatar({ name, url, large = false }: { name?: string | null; url?: string | null; large?: boolean }) {
  const initial = name?.trim().slice(0, 1) || 'V';
  return <span className={`avatar${large ? ' avatar-large' : ''}`}>{url ? <img src={url} alt="" /> : initial}</span>;
}

export function StatusPill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'success' | 'warning' | 'danger' | 'muted' | 'blue' }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

export function PreviewFrame({ url, title, className = '', onStale }: { url?: string | null; title: string; className?: string; onStale?: () => void | Promise<void> }) {
  if (!url) return <div className={`preview-empty ${className}`}><span>◇</span><p>还没有可展示的预览版本</p><small>完成一次提交后，这里会显示你的真实网页。</small></div>;
  return <PreviewFrameContent url={url} title={title} className={className} onStale={onStale} />;
}

function previewId(url: string) {
  try { return /\/vibehub\/_preview\/([a-z0-9]+)\//i.exec(new URL(url).pathname)?.[1] || null; } catch { return null; }
}

function PreviewFrameContent({ url, title, className, onStale }: { url: string; title: string; className: string; onStale?: () => void | Promise<void> }) {
  const pid = previewId(url);
  const [grant, setGrant] = useState<{ source: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (!pid) return () => { active = false; };
    setGrant(null);
    api.previewGrant(pid)
      .then((result) => { if (active) setGrant({ source: url, url: result.preview_url }); })
      .catch((error) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 404 && onStale) {
          setGrant({ source: url, error: '作品状态刚刚变化，正在同步最新地址…' });
          void onStale();
          return;
        }
        setGrant({ source: url, error: readableError(error, '这个预览已失效。') });
      });
    return () => { active = false; };
  }, [onStale, pid, url]);
  if (pid && grant?.source !== url) return <div className={`preview-empty ${className}`}><span>◇</span><p>正在准备安全预览…</p><small>只会向项目本人和本课程老师开放。</small></div>;
  if (pid && grant?.error) return <div className={`preview-empty ${className}`}><span>!</span><p>这个预览暂时打不开</p><small>{grant.error}</small></div>;
  const safeUrl = pid ? grant?.url : url;
  return <iframe className={`preview-frame ${className}`} title={title} src={safeUrl} sandbox="allow-scripts allow-forms allow-popups allow-same-origin" />;
}

export function WorkThumbnail({ url, coverUrl, title }: { url?: string | null; coverUrl?: string | null; title: string }) {
  if (coverUrl) return <div className="work-thumbnail"><img src={coverUrl} alt={`${title} 的封面`} /></div>;
  if (url) return <div className="work-thumbnail work-thumbnail-live"><iframe title={`${title} 的缩略预览`} src={url} sandbox="allow-scripts allow-forms allow-popups allow-same-origin" tabIndex={-1} /></div>;
  return <div className="work-thumbnail work-thumbnail-empty"><span>V</span><small>暂未提供作品封面</small></div>;
}

export function useQrCode(value?: string | null) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!value) {
      setImage(null);
      return () => { active = false; };
    }
    QRCode.toDataURL(value, { width: 156, margin: 1, color: { dark: '#242321', light: '#fbf9f5' } })
      .then((data) => { if (active) setImage(data); })
      .catch(() => { if (active) setImage(null); });
    return () => { active = false; };
  }, [value]);
  return image;
}

export function copyToClipboard(value?: string | null) {
  if (!value || !navigator.clipboard) return Promise.reject(new Error('当前浏览器无法复制网址。'));
  return navigator.clipboard.writeText(value);
}
