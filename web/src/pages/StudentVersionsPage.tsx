import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AppShell, ModeTabs } from '../components/Shell';
import { SubmissionCta } from '../components/SubmissionCta';
import { LoginRequired, PageState, StatusPill } from '../components/Ui';
import { api } from '../lib/api';
import { formatDateTime, formatDiagnosisPercentage, getVersionHistoryPollInterval, getVersionReviewStatus } from '../lib/presentation';
import { usePageVisibility } from '../lib/pageVisibility';
import type { VersionHistory } from '../lib/types';

export function StudentVersionsPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const pageVisible = usePageVisibility();
  const versions = useQuery({ queryKey: ['versions', me.data?.project_id], queryFn: () => api.versions(me.data!.project_id!), enabled: Boolean(me.data?.project_id), retry: false, refetchInterval: (query) => getVersionHistoryPollInterval({ visible: pageVisible, reviewStatuses: query.state.data?.items.map((version) => version.review?.status) || [] }) });
  if (me.isPending) return <PageState />;
  if (me.isError) return <LoginRequired />;
  if (!me.data.project_id) return <AppShell active="提交记录" role="student" campSlug={me.data.camp.slug} avatar={me.data.user.display_name}><main className="dashboard-content narrow-content"><p className="breadcrumb">{me.data.camp.name}　/　提交记录</p><h1>还没有可以查看的提交</h1><p className="empty-copy">请联系老师创建项目，准备完成后每次提交都会留在这里。</p></main></AppShell>;
  if (versions.isPending) return <PageState title="正在读取提交记录…" />;
  if (versions.isError) return <PageState error={versions.error} action={<Link className="button button-coral" to="/login">重新登录</Link>} />;

  return <AppShell active="提交记录" role="student" campSlug={me.data.camp.slug} avatar={me.data.user.display_name}>
    <main className="dashboard-content version-history-page">
      <header className="page-heading submission-entry-heading"><div><p className="breadcrumb">{me.data.camp.name}　/　提交记录</p><h1>每一次提交，都有回音</h1><p className="review-counts"><b>{versions.data.items.length}</b> 条最近记录　·　按最新提交排序</p></div><VersionSubmissionActions campSlug={me.data.camp.slug} /></header>
      {versions.data.items.length ? <section className="panel version-history-panel"><header><div><p className="eyebrow">版本时间线</p><h2>提交与审核记录</h2></div><span>诊断完成度会在检查结束后显示</span></header><ol className="version-history-list">{versions.data.items.map((version) => <VersionHistoryRow key={version.id} version={version} />)}</ol></section> : <section className="panel version-history-empty"><span>◔</span><strong>还没有提交过版本</strong><p>完成第一版作品后提交，老师的审核结果和诊断完成度都会记录在这里。</p><VersionSubmissionActions campSlug={me.data.camp.slug} empty /></section>}
    </main>
  </AppShell>;
}

export function VersionSubmissionActions({ campSlug, empty = false }: { campSlug: string; empty?: boolean }) {
  if (empty) return <SubmissionCta label="开始第一次提交" />;
  return <div className="submission-heading-actions"><SubmissionCta label="提交新版本" /><ModeTabs campSlug={campSlug} active="app" /></div>;
}

function VersionHistoryRow({ version }: { version: VersionHistory }) {
  const review = getVersionReviewStatus(version.review?.status);
  return <li className={`version-history-item is-${review.tone}`}>
    <span className="version-history-marker" aria-hidden="true" />
    <article>
      <header><div><small>第 {version.seq ?? '—'} 次提交</small><h2>{version.label || '未命名版本'}</h2></div><StatusPill tone={review.tone}>{review.label}</StatusPill></header>
      <p className="version-history-summary">{version.summary || '这次还没有填写更新说明。'}</p>
      {version.review?.status === 'rejected' && version.review.comment && <div className="version-history-feedback"><strong>老师的退回意见</strong><p>{version.review.comment}</p></div>}
      <footer><span>提交于 {formatDateTime(version.submitted_at)}</span><span>诊断完成度 <b>{formatDiagnosisPercentage(version.diagnosis_score)}</b></span></footer>
    </article>
  </li>;
}
