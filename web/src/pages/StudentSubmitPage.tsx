import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AppShell, ModeTabs } from '../components/Shell';
import { LoginRequired, PageState, copyToClipboard } from '../components/Ui';
import { api, readableError } from '../lib/api';
import { prepareSubmissionFiles } from '../lib/submissionFiles';
import type { SubmissionResponse } from '../lib/types';

type SubmissionMode = 'web' | 'ai';
type SubmissionStage = 'idle' | 'preparing' | 'uploading' | 'checking' | 'success';

const AI_PROMPT = '使用邀请码加入 VibeHub，然后部署我的游戏。';

export function parseSubmissionFlows(value: string) {
  return value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean).slice(0, 5);
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
  if (me.isPending) return <PageState />;
  if (me.isError) return <LoginRequired />;
  if (!me.data.project_id) {
    return <AppShell active="提交作品" role="student" campSlug={me.data.camp.slug} avatar={me.data.user.display_name}>
      <main className="dashboard-content narrow-content submit-no-project">
        <p className="breadcrumb">{me.data.camp.name}　/　提交作品</p>
        <h1>作品空间还在准备中</h1>
        <p className="empty-copy">老师为你创建项目后，就能在这里上传网页，或请 AI 助手帮你部署。</p>
      </main>
    </AppShell>;
  }

  return <SubmitWorkspace
    projectId={me.data.project_id}
    campName={me.data.camp.name}
    campSlug={me.data.camp.slug}
    userName={me.data.user.display_name}
  />;
}

function SubmitWorkspace({ projectId, campName, campSlug, userName }: { projectId: string; campName: string; campSlug: string; userName: string }) {
  const queryClient = useQueryClient();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<SubmissionMode>('web');
  const [files, setFiles] = useState<File[]>([]);
  const [summary, setSummary] = useState('');
  const [flowsText, setFlowsText] = useState('');
  const [stage, setStage] = useState<SubmissionStage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmissionResponse | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const busy = stage === 'preparing' || stage === 'uploading' || stage === 'checking';
  const flows = parseSubmissionFlows(flowsText);

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  const chooseFiles = (nextFiles: FileList | null) => {
    setFiles(Array.from(nextFiles || []));
    setError(null);
    setResult(null);
    setStage('idle');
    setProgress(0);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!files.length || busy) return;
    setError(null);
    setResult(null);
    setProgress(0);
    setStage('preparing');
    try {
      const bundle = await prepareSubmissionFiles(files);
      setStage('uploading');
      const response = await api.submitProjectVersion(projectId, bundle, {
        summary: summary.trim() || undefined,
        flows: flows.length ? flows : undefined,
      }, (value) => {
        setProgress(value);
        if (value >= 100) setStage('checking');
      });
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['versions', projectId] }),
      ]);
      setResult(response);
      setStage('success');
    } catch (caught) {
      setError(readableError(caught, caught instanceof Error ? caught.message : '提交没有完成，请稍后再试。'));
      setStage('idle');
    }
  };

  const copyPrompt = () => {
    copyToClipboard(AI_PROMPT)
      .then(() => setCopyNotice('提示词已复制，可以粘贴给 AI 助手了。'))
      .catch((caught) => setCopyNotice(readableError(caught, '暂时无法复制，请手动选中提示词。')));
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

            <div className="submit-form-grid">
              <label className="field-label"><span>这次更新了什么 <small>{summary.length}/500</small></span><textarea value={summary} maxLength={500} rows={5} placeholder="例如：完成了开始界面，修复角色碰撞，并补上结算页。" onChange={(event) => setSummary(event.target.value)} /></label>
              <label className="field-label"><span>希望老师检查的流程 <small>{flows.length}/5</small></span><textarea value={flowsText} rows={5} placeholder={'每行一条，例如：\n开始游戏\n完成第一关\n查看结算'} onChange={(event) => setFlowsText(event.target.value)} /><small className="field-help">可用换行或逗号分隔，最多取前 5 条。</small></label>
            </div>
          </fieldset>

          {(busy || stage === 'success') && <div className={`submit-progress is-${stage}`} role="status" aria-live="polite"><div className="submit-progress-line"><span style={{ width: stage === 'preparing' ? '12%' : stage === 'checking' ? '92%' : stage === 'success' ? '100%' : `${Math.max(16, progress)}%` }} /></div><strong>{stage === 'preparing' ? '正在整理文件…' : stage === 'uploading' ? `正在上传… ${progress}%` : stage === 'checking' ? '上传完成，正在创建预览…' : '提交成功，诊断已经开始'}</strong></div>}
          {error && <div className="submit-error" role="alert"><strong>这次没有提交成功</strong><p>{error}</p><span>文件和说明都还在，可以直接重新提交。</span></div>}
          {result && <div className="submit-success"><div><span aria-hidden="true">✓</span><div><p className="eyebrow">第 {result.seq} 次提交</p><h2>{result.label} 已进入诊断</h2><p>诊断完成后会交给老师审核，通过后正式上线。</p></div></div><a className="button button-outline" href={result.preview_url} target="_blank" rel="noreferrer" aria-label="打开本次提交的预览">打开预览 ↗<small>{safePreviewLabel(result.preview_url)}</small></a></div>}

          <footer className="submit-actions"><div><strong>提交后的路径</strong><span>自动诊断　→　老师审核　→　正式上线</span></div><button className="button button-coral" type="submit" disabled={!files.length || busy}>{busy ? '正在提交…' : error ? '重新提交' : stage === 'success' ? '再提交一个版本' : '提交这个版本'}</button></footer>
        </form>
        : <section className="panel ai-submit-panel">
          <div className="ai-submit-copy"><p className="eyebrow">AI 部署助手</p><h2>让助手从项目构建到提交</h2><p>如果作品使用 React / Vite 等开发，需要先构建成可访问的网页。安装部署助手后，把下面这句话发给你的 AI。</p><Link className="button button-outline" to="/install">安装部署助手 →</Link></div>
          <div className="ai-prompt-card"><span>复制给 AI 的提示</span><blockquote>{AI_PROMPT}</blockquote><button type="button" className="button button-coral" onClick={copyPrompt}>复制提示词</button>{copyNotice && <p role="status">{copyNotice}</p>}</div>
          <ol className="ai-submit-steps"><li><b>1</b><div><strong>安装助手</strong><span>只需在这台电脑安装一次</span></div></li><li><b>2</b><div><strong>告诉 AI</strong><span>粘贴上方提示，不要附加会话信息</span></div></li><li><b>3</b><div><strong>等待提交</strong><span>AI 会完成构建并把结果送来审核</span></div></li></ol>
        </section>}
    </main>
  </AppShell>;
}
