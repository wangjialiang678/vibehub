import { useState } from 'react';
import { Link } from 'react-router-dom';
import { copyToClipboard } from '../components/Ui';
import { buildVibeHubDeployPrompt } from '../lib/vibehubDeployPrompt';

type Copy = (value: string) => Promise<void>;

export async function copyInstallText(value: string, success: string, copy: Copy, setNotice: (value: string) => void) {
  try {
    await copy(value);
    setNotice(success);
  } catch {
    setNotice('复制失败，请手动选中文字复制');
  }
}

export function InstallPageView({ origin }: { origin: string }) {
  const [notice, setNotice] = useState('');
  const prompt = buildVibeHubDeployPrompt(origin);
  const copyPrompt = () => copyInstallText(prompt, '这段话已复制，可以粘贴给 AI 了', copyToClipboard, setNotice);

  return <main className="install-page">
    <div className="install-status" role="status" aria-live="polite">{notice}</div>
    <header className="install-nav"><Link to="/login" className="install-brand"><span className="brand-mark">V</span><b>VibeHub</b></Link><Link className="muted-link" to="/login">直接网页登录提交 →</Link></header>
    <section className="install-hero">
      <p className="eyebrow">给你的 AI 装上部署能力</p>
      <h1>做好游戏，<br />一句话交给老师。</h1>
      <p>复制下面这段话给你常用的 AI，它会完成安装并在你授权后提交作品。营地和作品由邀请码决定。</p>
      <div className="agent-row"><span>Codex</span><span>Claude Code</span><span>WorkBuddy</span></div>
    </section>
    <section className="install-card panel">
      <header className="install-prompt-heading"><div><p className="eyebrow">发给 AI</p><h2>请完整复制下面这段话</h2></div><span>AI 会自动识别你的电脑和当前工具</span></header>
      <pre className="install-prompt">{prompt}</pre>
      <div className="install-prompt-actions">
        <button type="button" className="button button-coral" onClick={copyPrompt}>复制这段话给 AI</button>
        <Link className="muted-link" to="/login">不安装，直接网页登录提交 →</Link>
      </div>
    </section>
    <section className="install-steps" aria-label="使用步骤">
      <article><span>01</span><div><h2>复制这段话</h2><p>点击上面的按钮，完整复制给 AI 的安装与部署说明。</p></div></article>
      <article><span>02</span><div><h2>粘贴给 AI</h2><p>打开你常用的 AI 工具，把这段话粘贴进去，安装过程由它完成。</p></div></article>
      <article><span>03</span><div><h2>提供邀请码并部署</h2><p>按 AI 提示提供自己的邀请码。游戏做好后，说：“部署我的游戏。”</p></div></article>
    </section>
    <footer className="install-footer"><span>Skill 负责教 AI 怎么做</span><span>脚本负责安全地绑定、打包和上传</span></footer>
  </main>;
}

export function InstallPage() {
  return <InstallPageView origin={window.location.origin} />;
}
