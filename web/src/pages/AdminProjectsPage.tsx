import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { TeacherPage } from '../components/TeacherPage';
import { ModeTabs } from '../components/Shell';
import { PageState, PreviewFrame, StatusPill } from '../components/Ui';
import { api, readableError } from '../lib/api';
import { formatDateTime, getProjectStatus } from '../lib/presentation';
import type { CampProject, CollectionUpdate } from '../lib/types';

export function AdminProjectsPage() {
  return <TeacherPage active="项目">{(session) => <ProjectsDesk campId={session.camp.id} campSlug={session.camp.slug} campName={session.camp.name} />}</TeacherPage>;
}

function ProjectsDesk({ campId, campSlug, campName }: { campId: string; campSlug: string; campName: string }) {
  const { projectId } = useParams();
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ['projects', campId], queryFn: () => api.projects(campId), retry: false });
  const selected = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId!), enabled: Boolean(projectId), retry: false });
  const [collectionItems, setCollectionItems] = useState<CampProject[]>([]);
  const [collectionNotice, setCollectionNotice] = useState<string | null>(null);
  const collectionMutation = useMutation({
    mutationFn: (items: CollectionUpdate[]) => api.updateCollection(campId, items),
    onSuccess: (result) => {
      setCollectionNotice(result.message);
      void queryClient.invalidateQueries({ queryKey: ['projects', campId] });
      void queryClient.invalidateQueries({ queryKey: ['collection', campSlug] });
    },
    onError: (error) => {
      setCollectionNotice(readableError(error, '集合页设置暂时没有保存，请稍后再试。'));
      setCollectionItems(orderCollectionItems(projects.data?.items || []));
    },
  });
  useEffect(() => {
    setCollectionItems(orderCollectionItems(projects.data?.items || []));
  }, [projects.data?.items]);
  if (projects.isPending) return <PageState title="正在读取项目列表…" />;
  if (projects.isError) return <PageState error={projects.error} />;

  const saveCollection = (items: CampProject[], updates: CollectionUpdate[]) => {
    setCollectionNotice(null);
    setCollectionItems(items);
    if (updates.length) collectionMutation.mutate(updates);
  };
  const moveItem = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= collectionItems.length || Boolean(collectionItems[index].collection_recommended) !== Boolean(collectionItems[nextIndex].collection_recommended)) return;
    let groupStart = index;
    let groupEnd = index;
    while (groupStart > 0 && Boolean(collectionItems[groupStart - 1].collection_recommended) === Boolean(collectionItems[index].collection_recommended)) groupStart -= 1;
    while (groupEnd < collectionItems.length - 1 && Boolean(collectionItems[groupEnd + 1].collection_recommended) === Boolean(collectionItems[index].collection_recommended)) groupEnd += 1;
    const before = collectionItems.slice(groupStart, groupEnd + 1);
    const moved = [...before];
    const localIndex = index - groupStart;
    [moved[localIndex], moved[localIndex + direction]] = [moved[localIndex + direction], moved[localIndex]];
    const after = moved.map((item, order) => ({ ...item, collection_order: order }));
    const updates = getCollectionUpdates(before, after);
    saveCollection([...collectionItems.slice(0, groupStart), ...after, ...collectionItems.slice(groupEnd + 1)], updates);
  };
  const toggleFeatured = (projectId: string) => {
    const changed = collectionItems.find((item) => item.id === projectId);
    if (!changed) return;
    const next = orderCollectionItems(collectionItems.map((item) => item.id === projectId ? { ...item, collection_recommended: !item.collection_recommended } : item));
    const updated = next.find((item) => item.id === projectId)!;
    saveCollection(next, [toCollectionUpdate(updated)]);
  };

  return <main className="dashboard-content teacher-content">
    <header className="page-heading"><div><p className="breadcrumb">{campName}　/　项目</p><h1>全部项目</h1><p className="review-counts"><b>{projects.data.items.length}</b> 个项目　·　按最近更新排序</p></div><ModeTabs campSlug={campSlug} active="admin" /></header>
    {collectionNotice && <p className="action-message">{collectionNotice}</p>}
    <section className="panel collection-manager"><header><div><p className="eyebrow">公开集合页</p><h2>集合页编排</h2><p>推荐作品会固定在最前；可分别调整推荐区和普通区的顺序。</p></div><span>{collectionMutation.isPending ? '正在保存…' : '保存后立即生效'}</span></header>{collectionItems.length ? <ol>{collectionItems.map((item, index) => { const recommended = Boolean(item.collection_recommended); const previousSameGroup = index > 0 && recommended === Boolean(collectionItems[index - 1].collection_recommended); const nextSameGroup = index < collectionItems.length - 1 && recommended === Boolean(collectionItems[index + 1].collection_recommended); return <li key={item.id}><div><strong>{item.title || '未命名作品'}</strong><span>{item.owner_name}　·　{recommended ? '推荐位' : '普通作品'}</span></div><div className="collection-manager-actions"><button className={recommended ? 'is-featured' : ''} onClick={() => toggleFeatured(item.id)} disabled={collectionMutation.isPending}>{recommended ? '取消推荐' : '设为推荐'}</button><button aria-label={`上移 ${item.title}`} onClick={() => moveItem(index, -1)} disabled={!previousSameGroup || collectionMutation.isPending}>上移</button><button aria-label={`下移 ${item.title}`} onClick={() => moveItem(index, 1)} disabled={!nextSameGroup || collectionMutation.isPending}>下移</button></div></li>; })}</ol> : <div className="teacher-empty"><strong>课程里还没有项目</strong><p>作品创建后，可以在这里调整它在公开集合页中的位置。</p></div>}</section>
    <section className={`projects-workspace${projectId ? ' has-selected' : ''}`}>
      <article className="panel project-directory">{projects.data.items.length ? <ul>{projects.data.items.map((item) => { const status = getProjectStatus({ publish_status: item.publish_status, pending_version: item.pending_version_id, last_review: item.dev_status === 'needs_revision' ? { status: 'rejected' } : null }); return <li className={item.id === projectId ? 'is-current' : ''} key={item.id}><Link to={`/admin/projects/${item.id}`}><div><strong>{item.title || '未命名作品'}</strong><span>{item.owner_name}　·　{formatDateTime(item.updated_at)}</span></div><StatusPill tone={status.tone}>{status.label}</StatusPill></Link></li>; })}</ul> : <div className="teacher-empty"><strong>课程里还没有项目</strong><p>学员使用邀请码进入后，会自动创建自己的项目。</p></div>}</article>
      {projectId && <ProjectBoard isLoading={selected.isPending} error={selected.error} snapshot={selected.data} />}
    </section>
  </main>;
}

function orderCollectionItems(items: CampProject[]) {
  return [...items].sort((a, b) => Number(Boolean(b.collection_recommended)) - Number(Boolean(a.collection_recommended)) || Number(a.collection_order || 0) - Number(b.collection_order || 0) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

function toCollectionUpdate(item: CampProject): CollectionUpdate {
  return { project_id: item.id, order: Number(item.collection_order || 0), recommended: Boolean(item.collection_recommended) };
}

export function getCollectionUpdates(before: CampProject[], after: CampProject[]): CollectionUpdate[] {
  const beforeByProjectId = new Map(before.map((item) => [item.id, toCollectionUpdate(item)]));
  return after.filter((item) => {
    const previous = beforeByProjectId.get(item.id);
    const current = toCollectionUpdate(item);
    return !previous || previous.order !== current.order || previous.recommended !== current.recommended;
  }).map(toCollectionUpdate);
}

function ProjectBoard({ isLoading, error, snapshot }: { isLoading: boolean; error: unknown; snapshot: Awaited<ReturnType<typeof api.project>> | undefined }) {
  if (isLoading) return <article className="panel project-board"><div className="teacher-empty">正在打开项目看板…</div></article>;
  if (error || !snapshot) return <article className="panel project-board"><div className="teacher-empty">暂时无法打开这个项目。</div></article>;
  const version = snapshot.pending_version || snapshot.live_version;
  const previewUrl = snapshot.pending_version?.preview_url || snapshot.project.live_url;
  const status = getProjectStatus({ publish_status: snapshot.project.publish_status, pending_version: snapshot.pending_version, last_review: snapshot.last_review });
  return <article className="panel project-board"><header><div><p className="eyebrow">{snapshot.owner.display_name} 的项目</p><h2>{snapshot.project.title}</h2></div><StatusPill tone={status.tone}>{status.label}</StatusPill></header><PreviewFrame url={previewUrl} title={`${snapshot.project.title} 的项目看板`} className="teacher-project-preview" /><dl className="project-board-meta"><div><dt>当前版本</dt><dd>{version?.label || '还未提交'}</dd></div><div><dt>最后活动</dt><dd>{formatDateTime(snapshot.project.updated_at)}</dd></div><div><dt>诊断状态</dt><dd>{snapshot.latest_diagnosis?.stale ? '诊断更新中' : snapshot.latest_diagnosis?.status || '尚未诊断'}</dd></div></dl></article>;
}
