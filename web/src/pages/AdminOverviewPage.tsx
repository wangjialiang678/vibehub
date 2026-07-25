import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { TeacherPage } from '../components/TeacherPage';
import { ModeTabs } from '../components/Shell';
import { PageState, StatusPill } from '../components/Ui';
import { api } from '../lib/api';
import { formatDateTime, getProjectStatus } from '../lib/presentation';
import type { CampOverview } from '../lib/types';

const metrics: Array<{ key: keyof CampOverview['counts']; label: string; tone?: 'success' | 'warning' | 'danger' | 'blue' }> = [
  { key: 'members', label: '参与人数' },
  { key: 'invites_bound', label: '已绑定', tone: 'blue' },
  { key: 'projects', label: '项目数' },
  { key: 'not_started', label: '未开始' },
  { key: 'developing', label: '开发中', tone: 'blue' },
  { key: 'pending_review', label: '待审核', tone: 'warning' },
  { key: 'published', label: '已发布', tone: 'success' },
  { key: 'needs_revision', label: '被驳回', tone: 'danger' },
];

export function AdminOverviewPage() {
  return <TeacherPage active="总览">{(session) => <OverviewDesk campId={session.camp.id} campSlug={session.camp.slug} campName={session.camp.name} />}</TeacherPage>;
}

function OverviewDesk({ campId, campSlug, campName }: { campId: string; campSlug: string; campName: string }) {
  const overview = useQuery({ queryKey: ['overview', campId], queryFn: () => api.overview(campId), retry: false });
  if (overview.isPending) return <PageState title="正在整理课程进度…" />;
  if (overview.isError) return <PageState error={overview.error} />;

  return <main className="dashboard-content teacher-content">
    <header className="page-heading">
      <div><p className="breadcrumb">{campName}　/　总览</p><h1>营地进度</h1><p className="review-counts">看见每一位学员现在走到哪一步。</p></div>
      <div className="teacher-heading-actions"><Link className="button button-outline" to="/admin/invites">管理邀请码</Link><ModeTabs campSlug={campSlug} active="admin" /></div>
    </header>
    <section className="overview-metrics" aria-label="课程进度统计">{metrics.map((metric) => <article className="panel overview-metric" key={metric.key}><strong>{overview.data.counts[metric.key] ?? 0}</strong><span>{metric.tone ? <StatusPill tone={metric.tone}>{metric.label}</StatusPill> : metric.label}</span></article>)}</section>
    <section className="teacher-two-columns">
      <article className="panel teacher-list-panel"><header><div><p className="eyebrow">需要关注</p><h2>卡住了的人</h2></div><span>{overview.data.stale.length} 个项目</span></header>{overview.data.stale.length ? <ul className="teacher-project-list">{overview.data.stale.map((item) => <li key={item.id}><div><strong>{item.title || '未命名作品'}</strong><span>{item.owner}　·　最后活动 {formatDateTime(item.updated_at)}</span></div><Link className="button button-outline" to={`/admin/projects/${item.id}`}>查看看板</Link></li>)}</ul> : <EmptyState title="暂时没有卡住的项目" detail="项目长时间没有更新时，会自动出现在这里。" />}</article>
      <article className="panel teacher-list-panel"><header><div><p className="eyebrow">刚刚发生</p><h2>最近动态</h2></div><span>最近 {overview.data.recent.length} 项</span></header>{overview.data.recent.length ? <ul className="teacher-project-list">{overview.data.recent.map((item) => { const status = getProjectStatus({ publish_status: item.publish_status, pending_version: item.dev_status === 'submittable' ? item.id : null, last_review: item.dev_status === 'needs_revision' ? { status: 'rejected' } : null }); return <li key={item.id}><div><strong>{item.title || '未命名作品'}</strong><span>{item.owner}　·　{formatDateTime(item.updated_at)}</span></div><Link className="activity-link" to={`/admin/projects/${item.id}`}><StatusPill tone={status.tone}>{status.label}</StatusPill></Link></li>; })}</ul> : <EmptyState title="还没有项目动态" detail="学员创建或更新项目后，会出现在这里。" />}</article>
    </section>
  </main>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="teacher-empty"><strong>{title}</strong><p>{detail}</p></div>;
}
