import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { copyToClipboard } from '../components/Ui';

const INSTALL_COMMAND = import.meta.env.VITE_SKILL_INSTALL_COMMAND?.trim() || '';
const installEnabled = Boolean(INSTALL_COMMAND);
type Platform = 'macOS' | 'Windows';

export function InstallPage() {
  const detected = useMemo<Platform>(() => /Windows/i.test(navigator.userAgent) ? 'Windows' : 'macOS', []);
  const [platform, setPlatform] = useState<Platform>(detected);
  const [notice, setNotice] = useState('');
  const copy = () => installEnabled ? copyToClipboard(INSTALL_COMMAND)
    .then(() => setNotice('安装命令已复制'))
    .catch(() => setNotice('复制失败，请手动选中命令复制'))
    : setNotice('部署助手即将开放');

  return <main className="install-page">
    {notice && <div className="toast" role="status">{notice}</div>}
    <header className="install-nav"><Link to="/login" className="install-brand"><span className="brand-mark">V</span><b>VibeHub</b></Link><Link className="muted-link" to="/login">已有邀请码，进入营地 →</Link></header>
    <section className="install-hero">
      <p className="eyebrow">给你的 AI 装上部署能力</p>
      <h1>做好游戏，<br />一句话交给老师。</h1>
      <p>安装一次，今后参加任何 VibeHub 营地都能用。营地和作品由邀请码决定，不需要为不同营地重复安装。</p>
      <div className="agent-row"><span>Codex</span><span>Claude Code</span><span>WorkBuddy</span></div>
    </section>
    <section className="install-card panel">
      <div className="platform-tabs" aria-label="选择电脑系统">
        {(['macOS', 'Windows'] as Platform[]).map((item) => <button key={item} className={platform === item ? 'is-active' : ''} onClick={() => setPlatform(item)}>{item}</button>)}
      </div>
      <div className="install-command"><code>{installEnabled ? INSTALL_COMMAND : '部署助手即将开放'}</code><button className="button button-coral" onClick={copy} disabled={!installEnabled}>{installEnabled ? '复制命令' : '即将开放'}</button></div>
      <p className="install-terminal-hint">
        在 {platform === 'Windows' ? 'PowerShell' : '终端 Terminal'} 中先运行 <code>node --version</code> 和 <code>npx --version</code>。
        如果找不到命令，请先<a href="https://nodejs.org/zh-cn/download" target="_blank" rel="noreferrer">安装 Node.js 20 或更高版本</a>，重开终端后再试。
      </p>
    </section>
    <section className="install-steps" aria-label="使用步骤">
      <article><span>01</span><div><h2>安装部署助手</h2><p>复制上面的命令执行一次。它会把同一份提示词和安全脚本交给你的 AI 工具。</p></div></article>
      <article><span>02</span><div><h2>输入邀请码</h2><p>回到 AI 对话，说：“使用邀请码 CAMP-XXXX 加入营地。”AI 会告诉你实际进入了哪个营。</p></div></article>
      <article><span>03</span><div><h2>部署游戏</h2><p>游戏做好后，说：“部署我的游戏。”AI 会检查、提交，并说明是待老师审核还是已经上线。</p></div></article>
    </section>
    <footer className="install-footer"><span>Skill 负责教 AI 怎么做</span><span>脚本负责安全地绑定、打包和上传</span></footer>
  </main>;
}
