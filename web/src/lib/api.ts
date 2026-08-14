import type { CampCollection, CampOverview, CampProject, CollectionUpdate, InviteListItem, MeResponse, ProjectSnapshot, ReviewDetail, ReviewsResponse, RosterEntry, SubmissionMeta, SubmissionResponse, VersionsResponse } from './types';

// 开发期始终经 Vite 同源代理访问后端，避免 host-only 会话 cookie 在 localhost 与 127.0.0.1 之间丢失。
// VITE_API_BASE 在开发期只配置代理目标；部署时才作为浏览器实际请求的 API 域名。
const API_BASE = (import.meta.env.DEV ? '' : (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:4300')).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
  const data = await response.json().catch(() => null) as T | { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? data.error : null;
    throw new ApiError(response.status, error?.message || '请求没有完成，请稍后再试。', error?.code);
  }
  return data as T;
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(response.status, data?.error?.message || '请求没有完成，请稍后再试。');
  }
  return response.blob();
}

type XhrFactory = () => XMLHttpRequest;
const SUBMISSION_TIMEOUT_MS = 120_000;

function submissionErrorMessage(xhr: XMLHttpRequest) {
  try {
    const data = JSON.parse(xhr.responseText) as { error?: { message?: unknown } };
    if (typeof data.error?.message === 'string' && data.error.message) return data.error.message;
  } catch { /* 使用下面的通用提示 */ }
  return '提交没有完成，请稍后再试。';
}

function isSubmissionResponse(value: unknown): value is SubmissionResponse {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<SubmissionResponse>;
  return typeof data.version_id === 'string'
    && typeof data.seq === 'number'
    && typeof data.label === 'string'
    && typeof data.preview_url === 'string'
    && typeof data.preview_expires_at === 'string'
    && typeof data.rewrites === 'number'
    && typeof data.deployment?.status === 'string'
    && typeof data.diagnosis?.id === 'string'
    && typeof data.diagnosis?.status === 'string'
    && typeof data.review?.status === 'string'
    && typeof data.message === 'string';
}

export function createSubmitProjectVersion(xhrFactory: XhrFactory) {
  return (
    projectId: string,
    file: File,
    meta: SubmissionMeta,
    onProgress: (progress: number) => void,
  ): Promise<SubmissionResponse> => new Promise((resolve, reject) => {
    const xhr = xhrFactory();
    const form = new FormData();
    let settled = false;
    form.append('bundle', file);
    form.append('meta', JSON.stringify(meta));

    xhr.open('POST', `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/versions`);
    xhr.withCredentials = true;
    xhr.timeout = SUBMISSION_TIMEOUT_MS;
    const reportProgress = (progress: number) => {
      if (settled) return;
      try { onProgress(progress); } catch { /* 展示进度失败不能中断上传 */ }
    };
    const settleError = (error: ApiError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    reportProgress(0);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      reportProgress(Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100))));
    };
    xhr.onload = () => {
      if (settled) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        let data: unknown;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          settleError(new ApiError(xhr.status, '服务器响应不完整，请刷新页面后再试。'));
          return;
        }
        if (!isSubmissionResponse(data)) {
          settleError(new ApiError(xhr.status, '服务器响应不完整，请刷新页面后再试。'));
          return;
        }
        reportProgress(100);
        settled = true;
        resolve(data);
        return;
      }
      settleError(new ApiError(xhr.status, submissionErrorMessage(xhr)));
    };
    xhr.onerror = () => settleError(new ApiError(0, '网络连接中断了，请检查网络后重新提交。'));
    xhr.onabort = () => settleError(new ApiError(0, '上传已取消，请重新选择文件后提交。'));
    xhr.ontimeout = () => settleError(new ApiError(0, '上传等待超过 120 秒，请检查网络后重新提交。'));
    xhr.send(form);
  });
}

export const submitProjectVersion = createSubmitProjectVersion(() => new XMLHttpRequest());

function parseInviteCodes(csv: string, maskedCode: string) {
  const suffix = maskedCode.replace(/^····-/, '');
  const codes = csv.split(/\r?\n/).slice(1).map((line) => /^"([^"]+)"/.exec(line)?.[1]).filter((code): code is string => Boolean(code));
  const matches = codes.filter((code) => code.endsWith(suffix));
  if (matches.length !== 1) throw new ApiError(409, matches.length ? '存在重复的邀请码尾号，请先导出 CSV 后确认完整邀请码。' : '没有找到这个邀请码，请刷新列表后重试。');
  return matches[0];
}

export const api = {
  me: () => request<MeResponse>('/api/me'),
  project: (id: string) => request<ProjectSnapshot>(`/api/projects/${encodeURIComponent(id)}`),
  previewGrant: (previewId: string) => request<{ preview_url: string; expires_at: string }>(`/api/previews/${encodeURIComponent(previewId)}/grant`, { method: 'POST' }),
  versions: (id: string) => request<VersionsResponse>(`/api/projects/${encodeURIComponent(id)}/versions`),
  reviews: () => request<ReviewsResponse>('/api/reviews?status=pending'),
  review: (id: string) => request<ReviewDetail>(`/api/reviews/${encodeURIComponent(id)}`),
  approve: (id: string) => request<{ ok: boolean; message: string }>(`/api/reviews/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({}) }),
  reject: (id: string, comment: string) => request<{ ok: boolean; message: string }>(`/api/reviews/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ comment }) }),
  overview: (campId: string) => request<CampOverview>(`/api/camps/${encodeURIComponent(campId)}/overview`),
  projects: (campId: string) => request<{ items: CampProject[] }>(`/api/camps/${encodeURIComponent(campId)}/projects`),
  updateCollection: (campId: string, items: CollectionUpdate[]) => request<{ ok: boolean; updated: number; message: string }>(`/api/camps/${encodeURIComponent(campId)}/collection`, { method: 'POST', body: JSON.stringify({ items }) }),
  invites: (campId: string) => request<{ items: InviteListItem[] }>(`/api/camps/${encodeURIComponent(campId)}/invites`),
  createInvites: (campId: string, input: { count: number; role: 'student' | 'teacher'; max_devices: number; names?: string[] }) => request<{ codes: string[]; message: string }>(`/api/camps/${encodeURIComponent(campId)}/invites`, { method: 'POST', body: JSON.stringify(input) }),
  roster: (campId: string) => request<{ items: RosterEntry[] }>(`/api/camps/${encodeURIComponent(campId)}/roster`),
  importRoster: (campId: string, entries: Array<{ real_name: string; display_name?: string; code?: string }>) => request<{ created: number; items: RosterEntry[] }>(`/api/camps/${encodeURIComponent(campId)}/roster/import`, { method: 'POST', body: JSON.stringify({ entries }) }),
  updateRoster: (campId: string, id: string, input: { real_name?: string; display_name?: string; verified?: boolean }) => request<RosterEntry>(`/api/camps/${encodeURIComponent(campId)}/roster/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  exportInvites: (campId: string) => requestBlob(`/api/camps/${encodeURIComponent(campId)}/invites/export`),
  resolveInviteCode: async (campId: string, maskedCode: string) => parseInviteCodes(await (await requestBlob(`/api/camps/${encodeURIComponent(campId)}/invites/export`)).text(), maskedCode),
  revokeInvite: (code: string) => request<{ ok: boolean; revoked_tokens: number; message: string }>(`/api/invites/${encodeURIComponent(code)}/revoke`, { method: 'POST' }),
  collection: (slug: string) => request<CampCollection>(`/api/public/camps/${encodeURIComponent(slug)}`),
  redeem: (input: string | { code: string; real_name?: string; display_name?: string }) => request<{ role: string; project?: { id: string } | null; user: { display_name: string } }>('/api/session/redeem', { method: 'POST', body: JSON.stringify(typeof input === 'string' ? { code: input } : input) }),
  updateProfile: (input: { real_name?: string; display_name?: string }) => request<{ user: MeResponse['user']; profile: NonNullable<MeResponse['profile']> }>('/api/me/profile', { method: 'PATCH', body: JSON.stringify(input) }),
  submitProjectVersion,
};

export function readableError(error: unknown, fallback = '暂时无法加载，请稍后再试。'): string {
  return error instanceof ApiError ? error.message : fallback;
}
