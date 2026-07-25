import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { TeacherPage } from '../components/TeacherPage';
import { ModeTabs } from '../components/Shell';
import { PageState, PreviewFrame, StatusPill } from '../components/Ui';
import { api } from '../lib/api';
import { formatDateTime, getProjectStatus } from '../lib/presentation';

export function AdminProjectsPage() {
  return <TeacherPage active="项目">{(session) => <ProjectsDesk campId={session.camp.id} campSlug={session.camp.slug} campName={session.camp.name} />}</TeacherPage>;
}

function ProjectsDesk({ campId, campSlug, campName }: { campId: string; campSlug: string; campName: string }) {
  const { projectId } = useParams();
  const projects = useQuery({ queryKey: ['projects', campId], queryFn: () => api.projects(campId), retry: false });
  const selected = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId!), enabled: Boolean(projectId), retry: false });
  if (projects.isPending) return <PageState title="正在读取项目列表…" />;
  if (projects.isError) return <PageState error={projects.error} />;

  return <main className="dashboard-content teacher-content">
    <header className="page-heading"><div><p className="breadcrumb">{campName}　/　项目</p><h1>全部项目</h1><p className="review-counts"><b>{projects.data.items.length}</b> 个项目　·　按最近更新排序</p></div><ModeTabs campSlug={campSlug} active="admin" /></header>
    <section className={`projects-workspace${projectId ? ' has-selected' : ''}`}>
      <article className="panel project-directory">{projects.data.items.length ? <ul>{projects.data.items.map((item) => { const status = getProjectStatus({ publish_status: item.publish_status, pending_version: item.pending_version_id, last_review: item.dev_status === 'needs_revision' ? { status: 'rejected' } : null }); return <li className={item.id === projectId ? 'is-current' : ''} key={item.id}><Link to={`/admin/projects/${item.id}`}><div><strong>{item.title || '未命名作品'}</strong><span>{item.owner_name}　·　{formatDateTime(item.updated_at)}</span></div><StatusPill tone={status.tone}>{status.label}</StatusPill></Link></li>; })}</ul> : <div className="teacher-empty"><strong>课程里还没有项目</strong><p>学员使用邀请码进入后，会自动创建自己的项目。</p></div>}</article>
      {projectId && <ProjectBoard isLoading={selected.isPending} error={selected.error} snapshot={selected.data} />}
    </section>
  </main>;
}

function ProjectBoard({ isLoading, error, snapshot }: { isLoading: boolean; error: unknown; snapshot: Awaited<ReturnType<typeof api.project>> | undefined }) {
  if (isLoading) return <article className="panel project-board"><div className="teacher-empty">正在打开项目看板…</div></article>;
  if (error || !snapshot) return <article className="panel project-board"><div className="teacher-empty">暂时无法打开这个项目。</div></article>;
  const version = snapshot.pending_version || snapshot.live_version;
  const status = getProjectStatus({ publish_status: snapshot.project.publish_status, pending_version: snapshot.pending_version, last_review: snapshot.last_review });
  return <article className="panel project-board"><header><div><p className="eyebrow">{snapshot.owner.display_name} 的项目</p><h2>{snapshot.project.title}</h2></div><StatusPill tone={status.tone}>{status.label}</StatusPill></header><PreviewFrame url={version?.preview_url} title={`${snapshot.project.title} 的项目看板`} className="teacher-project-preview" /><dl className="project-board-meta"><div><dt>当前版本</dt><dd>{version?.label || '还未提交'}</dd></div><div><dt>最后活动</dt><dd>{formatDateTime(snapshot.project.updated_at)}</dd></div><div><dt>诊断状态</dt><dd>{snapshot.latest_diagnosis?.stale ? '诊断更新中' : snapshot.latest_diagnosis?.status || '尚未诊断'}</dd></div></dl></article>;
}
