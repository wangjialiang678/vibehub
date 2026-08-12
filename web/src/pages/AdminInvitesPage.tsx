import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TeacherPage } from '../components/TeacherPage';
import { ModeTabs } from '../components/Shell';
import { PageState, StatusPill, copyToClipboard } from '../components/Ui';
import { api, readableError } from '../lib/api';
import { formatDateTime } from '../lib/presentation';
import type { InviteListItem } from '../lib/types';

type InviteRole = 'student' | 'teacher';
interface CreateInviteInput { count: number; role: InviteRole; max_devices: number }

export function publicAppBaseUrl(configuredUrl?: string, browserOrigin?: string) {
  const baseUrl = configuredUrl?.trim()
    || browserOrigin?.trim()
    || (typeof window !== 'undefined' ? window.location.origin : '');
  return baseUrl.replace(/\/$/, '');
}

export function buildStudentInviteMessages(codes: string[], campName: string, origin: string) {
  const baseUrl = origin.replace(/\/$/, '');
  return codes.map((code) => [
    `欢迎加入「${campName}」！`,
    '',
    `请打开 ${baseUrl}/login`,
    `输入你自己的邀请码：${code}`,
    '',
    '每人一码，不可互换或与他人共用。',
    '登录后，点击“提交我的游戏”。你可以选择：',
    '1. 直接上传网页 HTML、ZIP 或网页文件夹；',
    `2. 使用 AI 助手部署：${baseUrl}/install`,
    '',
    '无需 SkillHub，也能完成提交。',
  ].join('\n'));
}

export async function copyStudentInviteMessage(message: string, index: number, copy: (value: string) => Promise<void>, setNotice: (value: string) => void) {
  try {
    await copy(message);
    setNotice(`第 ${index + 1} 位学员的转发说明已复制`);
  } catch (error) {
    setNotice(readableError(error, '暂时无法复制学员说明。'));
  }
}

export function RevealedInviteActions({ role, codes, campName, origin, onCopy, onExport }: {
  role: InviteRole;
  codes: string[];
  campName: string;
  origin: string;
  onCopy: (value: string, index: number | null) => void;
  onExport: () => void;
}) {
  if (role === 'teacher') return <><pre>{codes.join('\n')}</pre><div><button type="button" className="button button-outline" onClick={() => onCopy(codes.join('\n'), null)}>复制全部</button><button type="button" className="button button-coral" onClick={onExport}>导出 CSV</button></div></>;
  const messages = buildStudentInviteMessages(codes, campName, origin);
  return <><div className="student-submission-handouts">{messages.map((message, index) => <article key={index}><header><strong>第 {index + 1} 位学员</strong><span>每段说明只含一个邀请码</span></header><pre>{message}</pre><button type="button" className="button button-outline" aria-label={`复制第 ${index + 1} 位学员的说明`} onClick={() => onCopy(message, index)}>复制发给学员的说明</button></article>)}</div><div><button type="button" className="button button-coral" onClick={onExport}>导出 CSV</button></div></>;
}

export function AdminInvitesPage() {
  return <TeacherPage active="总览">{(session) => <InvitesDesk campId={session.camp.id} campSlug={session.camp.slug} campName={session.camp.name} />}</TeacherPage>;
}

function InvitesDesk({ campId, campSlug, campName }: { campId: string; campSlug: string; campName: string }) {
  const client = useQueryClient();
  const [count, setCount] = useState('10');
  const [role, setRole] = useState<InviteRole>('student');
  const [maxDevices, setMaxDevices] = useState('3');
  const [revealedCodes, setRevealedCodes] = useState<string[]>([]);
  const [revealedRole, setRevealedRole] = useState<InviteRole | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const appBaseUrl = publicAppBaseUrl(import.meta.env.VITE_PUBLIC_APP_URL);
  const invites = useQuery({ queryKey: ['invites', campId], queryFn: () => api.invites(campId), retry: false });
  const create = useMutation({
    mutationFn: (input: CreateInviteInput) => api.createInvites(campId, input),
    onSuccess: (data, input) => {
      setRevealedCodes(data.codes);
      setRevealedRole(input.role);
      setNotice(data.message);
      client.invalidateQueries({ queryKey: ['invites', campId] });
    },
  });
  const revoke = useMutation({ mutationFn: async (invite: InviteListItem) => api.revokeInvite(await api.resolveInviteCode(campId, invite.code_masked)), onSuccess: (data) => { setNotice(`邀请码已撤销，${data.revoked_tokens} 台设备已同时失效。`); client.invalidateQueries({ queryKey: ['invites', campId] }); } });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ count: Number(count), role, max_devices: Number(maxDevices) });
  };
  const copyRevealed = (value: string, index: number | null) => {
    if (index === null) {
      copyToClipboard(value).then(() => setNotice('邀请码已复制')).catch((error) => setNotice(readableError(error, '暂时无法复制邀请码。')));
      return;
    }
    void copyStudentInviteMessage(value, index, copyToClipboard, setNotice);
  };
  const exportCsv = async () => {
    try {
      const blob = await api.exportInvites(campId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'vibehub-invites.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice('邀请码 CSV 已导出');
    } catch (error) {
      setNotice(readableError(error, '邀请码 CSV 暂时无法导出。'));
    }
  };
  if (invites.isPending) return <PageState title="正在读取邀请码…" />;
  if (invites.isError) return <PageState error={invites.error} />;

  return <main className="dashboard-content teacher-content">
    <header className="page-heading"><div><p className="breadcrumb">{campName}　/　邀请码</p><h1>发放邀请码</h1><p className="review-counts">生成、导出和撤销课程身份凭证。</p></div><ModeTabs campSlug={campSlug} active="admin" /></header>
    {notice && <p className="action-message" role="status">{notice}</p>}
    <section className="invite-layout">
      <form className="panel invite-create" onSubmit={submit}><p className="eyebrow">新建一批</p><h2>把人请进营地</h2><label htmlFor="invite-count">数量</label><input id="invite-count" type="number" min="1" max="200" value={count} onChange={(event) => setCount(event.target.value)} /><label htmlFor="invite-role">角色</label><select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as InviteRole)}><option value="student">学员</option><option value="teacher">老师</option></select><label htmlFor="invite-devices">设备上限</label><input id="invite-devices" type="number" min="1" max="20" value={maxDevices} onChange={(event) => setMaxDevices(event.target.value)} />{create.isError && <p className="form-error">{readableError(create.error)}</p>}<button className="button button-coral button-wide" disabled={create.isPending}>{create.isPending ? '正在生成…' : '生成邀请码'}</button></form>
      <div className="invite-main"><section className="panel invite-reveal"><header><div><p className="eyebrow">刚刚生成</p><h2>明码只显示这一次</h2></div>{revealedCodes.length > 0 && <span>{revealedCodes.length} 个</span>}</header>{revealedCodes.length && revealedRole ? <RevealedInviteActions role={revealedRole} codes={revealedCodes} campName={campName} origin={appBaseUrl} onCopy={copyRevealed} onExport={exportCsv} /> : <div className="teacher-empty"><strong>生成后在这里领取邀请码</strong><p>请立即复制或导出保存，刷新页面后只会显示脱敏码。</p></div>}</section>
        <section className="panel invite-table"><header><div><p className="eyebrow">全部邀请码</p><h2>发放记录</h2></div><button className="button button-outline" onClick={exportCsv}>导出 CSV</button></header>{invites.data.items.length ? <div className="table-scroll"><table><thead><tr><th>邀请码</th><th>身份 / 状态</th><th>绑定的学员 / 项目</th><th>已用设备</th><th /></tr></thead><tbody>{invites.data.items.map((invite) => <tr key={`${invite.code_masked}-${invite.created_at}`}><td><b>{invite.code_masked}</b><small>{formatDateTime(invite.created_at)}</small></td><td><StatusPill tone={invite.status === 'revoked' ? 'danger' : invite.status === 'bound' ? 'success' : 'muted'}>{invite.role === 'teacher' ? '老师' : '学员'} · {invite.status === 'unused' ? '未使用' : invite.status === 'bound' ? '已绑定' : '已撤销'}</StatusPill></td><td>{invite.bound_user || '尚未绑定'}{invite.bound_project && <small>{invite.bound_project}</small>}</td><td>{invite.devices} / {invite.max_devices}</td><td><button className="button button-outline button-danger" onClick={() => revoke.mutate(invite)} disabled={invite.status === 'revoked' || revoke.isPending}>{revoke.isPending ? '撤销中…' : '撤销'}</button></td></tr>)}</tbody></table></div> : <div className="teacher-empty"><strong>还没有邀请码</strong><p>先生成第一批邀请码，发给本场营的老师和学员。</p></div>}</section>
      </div>
    </section>
  </main>;
}
