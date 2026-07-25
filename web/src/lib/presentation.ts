export type DiagnosisItemLike = {
  applicability?: string | null;
  earned_points?: number | null;
  max_points?: number | null;
  result?: string | null;
  evidence_level?: string | null;
};

export type ProjectStatusLike = {
  publish_status?: string | null;
  pending_version?: unknown;
  last_review?: { status?: string | null } | null;
};

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat('zh-CN').format(Number.isFinite(value) ? Number(value) : 0);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '暂未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂未记录';
  const now = new Date();
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (startDate === startToday) return `今天 ${time}`;
  if (startDate === startToday - 86_400_000) return `昨天 ${time}`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '暂未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂未记录';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

export function getDiagnosisState(item: DiagnosisItemLike): { label: string; muted: boolean; ratio: string | null } {
  if (item.applicability === 'not_applicable') return { label: '不适用', muted: true, ratio: null };
  const earned = Number(item.earned_points ?? 0);
  const max = Number(item.max_points ?? 0);
  return { label: `${earned}/${max} 分`, muted: false, ratio: max > 0 ? `${Math.round((earned / max) * 100)}%` : '0%' };
}

export function getReviewSummary(item: DiagnosisItemLike | null | undefined, dimension: 'frontend' | 'backend'): { value: string; detail?: string } {
  if (!item) return { value: '暂未诊断' };
  if (item.applicability === 'not_applicable' || item.result === 'not_applicable') return { value: '不适用' };
  const earned = Number(item.earned_points ?? 0);
  const max = Number(item.max_points ?? 0);
  const detail = `${getDiagnosisState(item).label} · ${evidenceLabel(item.evidence_level)}`;
  if (dimension === 'frontend') return { value: max > 0 && earned >= max ? '已完成' : '完善中', detail };
  return { value: earned > 0 ? '已连接' : '未连接', detail };
}

export function getProjectStatus(project: ProjectStatusLike): { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' } {
  if (project.last_review?.status === 'rejected') return { label: '已退回修改', tone: 'danger' };
  if (project.pending_version) return { label: '等待审核', tone: 'warning' };
  if (project.publish_status === 'published' || project.publish_status === 'published_with_pending') return { label: '已正式上线', tone: 'success' };
  return { label: '还没有正式上线', tone: 'muted' };
}

export function evidenceLabel(level: string | null | undefined): string {
  const labels: Record<string, string> = {
    verified: '✓已验证',
    client_reported: '◑本机上报',
    ai_inferred: '○AI推断',
    human_required: '⚠需人工确认',
  };
  return labels[level ?? ''] ?? '○ 暂无证据';
}

export function postLoginPath(role: string | null | undefined): '/app' | '/admin' {
  return role === 'teacher' || role === 'admin' ? '/admin' : '/app';
}
