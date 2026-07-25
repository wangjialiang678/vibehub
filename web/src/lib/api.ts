import type { CampCollection, CampOverview, CampProject, CollectionUpdate, InviteListItem, MeResponse, ProjectSnapshot, ReviewDetail, ReviewsResponse, VersionsResponse } from './types';

// 开发期始终经 Vite 同源代理访问后端，避免 host-only 会话 cookie 在 localhost 与 127.0.0.1 之间丢失。
// VITE_API_BASE 在开发期只配置代理目标；部署时才作为浏览器实际请求的 API 域名。
const API_BASE = (import.meta.env.DEV ? '' : (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:4300')).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
  const data = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? data.error?.message : null;
    throw new ApiError(response.status, message || '请求没有完成，请稍后再试。');
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
  versions: (id: string) => request<VersionsResponse>(`/api/projects/${encodeURIComponent(id)}/versions`),
  reviews: () => request<ReviewsResponse>('/api/reviews?status=pending'),
  review: (id: string) => request<ReviewDetail>(`/api/reviews/${encodeURIComponent(id)}`),
  approve: (id: string) => request<{ ok: boolean; message: string }>(`/api/reviews/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({}) }),
  reject: (id: string, comment: string) => request<{ ok: boolean; message: string }>(`/api/reviews/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ comment }) }),
  overview: (campId: string) => request<CampOverview>(`/api/camps/${encodeURIComponent(campId)}/overview`),
  projects: (campId: string) => request<{ items: CampProject[] }>(`/api/camps/${encodeURIComponent(campId)}/projects`),
  updateCollection: (campId: string, items: CollectionUpdate[]) => request<{ ok: boolean; updated: number; message: string }>(`/api/camps/${encodeURIComponent(campId)}/collection`, { method: 'POST', body: JSON.stringify({ items }) }),
  invites: (campId: string) => request<{ items: InviteListItem[] }>(`/api/camps/${encodeURIComponent(campId)}/invites`),
  createInvites: (campId: string, input: { count: number; role: 'student' | 'teacher'; max_devices: number }) => request<{ codes: string[]; message: string }>(`/api/camps/${encodeURIComponent(campId)}/invites`, { method: 'POST', body: JSON.stringify(input) }),
  exportInvites: (campId: string) => requestBlob(`/api/camps/${encodeURIComponent(campId)}/invites/export`),
  resolveInviteCode: async (campId: string, maskedCode: string) => parseInviteCodes(await (await requestBlob(`/api/camps/${encodeURIComponent(campId)}/invites/export`)).text(), maskedCode),
  revokeInvite: (code: string) => request<{ ok: boolean; revoked_tokens: number; message: string }>(`/api/invites/${encodeURIComponent(code)}/revoke`, { method: 'POST' }),
  collection: (slug: string) => request<CampCollection>(`/api/public/camps/${encodeURIComponent(slug)}`),
  redeem: (code: string) => request<{ role: string; project?: { id: string } | null; user: { display_name: string } }>('/api/session/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
};

export function readableError(error: unknown, fallback = '暂时无法加载，请稍后再试。'): string {
  return error instanceof ApiError ? error.message : fallback;
}
