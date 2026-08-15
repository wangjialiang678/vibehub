import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TeacherPage } from '../components/TeacherPage';
import { ModeTabs } from '../components/Shell';
import { PageState, StatusPill, copyToClipboard } from '../components/Ui';
import { api, readableError } from '../lib/api';
import { formatDateTime } from '../lib/presentation';
import type { InviteListItem, RosterEntry } from '../lib/types';
import { buildVibeHubDeployPrompt, publicAppBaseUrl } from '../lib/vibehubDeployPrompt';
export { publicAppBaseUrl } from '../lib/vibehubDeployPrompt';

type InviteRole = 'student' | 'teacher';
interface CreateInviteInput { count: number; role: InviteRole; max_devices: number; names?: string[] }

const STUDENT_INVITE_PLACEHOLDER = 'CAMP-XXXX';

export function parseRosterNames(value: string) {
  return value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}

export function parseRosterImport(value: string) {
  return value.split(/\r?\n/).map((line) => {
    const [real_name, code, display_name] = line.split(/[,，\t]/).map((part) => part.trim());
    return { real_name, ...(code ? { code: code.toUpperCase() } : {}), ...(display_name ? { display_name } : {}) };
  }).filter((entry) => entry.real_name);
}

export function buildStudentAiGuide(campName: string, origin: string, code = STUDENT_INVITE_PLACEHOLDER) {
  const baseUrl = origin.replace(/\/$/, '');
  return [
    `欢迎加入「${campName}」！`,
    '',
    '推荐：把下面整段话一次发给正在开发游戏的 AI 助手：',
    '',
    buildVibeHubDeployPrompt(baseUrl, code),
    '',
    '每人一码，不可互换或与他人共用。',
    '',
    `网页备用：如果不用 AI，请打开 ${baseUrl}/login，输入上面同一个邀请码，再上传网页 HTML、ZIP 或网页文件夹。`,
  ].join('\n');
}

export function buildStudentInviteMessages(codes: string[], campName: string, origin: string) {
  return codes.map((code) => buildStudentAiGuide(campName, origin, code));
}

export async function copyTeacherStudentGuide(message: string, copy: (value: string) => Promise<void>, setNotice: (value: string) => void) {
  try {
    await copy(message);
    setNotice('学员完整说明已复制');
  } catch {
    setNotice('学员完整说明暂时无法复制。');
  }
}

export function TeacherStudentGuide({ campName, origin, onCopy }: {
  campName: string;
  origin: string;
  onCopy: (message: string) => void;
}) {
  const aiGuide = buildStudentAiGuide(campName, origin);
  return <section className="panel student-guide"><header><div><p className="eyebrow">转发给学员</p><h2>发给学员的使用说明</h2></div><span>生成邀请码后，把 CAMP-XXXX 换成学员自己的码</span></header><div className="student-guide-grid" style={{ gridTemplateColumns: '1fr' }}><article className="student-guide-card"><div><strong>AI 助手部署（推荐）</strong><span>一次复制包含安装、作品确认和提交；网页上传作为备用</span></div><pre>{aiGuide}</pre><button type="button" className="button button-outline" onClick={() => onCopy(aiGuide)}>复制完整说明</button></article></div></section>;
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
  const [rosterNames, setRosterNames] = useState('');
  const [importText, setImportText] = useState('');
  const [revealedCodes, setRevealedCodes] = useState<string[]>([]);
  const [revealedRole, setRevealedRole] = useState<InviteRole | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const appBaseUrl = publicAppBaseUrl(import.meta.env.VITE_PUBLIC_APP_URL);
  const invites = useQuery({ queryKey: ['invites', campId], queryFn: () => api.invites(campId), retry: false });
  const roster = useQuery({ queryKey: ['roster', campId], queryFn: () => api.roster(campId), retry: false });
  const create = useMutation({
    mutationFn: (input: CreateInviteInput) => api.createInvites(campId, input),
    onSuccess: (data, input) => {
      setRevealedCodes(data.codes);
      setRevealedRole(input.role);
      setNotice(data.message);
      client.invalidateQueries({ queryKey: ['invites', campId] });
      client.invalidateQueries({ queryKey: ['roster', campId] });
    },
  });
  const importRoster = useMutation({
    mutationFn: (entries: Array<{ real_name: string; display_name?: string; code?: string }>) => api.importRoster(campId, entries),
    onSuccess: (data) => {
      setNotice(`已补录 ${data.items.length} 名学员`);
      setImportText('');
      client.invalidateQueries({ queryKey: ['roster', campId] });
      client.invalidateQueries({ queryKey: ['invites', campId] });
    },
  });
  const updateRoster = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { real_name: string; display_name: string; verified: boolean } }) => api.updateRoster(campId, id, input),
    onSuccess: () => {
      setNotice('学员资料已保存');
      client.invalidateQueries({ queryKey: ['roster', campId] });
      client.invalidateQueries({ queryKey: ['invites', campId] });
    },
  });
  const revoke = useMutation({ mutationFn: async (invite: InviteListItem) => api.revokeInvite(await api.resolveInviteCode(campId, invite.code_masked)), onSuccess: (data) => { setNotice(`邀请码已撤销，${data.revoked_devices} 台设备的相关连接已同时失效。`); client.invalidateQueries({ queryKey: ['invites', campId] }); } });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const names = parseRosterNames(rosterNames);
    create.mutate({ count: names.length || Number(count), role, max_devices: Number(maxDevices), ...(role === 'student' && names.length ? { names } : {}) });
  };
  const submitImport = (event: FormEvent) => {
    event.preventDefault();
    const entries = parseRosterImport(importText);
    if (entries.length) importRoster.mutate(entries);
  };
  const copyRevealed = (value: string, index: number | null) => {
    if (index === null) {
      copyToClipboard(value).then(() => setNotice('邀请码已复制')).catch((error) => setNotice(readableError(error, '暂时无法复制邀请码。')));
      return;
    }
    void copyStudentInviteMessage(value, index, copyToClipboard, setNotice);
  };
  const copyGuide = (message: string) => {
    void copyTeacherStudentGuide(message, copyToClipboard, setNotice);
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
  if (invites.isPending || roster.isPending) return <PageState title="正在读取邀请码和学员名单…" />;
  if (invites.isError || roster.isError) return <PageState error={invites.error || roster.error} />;

  return <main className="dashboard-content teacher-content">
    <header className="page-heading"><div><p className="breadcrumb">{campName}　/　邀请码</p><h1>发放邀请码</h1><p className="review-counts">生成、导出和撤销课程身份凭证。</p></div><ModeTabs campSlug={campSlug} active="admin" /></header>
    {notice && <p className="action-message" role="status">{notice}</p>}
    <section className="invite-layout">
      <div className="invite-create-stack"><form className="panel invite-create" onSubmit={submit}><p className="eyebrow">新建一批</p><h2>把人请进营地</h2><label htmlFor="invite-count">数量</label><input id="invite-count" type="number" min="1" max="200" value={count} onChange={(event) => setCount(event.target.value)} disabled={role === 'student' && Boolean(rosterNames.trim())} /><label htmlFor="invite-role">角色</label><select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as InviteRole)}><option value="student">学员</option><option value="teacher">老师</option></select>{role === 'student' && <><label htmlFor="invite-names">学员名单（可选，一行一个）</label><textarea id="invite-names" rows={7} placeholder={'李同学\n王同学\n不填也可以只生成邀请码'} value={rosterNames} onChange={(event) => setRosterNames(event.target.value)} /><small>填名单时会按行生成对应邀请码；也可以以后再补。</small></>}<label htmlFor="invite-devices">设备上限</label><input id="invite-devices" type="number" min="1" max="20" value={maxDevices} onChange={(event) => setMaxDevices(event.target.value)} />{create.isError && <p className="form-error">{readableError(create.error)}</p>}<button className="button button-coral button-wide" disabled={create.isPending}>{create.isPending ? '正在生成…' : rosterNames.trim() && role === 'student' ? '按名单生成邀请码' : '生成邀请码'}</button></form><form className="panel invite-create roster-import" onSubmit={submitImport}><p className="eyebrow">补录已有邀请码</p><h2>把姓名和旧码连起来</h2><label htmlFor="roster-import">每行：姓名，邀请码，公开昵称（可选）</label><textarea id="roster-import" rows={7} placeholder="李同学，AIGAME-XXXXXXXXXX，游戏达人" value={importText} onChange={(event) => setImportText(event.target.value)} /><small>顺序自由；已绑定的作品和登录状态不会被改动。</small>{importRoster.isError && <p className="form-error">{readableError(importRoster.error)}</p>}<button className="button button-outline button-wide" disabled={!importText.trim() || importRoster.isPending}>{importRoster.isPending ? '补录中…' : '补录名单'}</button></form></div>
      <div className="invite-main"><TeacherStudentGuide campName={campName} origin={appBaseUrl} onCopy={copyGuide} /><section className="panel invite-reveal"><header><div><p className="eyebrow">刚刚生成</p><h2>明码只显示这一次</h2></div>{revealedCodes.length > 0 && <span>{revealedCodes.length} 个</span>}</header>{revealedCodes.length && revealedRole ? <RevealedInviteActions role={revealedRole} codes={revealedCodes} campName={campName} origin={appBaseUrl} onCopy={copyRevealed} onExport={exportCsv} /> : <div className="teacher-empty"><strong>生成后在这里领取邀请码</strong><p>请立即复制或导出保存，刷新页面后只会显示脱敏码。</p></div>}</section>
        <section className="panel invite-table"><header><div><p className="eyebrow">全部邀请码</p><h2>发放记录</h2></div><button className="button button-outline" onClick={exportCsv}>导出 CSV</button></header>{invites.data.items.length ? <div className="table-scroll"><table><thead><tr><th>邀请码</th><th>身份 / 状态</th><th>学员 / 项目</th><th>已用设备</th><th /></tr></thead><tbody>{invites.data.items.map((invite) => <tr key={`${invite.code_masked}-${invite.created_at}`}><td><b>{invite.code_masked}</b><small>{formatDateTime(invite.created_at)}</small></td><td><StatusPill tone={invite.status === 'revoked' ? 'danger' : invite.status === 'bound' ? 'success' : 'muted'}>{invite.role === 'teacher' ? '老师' : '学员'} · {invite.status === 'unused' ? '未使用' : invite.status === 'bound' ? '已绑定' : '已撤销'}</StatusPill></td><td>{invite.bound_user || invite.intended_user || (invite.role === 'student' ? '尚未分配姓名' : '老师邀请码')}{invite.bound_project && <small>{invite.bound_project}</small>}{!invite.bound_user && invite.intended_user && <small>已分配 · 等待学员登录</small>}</td><td>{invite.devices} / {invite.max_devices}</td><td><button className="button button-outline button-danger" onClick={() => revoke.mutate(invite)} disabled={invite.status === 'revoked' || revoke.isPending}>{revoke.isPending ? '撤销中…' : '撤销'}</button></td></tr>)}</tbody></table></div> : <div className="teacher-empty"><strong>还没有邀请码</strong><p>先生成第一批邀请码，发给本场营的老师和学员。</p></div>}</section>
        <RosterTable items={roster.data.items} saving={updateRoster.isPending} onSave={(id, input) => updateRoster.mutate({ id, input })} />
      </div>
    </section>
  </main>;
}

export function RosterTable({ items, saving, onSave }: { items: RosterEntry[]; saving: boolean; onSave: (id: string, input: { real_name: string; display_name: string; verified: boolean }) => void }) {
  return <section className="panel invite-table roster-table"><header><div><p className="eyebrow">营地学员</p><h2>学员名单与作品</h2></div><span>{items.length} 人</span></header>{items.length ? <div className="table-scroll"><table><thead><tr><th>真实姓名（老师可见）</th><th>公开昵称</th><th>邀请码 / 作品</th><th>确认状态</th><th /></tr></thead><tbody>{items.map((item) => <RosterRow key={item.id} item={item} saving={saving} onSave={onSave} />)}</tbody></table></div> : <div className="teacher-empty"><strong>名单还是空的</strong><p>可以先粘贴姓名生成邀请码，也可以让学员首次登录时自行补充。</p></div>}</section>;
}

function RosterRow({ item, saving, onSave }: { item: RosterEntry; saving: boolean; onSave: (id: string, input: { real_name: string; display_name: string; verified: boolean }) => void }) {
  const [realName, setRealName] = useState(item.real_name);
  const [displayName, setDisplayName] = useState(item.display_name);
  return <tr><td><input aria-label={`${item.real_name}的真实姓名`} value={realName} maxLength={40} onChange={(event) => setRealName(event.target.value)} /></td><td><input aria-label={`${item.real_name}的公开昵称`} value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} /></td><td><b>{item.code || '未分配邀请码'}</b><small>{item.project_title || (item.user_id ? '已登录，尚未提交' : '尚未绑定')}</small></td><td><StatusPill tone={item.verification_status === 'verified' ? 'success' : 'warning'}>{item.verification_status === 'verified' ? '老师已确认' : '学员自填 · 待确认'}</StatusPill></td><td><button type="button" className="button button-outline" disabled={saving || !realName.trim() || !displayName.trim()} onClick={() => onSave(item.id, { real_name: realName.trim(), display_name: displayName.trim(), verified: true })}>{saving ? '保存中…' : item.verification_status === 'verified' ? '保存' : '确认并保存'}</button></td></tr>;
}
