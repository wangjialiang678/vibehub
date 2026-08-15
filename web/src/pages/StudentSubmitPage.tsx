import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell, ModeTabs } from '../components/Shell';
import { LoginRequired, PageState, copyToClipboard } from '../components/Ui';
import { api, readableError } from '../lib/api';
import { prepareSubmissionFiles } from '../lib/submissionFiles';
import { buildVibeHubDeployPrompt, publicAppBaseUrl } from '../lib/vibehubDeployPrompt';
import type { MeResponse, SubmissionMeta, SubmissionResponse } from '../lib/types';

type SubmissionMode = 'web' | 'ai';
type SubmissionStage = 'idle' | 'preparing' | 'uploading' | 'checking' | 'success';

export interface SubmissionUiState {
  stage: SubmissionStage;
  progress: number;
  error: string | null;
  result: SubmissionResponse | null;
  hasFiles?: boolean;
}

type SubmissionUpdate = Partial<Omit<SubmissionUiState, 'hasFiles'>>;

interface SubmissionInput {
  projectId: string;
  files: File[];
  projectTitle?: string;
  tagline?: string;
  summary: string;
  flowsText: string;
}

interface SubmissionDependencies {
  prepare: (files: File[]) => Promise<File>;
  submit: (projectId: string, file: File, meta: SubmissionMeta, onProgress: (progress: number) => void) => Promise<SubmissionResponse>;
  invalidate: (queryKey: string[]) => Promise<unknown>;
}

export function parseSubmissionFlows(value: string) {
  return value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean).slice(0, 5);
}

export function validateSubmissionFlows(flows: string[]) {
  const tooLong = flows.find((flow) => flow.trim().length > 80);
  return tooLong ? '每条检查流程不能超过 80 个字，请精简后重新提交。' : null;
}

export async function executeSubmission(input: SubmissionInput, dependencies: SubmissionDependencies, update: (value: SubmissionUpdate) => void) {
  const flows = parseSubmissionFlows(input.flowsText);
  const validationError = validateSubmissionFlows(flows);
  if (validationError) {
    update({ stage: 'idle', progress: 0, error: validationError, result: null });
    return;
  }
  update({ stage: 'preparing', progress: 0, error: null, result: null });
  try {
    const bundle = await dependencies.prepare(input.files);
    update({ stage: 'uploading' });
    const response = await dependencies.submit(input.projectId, bundle, {
      project_title: input.projectTitle?.trim() || undefined,
      tagline: input.tagline?.trim() || undefined,
      summary: input.summary.trim() || undefined,
      flows: flows.length ? flows : undefined,
    }, (progress) => update({ stage: progress >= 100 ? 'checking' : 'uploading', progress }));
    await Promise.allSettled([
      dependencies.invalidate(['project', input.projectId]),
      dependencies.invalidate(['versions', input.projectId]),
    ]);
    update({ stage: 'success', result: response });
  } catch (caught) {
    update({
      stage: 'idle',
      error: readableError(caught, caught instanceof Error ? caught.message : '提交没有完成，请稍后再试。'),
    });
  }
}

export async function copyAiSubmissionPrompt(prompt: string, copy: (value: string) => Promise<void>, setNotice: (value: string) => void) {
  try {
    await copy(prompt);
    setNotice('提示词已复制，可以粘贴给 AI 助手了。');
  } catch (caught) {
    setNotice(readableError(caught, '暂时无法复制，请手动选中提示词。'));
  }
}

function safePreviewLabel(value: string) {
  try {
    const url = new URL(value);
    return `${url.host} · 临时预览`;
  } catch {
    return '打开本次提交的预览';
  }
}

export function StudentSubmitPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  if (me.isPending) return <StudentSubmitPageView state={{ status: 'pending' }} />;
  if (me.isError) return <StudentSubmitPageView state={{ status: 'error' }} />;
  return <StudentSubmitPageView state={{ status: 'ready', me: me.data }} />;
}

type StudentSubmitPageState = { status: 'pending' } | { status: 'error' } | { status: 'ready'; me: MeResponse };

export function StudentSubmitPageView({ state }: { state: StudentSubmitPageState }) {
  if (state.status === 'pending') return <PageState />;
  if (state.status === 'error') return <LoginRequired />;
  if (!state.me.project_id) {
    return <NoProjectAiStart campName={state.me.camp.name} campSlug={state.me.camp.slug} userName={state.me.user.display_name} />;
  }

  return <SubmitWorkspace
    projectId={state.me.project_id}
    campName={state.me.camp.name}
    campSlug={state.me.camp.slug}
    userName={state.me.user.display_name}
  />;
}

function NoProjectAiStart({ campName, campSlug, userName }: { campName: string; campSlug: string; userName: string }) {
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const prompt = buildVibeHubDeployPrompt(publicAppBaseUrl(import.meta.env.VITE_PUBLIC_APP_URL));
  const copyPrompt = () => void copyAiSubmissionPrompt(prompt, copyToClipboard, setCopyNotice);

  return <AppShell active="提交作品" role="student" campSlug={campSlug} avatar={userName}>
    <main className="dashboard-content narrow-content submit-no-project">
      <p className="breadcrumb">{campName}　/　提交作品</p>
      <h1>让 AI 创建并提交第一个作品</h1>
      <p className="empty-copy">不用等老师先创建项目。把下面的完整指令一次粘贴给正在开发作品的 AI，它会创建独立作品并立即部署。</p>
      <section className="panel ai-submit-panel">
        <div className="ai-prompt-card"><span>完整复制给 AI</span><blockquote>{prompt}</blockquote><button type="button" className="button button-coral" onClick={copyPrompt}>复制完整指令给 AI</button>{copyNotice && <p role="status">{copyNotice}</p>}</div>
      </section>
    </main>
  </AppShell>;
}

export function SubmitWorkspace({ projectId, campName, campSlug, userName, publicOrigin, initialSubmissionState, initialMode = 'ai' }: { projectId: string; campName: string; campSlug: string; userName: string; publicOrigin?: string; initialSubmissionState?: SubmissionUiState; initialMode?: SubmissionMode }) {
  const queryClient = useQueryClient();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<SubmissionMode>(initialMode);
  const [files, setFiles] = useState<File[]>([]);
  const [projectTitle, setProjectTitle] = useState('');
  const [tagline, setTagline] = useState('');
  const [summary, setSummary] = useState('');
  const [flowsText, setFlowsText] = useState('');
  const [submission, setSubmission] = useState<SubmissionUiState>(initialSubmissionState || { stage: 'idle', progress: 0, error: null, result: null });
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const { stage, progress, error, result } = submission;
  const busy = stage === 'preparing' || stage === 'uploading' || stage === 'checking';
  const flows = parseSubmissionFlows(flowsText);
  const hasFiles = files.length > 0 || Boolean(initialSubmissionState?.hasFiles);
  const prompt = buildVibeHubDeployPrompt(publicOrigin || publicAppBaseUrl(import.meta.env.VITE_PUBLIC_APP_URL));

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  const chooseFiles = (nextFiles: FileList | null) => {
    setFiles(Array.from(nextFiles || []));
    setSubmission({ stage: 'idle', progress: 0, error: null, result: null });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!files.length || busy) return;
    await executeSubmission({ projectId, files, projectTitle, tagline, summary, flowsText }, {
      prepare: prepareSubmissionFiles,
      submit: api.submitProjectVersion,
      invalidate: (queryKey) => queryClient.invalidateQueries({ queryKey }),
    }, (update) => setSubmission((current) => ({ ...current, ...update })));
  };

  const copyPrompt = () => {
    void copyAiSubmissionPrompt(prompt, copyToClipboard, setCopyNotice);
  };

  return <AppShell active="提交作品" role="student" campSlug={campSlug} avatar={userName}>
    <main className="dashboard-content submit-page">
      <header className="page-heading submit-page-heading">
        <div><p className="breadcrumb">{campName}　/　提交作品</p><h1>把这一版，交出去</h1><p className="submit-lead">选择网页文件自己上传，或让 AI 助手完成构建与部署。</p></div>
        <ModeTabs campSlug={campSlug} active="app" />
      </header>

      <section className="submit-mode-tabs" aria-label="提交方式">
        <button type="button" className={mode === 'web' ? 'is-active' : ''} aria-pressed={mode === 'web'} disabled={busy} onClick={() => setMode('web')}><span>01</span><strong>直接上传网页</strong><small>已有 HTML 或网页文件夹</small></button>
        <button type="button" className={mode === 'ai' ? 'is-active' : ''} aria-pressed={mode === 'ai'} disabled={busy} onClick={() => setMode('ai')}><span>02</span><strong>交给 AI 助手</strong><small>React / Vite 等需构建项目</small></button>
      </section>

      {mode === 'web'
        ? <form className="panel submit-panel" onSubmit={submit}>
          <div className="submit-panel-intro"><div><p className="eyebrow">网页文件</p><h2>选择这一版的成品</h2></div><p>支持单个 HTML、ZIP、tar.gz，或整个网页文件夹。文件夹会在浏览器中整理后上传。</p></div>

          <fieldset disabled={busy} className="submit-fieldset">
            <legend className="sr-only">选择提交文件</legend>
            <div className="submit-file-options">
              <label className="submit-file-option"><span className="submit-option-mark" aria-hidden="true">↥</span><strong>选择文件</strong><small>.html / .htm / .zip / .tar.gz / .tgz</small><input type="file" accept=".html,.htm,.zip,.tar.gz,.tgz" onChange={(event) => chooseFiles(event.currentTarget.files)} /></label>
              <label className="submit-file-option"><span className="submit-option-mark" aria-hidden="true">⌑</span><strong>选择网页文件夹</strong><small>适合已经构建完成的静态网页目录</small><input ref={folderInputRef} type="file" multiple onChange={(event) => chooseFiles(event.currentTarget.files)} /></label>
            </div>

            <div className="submit-selection" aria-live="polite">
              <span className={files.length ? 'is-ready' : ''} aria-hidden="true">{files.length ? '✓' : '·'}</span>
              <div><strong>{files.length ? (files.length === 1 ? files[0].name : `已选择 ${files.length} 个文件`) : '还没有选择文件'}</strong><small>{files.length ? '可以继续填写这次更新的说明' : '文件最大 30 MB；单个 HTML 最大 20 MB'}</small></div>
            </div>

            <div className="submit-form-grid submit-project-meta">
              <label className="field-label"><span>作品名称 <small>{projectTitle.length}/80</small></span><input value={projectTitle} maxLength={80} placeholder="例如：极速分裂" onChange={(event) => setProjectTitle(event.target.value)} /></label>
              <label className="field-label"><span>一句话介绍 <small>{tagline.length}/160</small></span><input value={tagline} maxLength={160} placeholder="例如：双人分屏的极速竞速游戏。" onChange={(event) => setTagline(event.target.value)} /></label>
            </div>
            <div className="submit-form-grid">
              <label className="field-label"><span>这次更新了什么 <small>{summary.length}/500</small></span><textarea value={summary} maxLength={500} rows={5} placeholder="例如：完成了开始界面，修复角色碰撞，并补上结算页。" onChange={(event) => setSummary(event.target.value)} /></label>
              <label className="field-label"><span>希望老师检查的流程 <small>{flows.length}/5</small></span><textarea value={flowsText} rows={5} placeholder={'每行一条，例如：\n开始游戏\n完成第一关\n查看结算'} onChange={(event) => setFlowsText(event.target.value)} /><small className="field-help">可用换行或逗号分隔，最多取前 5 条。</small></label>
            </div>
          </fieldset>

          {(busy || stage === 'success') && <div className={`submit-progress is-${stage}`} role="status" aria-live="polite"><div className="submit-progress-line"><span style={{ width: stage === 'preparing' ? '12%' : stage === 'checking' ? '92%' : stage === 'success' ? '100%' : `${Math.max(16, progress)}%` }} /></div><strong>{stage === 'preparing' ? '正在整理文件…' : stage === 'uploading' ? `正在上传… ${progress}%` : stage === 'checking' ? '上传完成，正在创建预览…' : '提交成功，诊断已经开始'}</strong></div>}
          {error && <div className="submit-error" role="alert"><strong>这次没有提交成功</strong><p>{error}</p><span>文件和说明都还在，可以直接重新提交。</span></div>}
          {result && <div className="submit-success"><div><span aria-hidden="true">✓</span><div><p className="eyebrow">第 {result.seq} 次提交</p><h2>{result.label} 已进入诊断</h2><p>诊断完成后会交给老师审核，通过后正式上线。</p></div></div><a className="button button-outline" href={result.preview_url} target="_blank" rel="noreferrer" aria-label="打开本次提交的预览">打开预览 ↗<small>{safePreviewLabel(result.preview_url)}</small></a></div>}

          <footer className="submit-actions"><div><strong>提交后的路径</strong><span>自动诊断　→　老师审核　→　正式上线</span></div><button className="button button-coral" type="submit" disabled={!hasFiles || busy}>{busy ? '正在提交…' : error ? '重新提交' : stage === 'success' ? '再提交一个版本' : '提交这个版本'}</button></footer>
        </form>
        : <section className="panel ai-submit-panel">
          <div className="ai-submit-copy"><p className="eyebrow">AI 部署助手</p><h2>一次粘贴，从安装到提交</h2><p>把右边的完整指令发给正在开发这个项目的 AI。它会安装或更新助手、确认目标作品，并立即完成构建与部署。</p></div>
          <div className="ai-prompt-card"><span>完整复制给 AI</span><blockquote>{prompt}</blockquote><button type="button" className="button button-coral" onClick={copyPrompt}>复制完整指令给 AI</button>{copyNotice && <p role="status">{copyNotice}</p>}</div>
          <ol className="ai-submit-steps"><li><b>1</b><div><strong>复制完整指令</strong><span>安装入口和部署要求都在同一段</span></div></li><li><b>2</b><div><strong>粘贴给 AI</strong><span>按提示补充邀请码或作品选择</span></div></li><li><b>3</b><div><strong>等待提交</strong><span>AI 会把当前项目送进老师审核</span></div></li></ol>
        </section>}
    </main>
  </AppShell>;
}
