import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type SidebarIconName = 'home' | 'folder' | 'history' | 'book';

export function AppShell({ children, active, role, campSlug = 'ai-product-2026s', avatar = 'V' }: { children: ReactNode; active: string; role: 'student' | 'teacher'; campSlug?: string; avatar?: string }) {
  const activeLabel = active;
  const desktopNav: Array<{ label: string; icon: SidebarIconName; to?: string }> = role === 'teacher'
    ? [{ label: '总览', to: '/admin/overview', icon: 'home' }, { label: '项目', to: '/admin/projects', icon: 'folder' }, { label: '审核', to: '/admin', icon: 'history' }, { label: '集合页', to: `/c/${campSlug}`, icon: 'book' }]
    : [{ label: '概览', to: '/app', icon: 'home' }, { label: '我的项目', to: '/app', icon: 'folder' }, { label: '提交记录', to: '/app/versions', icon: 'history' }, { label: '作品集合', to: `/c/${campSlug}`, icon: 'book' }];
  return (
    <div className="dashboard-layout">
      <aside className="side-nav">
        <div className="side-nav-links">
          {desktopNav.map((item) => item.to ? <Link to={item.to} className={`side-nav-item${item.label === activeLabel ? ' is-active' : ''}`} key={item.label}><SidebarIcon name={item.icon} />{item.label}</Link> : <span className={`side-nav-item${item.label === activeLabel ? ' is-active' : ''}`} key={item.label}><SidebarIcon name={item.icon} />{item.label}</span>)}
        </div>
        <span className="side-avatar">{avatar.slice(0, 1)}</span>
      </aside>
      <div className="dashboard-main">
        <header className="mobile-topbar"><Link to={role === 'teacher' ? '/admin' : '/app'}>VibeHub</Link><ModeTabs campSlug={campSlug} active={role === 'teacher' ? 'admin' : 'app'} /></header>
        {children}
      </div>
    </div>
  );
}

function SidebarIcon({ name }: { name: SidebarIconName }) {
  return <span className="side-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{name === 'home' && <><path d="m3.5 10 8.5-7 8.5 7" /><path d="M5.5 9.2V21h13V9.2" /><path d="M9.5 21v-6h5v6" /></>}{name === 'folder' && <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2.5h7A2.5 2.5 0 0 1 21 10v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5Z" /><path d="M3 10h18" /></>}{name === 'history' && <><path d="M4.5 7.5V4.2M4.5 4.5h3.3" /><path d="M4.8 4.8A8.5 8.5 0 1 1 3.5 12" /><path d="M12 7v5l3.3 2" /></>}{name === 'book' && <><path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h10.5A2.5 2.5 0 0 1 20 5.5V20H7a2.5 2.5 0 0 0-2.5 2Z" /><path d="M4.5 5.5V20A2.5 2.5 0 0 1 7 17.5h13" /><path d="M9 7h7" /></>}</svg></span>;
}

export function ModeTabs({ campSlug = 'ai-product-2026s', active }: { campSlug?: string; active: 'app' | 'admin' | 'collection' }) {
  return <nav className="mode-tabs" aria-label="页面切换">
    <Link className={active === 'admin' ? 'is-current' : ''} to="/admin">管理端</Link>
    <Link className={active === 'app' ? 'is-current' : ''} to="/app">学员端</Link>
    <Link className={active === 'collection' ? 'is-current' : ''} to={`/c/${campSlug}`}>集合页</Link>
  </nav>;
}
