import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api, readableError } from '../lib/api';
import { AppShell, ModeTabs } from '../components/Shell';
import { Avatar, LoginRequired, PageState, PreviewFrame } from '../components/Ui';
import { formatDateTime, getReviewSummary } from '../lib/presentation';
import type { Diagnosis, ReviewDetail, ReviewQueueItem } from '../lib/types';

export function AdminPage() {
  const location = useLocation();
  const token = new URLSearchParams(location.search).get('token');
  const [ready, setReady] = useState(!token);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    document.cookie = `vh_session=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
    window.history.replaceState({}, '', location.pathname);
    setReady(true);
  }, [location.pathname, token]);
  const queue = useQuery({ queryKey: ['reviews'], queryFn: api.reviews, enabled: ready, retry: false });
  useEffect(() => {
    if (!selectedId && queue.data?.items[0]) setSelectedId(queue.data.items[0].id);
  }, [queue.data, selectedId]);
  const detail = useQuery({ queryKey: ['review', selectedId], queryFn: () => api.review(selectedId!), enabled: Boolean(selectedId), retry: false });
  if (!ready || queue.isPending) return <PageState title="正在打开审核队列…" />;
  if (queue.isError) {
    const unauthorized = 'status' in queue.error && (queue.error as { status: number }).status === 401;
    return unauthorized ? <LoginRequired admin /> : <PageState error={queue.error} />;
  }
  const handled = (message: string) => { setSelectedId(null); setNotice(message); };
  return <AppShell role="teacher" active="审核" campSlug="ai-product-2026s" avatar="师"><main className="dashboard-content admin-content"><header className="page-heading"><div><p className="breadcrumb">AI 产品共创课　/　审核</p><h1>部署审核</h1><p className="review-counts"><b>{queue.data.counts.pending ?? queue.data.items.length}</b> 个待处理　·　{queue.data.counts.published ?? 0} 个已发布</p></div><ModeTabs active="admin" /></header>{notice && <p className="action-message admin-notice">{notice}</p>}<section className="admin-workspace"><ReviewQueue items={queue.data.items} selectedId={selectedId} onSelect={setSelectedId} /><ReviewPane detail={detail.data} isLoading={detail.isPending} error={detail.error} onProcessed={handled} /></section></main></AppShell>;
}

function ReviewQueue({ items, selectedId, onSelect }: { items: ReviewQueueItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <aside className="review-queue">{items.length ? items.map((item) => <button key={item.id} className={`queue-item${item.id === selectedId ? ' is-selected' : ''}`} onClick={() => onSelect(item.id)}><Avatar name={item.owner_name} url={item.avatar_url} large /><span className="queue-project"><strong>{item.project_title || '未命名作品'}</strong><small>{item.label || '版本号未提供'}</small></span><span className="queue-time"><small>{formatDateTime(item.created_at).replace('今天 ', '')}</small><i className={`queue-dot queue-${item.status}`} /></span></button>) : <div className="queue-empty"><strong>没有待审核的作品</strong><p>新版本提交后，会自动出现在这里。</p></div>}</aside>;
}

function ReviewPane({ detail, isLoading, error, onProcessed }: { detail?: ReviewDetail; isLoading: boolean; error: unknown; onProcessed: (message: string) => void }) {
  const client = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const approve = useMutation({ mutationFn: (id: string) => api.approve(id), onSuccess: (data) => { onProcessed(data.message); client.invalidateQueries({ queryKey: ['reviews'] }); client.invalidateQueries({ queryKey: ['review'] }); } });
  const reject = useMutation({ mutationFn: ({ id, comment }: { id: string; comment: string }) => api.reject(id, comment), onSuccess: (data) => { setRejecting(false); setComment(''); onProcessed(data.message); client.invalidateQueries({ queryKey: ['reviews'] }); client.invalidateQueries({ queryKey: ['review'] }); } });
  if (isLoading) return <section className="review-detail"><div className="detail-empty">正在打开提交内容…</div></section>;
  if (error) return <section className="review-detail"><div className="detail-empty">{readableError(error)}</div></section>;
  if (!detail) return <section className="review-detail"><div className="detail-empty"><strong>选择一份作品开始审核</strong><p>待审核作品会出现在左边的队列中。</p></div></section>;
  const submitReject = (event: FormEvent) => { event.preventDefault(); if (comment.trim()) reject.mutate({ id: detail.review.id, comment: comment.trim() }); };
  return <section className="review-detail"><header className="review-detail-head"><div className="review-author"><Avatar name={detail.owner.display_name} large /><div><strong>{detail.owner.display_name}</strong><span>提交于 {formatDateTime(detail.review.created_at)}</span></div></div><DiagnosisSummary diagnosis={detail.diagnosis} liveLabel={detail.live_version?.label} /></header><PreviewFrame url={detail.version.preview_url} title={`${detail.project.title} 的提交预览`} className="admin-preview" /><div className="review-update"><small>本次更新</small><h2>{detail.version.summary || '提交时没有留下更新说明。'}</h2></div><footer className="review-actions"><span>⌄　版本记录</span><div><button className="button button-outline" onClick={() => setRejecting(true)} disabled={approve.isPending || reject.isPending}>退回修改</button><button className="button button-coral" onClick={() => approve.mutate(detail.review.id)} disabled={approve.isPending || reject.isPending}>{approve.isPending ? '正在发布…' : '审核并发布'}</button></div></footer>{rejecting && <div className="modal-backdrop"><form className="reject-modal" onSubmit={submitReject}><button type="button" className="modal-close" onClick={() => setRejecting(false)} aria-label="关闭">×</button><p className="eyebrow">退回修改</p><h2>请写清楚需要修改的原因</h2><p>这段话会直接展示给学员，帮助对方知道下一步怎么改。</p><label htmlFor="review-comment">修改意见</label><textarea id="review-comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="例如：请先修复预览页无法打开的问题。" autoFocus rows={5} />{reject.isError && <span className="form-error">{readableError(reject.error)}</span>}<button className="button button-coral button-wide" disabled={!comment.trim() || reject.isPending}>{reject.isPending ? '正在退回…' : '确认退回修改'}</button></form></div>}</section>;
}

function DiagnosisSummary({ diagnosis, liveLabel }: { diagnosis: Diagnosis | null; liveLabel?: string | null }) {
  const items = diagnosis?.items || [];
  const frontend = items.find((item) => item.check_key === 'artifact_entry' || item.check_key === 'refs_resolve');
  const backend = items.find((item) => item.check_key === 'baas_connected');
  const frontendSummary = getReviewSummary(frontend, 'frontend');
  const backendSummary = getReviewSummary(backend, 'backend');
  return <div className="diagnosis-summary-strip"><SummaryCell title="前端" {...frontendSummary} /><SummaryCell title="服务端" {...backendSummary} /><SummaryCell title="线上版本" value={liveLabel || '未上线'} /></div>;
}

function SummaryCell({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return <div><strong>{title}</strong><span>{value}</span>{detail && <small>{detail}</small>}</div>;
}
