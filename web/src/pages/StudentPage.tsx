import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, readableError } from '../lib/api';
import { AppShell, ModeTabs } from '../components/Shell';
import { SubmissionCta } from '../components/SubmissionCta';
import { LoginRequired, PageState, PreviewFrame, StatusPill, copyToClipboard, useQrCode } from '../components/Ui';
import { diagnosisCompleteness, diagnosisEvidenceLabel, formatDateTime, formatDiagnosisPercentage, formatNumber, getDiagnosisState, getProjectPollInterval, getProjectStatus } from '../lib/presentation';
import { usePageVisibility } from '../lib/pageVisibility';
import type { DiagnosisItem, MeResponse, ProjectSnapshot } from '../lib/types';

export function StudentPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const pageVisible = usePageVisibility();
  const project = useQuery({ queryKey: ['project', me.data?.project_id], queryFn: () => api.project(me.data!.project_id!), enabled: Boolean(me.data?.project_id), retry: false, refetchInterval: (query) => {
    const snapshot = query.state.data as ProjectSnapshot | undefined;
    return getProjectPollInterval({ visible: pageVisible, diagnosis: snapshot?.latest_diagnosis, pending: Boolean(snapshot?.pending_version) });
  } });
  if (me.isPending) return <PageState />;
  if (me.isError) return <LoginRequired />;
  if (!me.data.project_id) return <NoProject campSlug={me.data.camp.slug} />;
  if (project.isPending) return <PageState title="正在打开你的项目…" />;
  if (project.isError) return <PageState error={project.error} action={<Link className="button button-coral" to="/login">重新登录</Link>} />;
  return <StudentDashboard snapshot={project.data} userName={me.data.user.display_name} identity={me.data} refreshProject={() => project.refetch().then(() => undefined)} />;
}

function NoProject({ campSlug }: { campSlug: string }) {
  return <AppShell active="我的项目" role="student" campSlug={campSlug}>
    <main className="dashboard-content narrow-content"><p className="breadcrumb">AI 产品共创课　/　我的项目</p><h1>你的作品还在准备中</h1><p className="empty-copy">请联系老师创建项目，准备完成后这里会显示提交和上线入口。</p></main>
  </AppShell>;
}

export function getStudentSubmissionAction({ pending, live, rejected }: { pending: boolean; live: boolean; rejected: boolean }) {
  if (pending) return { label: '提交新版本', note: '新提交会替代当前待审版本。' };
  if (rejected) return { label: '修改并重新提交', note: null };
  if (live) return { label: '提交下一版本', note: null };
  return { label: '提交我的游戏', note: null };
}

export function StudentSubmissionHeadingActions({ pending, live, rejected, campSlug }: { pending: boolean; live: boolean; rejected: boolean; campSlug: string }) {
  const action = getStudentSubmissionAction({ pending, live, rejected });
  return <div className="submission-heading-actions"><div><SubmissionCta label={action.label} />{action.note && <small>{action.note}</small>}</div><ModeTabs campSlug={campSlug} active="app" /></div>;
}

type StudentPreviewDependencies = {
  grantPreview: typeof api.previewGrant;
  openWindow: (url: string, target: string) => {
    opener: unknown;
    location: { replace: (url: string) => void };
    close: () => void;
  } | null;
  setNotice: (notice: string) => void;
  refreshProject?: () => Promise<void>;
};

function previewId(url: string) {
  try { return /\/vibehub\/_preview\/([a-z0-9]+)\//i.exec(new URL(url).pathname)?.[1] || null; } catch { return null; }
}

export async function openStudentPreview(url: string, dependencies: StudentPreviewDependencies) {
  const child = dependencies.openWindow('about:blank', '_blank');
  if (!child) {
    dependencies.setNotice('浏览器拦截了预览窗口，请允许弹窗后重试。');
    return;
  }
  try {
    child.opener = null;
    const pid = previewId(url);
    const destination = pid ? (await dependencies.grantPreview(pid)).preview_url : url;
    child.location.replace(destination);
  } catch (error) {
    child.close();
    if (error instanceof ApiError && error.status === 404 && dependencies.refreshProject) {
      dependencies.setNotice('作品状态刚刚变化，正在同步最新地址…');
      await dependencies.refreshProject();
      return;
    }
    dependencies.setNotice('这个预览暂时打不开。');
  }
}

export function StudentDashboard({ snapshot, userName, identity, refreshProject }: { snapshot: ProjectSnapshot; userName: string; identity?: MeResponse; refreshProject?: () => Promise<void> }) {
  const { project, camp, pending_version: pending, live_version: live, latest_diagnosis: diagnosis, stats, timeline, last_review: review } = snapshot;
  const previewUrl = pending?.preview_url || project.live_url || null;
  const status = getProjectStatus({ publish_status: project.publish_status, pending_version: pending, last_review: review });
  const qrImage = useQrCode(project.live_url);
  const [notice, setNotice] = useState<string | null>(null);
  const handleStalePreview = useCallback(async () => {
    if (!refreshProject) return;
    setNotice('作品状态刚刚变化，正在同步最新地址…');
    await refreshProject();
  }, [refreshProject]);
  const openPreview = () => {
    if (!previewUrl) return;
    void openStudentPreview(previewUrl, {
      grantPreview: api.previewGrant,
      openWindow: (url, target) => window.open(url, target),
      setNotice,
      refreshProject,
    });
  };
  const copy = () => {
    copyToClipboard(project.live_url).then(() => setNotice('网址已复制')).catch((error) => setNotice(readableError(error, '暂时无法复制网址。')));
  };
  return <AppShell active="我的项目" role="student" campSlug={camp.slug} avatar={userName}>
    <main className="dashboard-content">
      <header className="page-heading submission-entry-heading">
        <div><p className="breadcrumb">{camp.name}　/　我的项目</p><h1>{project.title}</h1><div className="project-meta"><StatusPill tone={status.tone}>{status.label}</StatusPill><span>{pending?.label || live?.label || '尚未提交版本'}</span><b>·</b><span>{formatDateTime(project.updated_at)} 更新</span></div></div>
        <StudentSubmissionHeadingActions pending={Boolean(pending)} live={Boolean(live)} rejected={!pending && review?.status === 'rejected'} campSlug={camp.slug} />
      </header>
      {!pending && review?.status === 'rejected' && review.comment && <section className="review-alert"><span>!</span><div><strong>老师退回了这次提交</strong><p>{review.comment}</p></div></section>}
      {notice && <p className="toast" role="status">{notice}</p>}
      <section className="student-top-grid">
        <article className="panel work-panel">
          <PanelKicker kicker="我的作品" title="现在的项目长这样" icon="✧" action={previewUrl ? <button type="button" className="panel-link-button" onClick={openPreview}>打开预览 ↗</button> : undefined} />
          <PreviewFrame url={previewUrl} title={`${project.title} 的预览`} className="student-preview" onStale={refreshProject ? handleStalePreview : undefined} />
        </article>
        <aside className="student-side-stack">
          {identity && <StudentIdentityCard identity={identity} />}
          <AccessPanel url={project.live_url} qrImage={qrImage} onCopy={copy} />
          <StatsPanel stats={stats} />
        </aside>
      </section>
      <section className="student-bottom-grid">
        <DiagnosisPanel diagnosis={diagnosis} />
        <VersionPanel live={live} pending={pending} review={review} />
      </section>
      <TimelinePanel timeline={timeline} />
    </main>
  </AppShell>;
}

export function StudentIdentityCard({ identity }: { identity: MeResponse }) {
  const client = useQueryClient();
  const [realName, setRealName] = useState(identity.user.real_name || '');
  const [displayName, setDisplayName] = useState(identity.user.display_name || '');
  const update = useMutation({
    mutationFn: api.updateProfile,
    onSuccess: () => client.invalidateQueries({ queryKey: ['me'] }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ display_name: displayName.trim(), ...(identity.profile?.verification_status === 'self_reported' ? { real_name: realName.trim() } : {}) });
  };
  const verified = identity.profile?.verification_status === 'verified';
  return <article className="panel student-identity-card"><PanelKicker kicker="学员身份" title="你的名字" icon="☺" /><form onSubmit={submit}><label htmlFor="student-real-name">真实姓名 <small>仅老师可见</small></label><input id="student-real-name" value={realName} maxLength={40} disabled={verified || update.isPending} onChange={(event) => setRealName(event.target.value)} /><label htmlFor="student-display-name">公开昵称 <small>作品集合会显示</small></label><input id="student-display-name" value={displayName} maxLength={40} disabled={update.isPending} onChange={(event) => setDisplayName(event.target.value)} />{verified ? <small className="identity-status">老师已确认真实姓名</small> : <small className="identity-status">学员自填 · 等待老师确认</small>}{update.isError && <p className="form-error" role="alert">{readableError(update.error, '资料暂时无法保存。')}</p>}<button className="button button-outline" disabled={!displayName.trim() || (!verified && !realName.trim()) || update.isPending}>{update.isPending ? '保存中…' : '保存资料'}</button></form></article>;
}

function PanelKicker({ kicker, title, icon, action }: { kicker: string; title: string; icon?: string; action?: ReactNode }) {
  return <div className="panel-heading"><div><small>{kicker}</small><h2>{icon && <i>{icon}</i>}{title}</h2></div>{action}</div>;
}

function AccessPanel({ url, qrImage, onCopy }: { url?: string | null; qrImage: string | null; onCopy: () => void }) {
  if (!url) return <article className="panel access-panel"><PanelKicker kicker="访问入口" title="你的网页" icon="◎" /><div className="access-empty"><strong>还没有正式上线</strong><p>审核通过后，这里会出现可以分享给访客的网址和二维码。</p></div></article>;
  return <article className="panel access-panel"><PanelKicker kicker="访问入口" title="你的网页" icon="◎" /><div className="url-field"><span>↗</span><a href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, '')}</a></div><div className="access-actions"><div className="qr-wrap">{qrImage ? <img src={qrImage} alt="作品网址二维码" /> : <span>二维码生成中</span>}</div><div><button className="button button-outline" onClick={onCopy}>▣　复制网址</button><a className="button button-outline" href={url} target="_blank" rel="noreferrer">↗　打开网页</a></div></div></article>;
}

function StatsPanel({ stats }: { stats: ProjectSnapshot['stats'] }) {
  return <article className="panel stats-panel"><PanelKicker kicker="运营现状" title="上线后的表现" icon="▥" /><div className="total-stat"><strong>{formatNumber(stats.total_views)}</strong><span>累计浏览量</span></div><div className="stats-metrics"><div><strong>{formatNumber(stats.today_views)}</strong><span>今日浏览</span></div><div><strong>—</strong><span>独立访客</span></div><div><strong>—</strong><span>近 7 天</span></div></div><p className="stats-note">数据仅统计正式上线后的访问</p></article>;
}

function DiagnosisPanel({ diagnosis }: { diagnosis: ProjectSnapshot['latest_diagnosis'] }) {
  const completeness = diagnosisCompleteness(diagnosis);
  const blocked = diagnosis?.blocked || diagnosis?.status === 'blocked';
  const summary = diagnosis?.summary || (diagnosis?.status === 'running' ? '正在诊断，完成后会显示检查结果。' : '诊断已完成，继续查看每一项检查结果。');
  return <article className="panel diagnosis-panel"><div className="diagnosis-top"><PanelKicker kicker="当前界面现状" title="开发完成度" icon="▤" /><div className="diagnosis-metrics"><strong>{formatDiagnosisPercentage(completeness)}</strong><small>验证覆盖率 {formatDiagnosisPercentage(diagnosis?.verified_ratio)}</small>{diagnosis?.stale && <StatusPill tone="blue">诊断更新中</StatusPill>}{blocked && <StatusPill tone="danger">有阻塞问题</StatusPill>}</div></div>{!diagnosis ? <div className="inner-empty"><strong>还没有诊断结果</strong><p>提交一个可预览的版本后，系统会在这里列出检查结果。</p></div> : <><div className="diagnosis-list">{diagnosis.items.map((item, index) => <DiagnosisRow key={`${item.check_key || item.label}-${index}`} item={item} />)}</div><div className="diagnosis-summary">●　{summary}</div></>}</article>;
}

function DiagnosisRow({ item }: { item: DiagnosisItem }) {
  const state = getDiagnosisState(item);
  return <div className={`diagnosis-row${state.muted ? ' is-muted' : ''}`}><div className="diagnosis-label"><DiagnosisIcon checkKey={item.check_key} /><div><b>{item.label || '未命名检查项'}</b><small>{diagnosisEvidenceLabel(item)}</small></div></div><div className="diagnosis-score">{state.ratio && <span className="progress"><i style={{ width: state.ratio }} /></span>}<strong>{state.label}</strong></div></div>;
}

function DiagnosisIcon({ checkKey }: { checkKey?: string }) {
  const icon = checkKey === 'artifact_entry' ? 'home' : checkKey === 'refs_resolve' ? 'files' : checkKey === 'preview_reachable' ? 'preview' : checkKey === 'baas_connected' ? 'data' : checkKey === 'core_flows' ? 'flow' : 'content';
  return <span className="diagnosis-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icon === 'home' && <><path d="m3.5 10 8.5-7 8.5 7" /><path d="M5.5 9.2V21h13V9.2" /><path d="M9.5 21v-6h5v6" /></>}{icon === 'files' && <><path d="M8 4.5h9.5A1.5 1.5 0 0 1 19 6v12.5A1.5 1.5 0 0 1 17.5 20H8A1.5 1.5 0 0 1 6.5 18.5V6A1.5 1.5 0 0 1 8 4.5Z" /><path d="M5 8H4a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 20h10" /><path d="M10 9h5M10 13h5" /></>}{icon === 'preview' && <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8.5 21h7M12 18v3" /><path d="m10 9 4 2.1-4 2.1Z" /></>}{icon === 'data' && <><ellipse cx="12" cy="5" rx="7.5" ry="2.5" /><path d="M4.5 5v7c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V5" /><path d="M4.5 12v7c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-7" /></>}{icon === 'flow' && <><path d="M7 4h5a3 3 0 0 1 3 3v1" /><path d="m12.5 5.5 2.5 2.5-2.5 2.5" /><path d="M17 20h-5a3 3 0 0 1-3-3v-1" /><path d="m11.5 18.5-2.5-2.5 2.5-2.5" /></>}{icon === 'content' && <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>}</svg></span>;
}

function VersionPanel({ live, pending, review }: { live: ProjectSnapshot['live_version']; pending: ProjectSnapshot['pending_version']; review: ProjectSnapshot['last_review'] }) {
  const label = pending ? '等待老师审核' : review?.status === 'rejected' ? '需要修改后重新提交' : live ? '当前线上版本已稳定运行' : '还没有可审核的版本';
  return <article className="panel versions-panel"><PanelKicker kicker="部署与审核" title="两个版本，要分清" icon="♧" /><div className="version-columns"><VersionColumn title="当前线上版本" version={live} description="访客现在看到的是这个版本" status="●" /><VersionColumn title="新提交版本" version={pending} description="审核通过后才会替换线上版本" status="◔" pending /></div><div className="version-footer"><span className={pending ? 'status-dot status-warning' : 'status-dot status-muted'} />{label}<small>{pending ? '通常会在课程结束前完成' : ''}</small></div></article>;
}

function VersionColumn({ title, version, description, status, pending = false }: { title: string; version: ProjectSnapshot['live_version']; description: string; status: string; pending?: boolean }) {
  return <div className="version-column"><small className={pending ? 'pending-title' : 'live-title'}>{status}　{title}</small><strong>{version?.label || (pending ? '暂未提交' : '还没有正式上线')}</strong><span>{version?.submitted_at ? formatDateTime(version.submitted_at) : pending ? '完成提交后显示在这里' : '审核通过后会在这里显示'}</span><p>{description}</p></div>;
}

function TimelinePanel({ timeline }: { timeline: ProjectSnapshot['timeline'] }) {
  return <article className="panel timeline-panel"><PanelKicker kicker="项目记录" title="最近发生了什么" icon="◔" action={<span className="muted-link">查看全部　›</span>} />{timeline.length ? <ol className="timeline-list">{timeline.slice(0, 4).map((event, index) => <li key={`${event.at}-${index}`}><b>{String(index + 1).padStart(2, '0')}</b><div><small>{formatDateTime(event.at)}</small><strong>{event.title || '项目有新的进展'}</strong><span>{event.detail || '查看项目了解详情'}</span></div></li>)}</ol> : <div className="inner-empty"><strong>还没有项目记录</strong><p>提交、审核和发布后，最近发生的事会出现在这里。</p></div>}</article>;
}
