import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { copyToClipboard } from '../components/Ui';

const INSTALLER_PATH = '/downloads/vibehub-skill/install.mjs';
const DISTRIBUTION_PATH = '/downloads/vibehub-skill/';
type Platform = 'macOS' | 'Windows';
type Copy = (value: string) => Promise<void>;

function trimOrigin(origin: string) {
  return origin.replace(/\/+$/, '');
}

export function buildInstallCommand(platform: Platform, origin: string) {
  const publicOrigin = trimOrigin(origin);
  const installerUrl = `${publicOrigin}${INSTALLER_PATH}`;
  const distributionRoot = `${publicOrigin}${DISTRIBUTION_PATH}`;
  if (platform === 'Windows') {
    return `$p=Join-Path $env:TEMP ('vibehub-skill-'+[guid]::NewGuid()+'.mjs'); try { Invoke-WebRequest -UseBasicParsing '${installerUrl}' -OutFile $p; node $p --base-url '${distributionRoot}'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } finally { Remove-Item $p -Force -ErrorAction SilentlyContinue }`;
  }
  return `tmp="$(mktemp -t vibehub-skill.XXXXXX.mjs)" && curl --fail --silent --show-error --location "${installerUrl}" --output "$tmp" && node "$tmp" --base-url "${distributionRoot}"; code=$?; rm -f "$tmp"; exit $code`;
}

export function buildAiInstallPrompt(origin: string) {
  return `请打开 VibeHub 官方安装页 ${trimOrigin(origin)}/install，先确认我的电脑是 macOS 还是 Windows，再复制页面中对应的官方命令并帮我执行。安装完成后，向我询问营地邀请码；不要猜测营地或邀请码。`;
}

export async function copyInstallText(value: string, success: string, copy: Copy, setNotice: (value: string) => void) {
  try {
    await copy(value);
    setNotice(success);
  } catch {
    setNotice('复制失败，请手动选中文字复制');
  }
}

export function InstallPageView({ initialPlatform, origin }: { initialPlatform: Platform; origin: string }) {
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  const [notice, setNotice] = useState('');
  const installCommand = buildInstallCommand(platform, origin);
  const aiPrompt = buildAiInstallPrompt(origin);
  const copyCommand = () => copyInstallText(installCommand, '安装命令已复制', copyToClipboard, setNotice);
  const copyForAi = () => copyInstallText(aiPrompt, '给 AI 的说明已复制', copyToClipboard, setNotice);

  return <main className="install-page">
    <div className="install-status" role="status" aria-live="polite">{notice}</div>
    <header className="install-nav"><Link to="/login" className="install-brand"><span className="brand-mark">V</span><b>VibeHub</b></Link><Link className="muted-link" to="/login">已有邀请码，进入营地 →</Link></header>
    <section className="install-hero">
      <p className="eyebrow">给你的 AI 装上部署能力</p>
      <h1>做好游戏，<br />一句话交给老师。</h1>
      <p>安装一次，今后参加任何 VibeHub 营地都能用。营地和作品由邀请码决定，不需要为不同营地重复安装。</p>
      <div className="agent-row"><span>Codex</span><span>Claude Code</span><span>WorkBuddy</span></div>
    </section>
    <section className="install-card panel">
      <div className="platform-tabs" aria-label="选择电脑系统">
        {(['macOS', 'Windows'] as Platform[]).map((item) => <button key={item} type="button" aria-pressed={platform === item} className={platform === item ? 'is-active' : ''} onClick={() => { setPlatform(item); setNotice(''); }}>{item}</button>)}
      </div>
      <div className="install-command"><code>{installCommand}</code><button type="button" className="button button-coral" onClick={copyCommand}>复制命令</button></div>
      <p className="install-terminal-hint">
        在 {platform === 'Windows' ? 'PowerShell' : '终端 Terminal'} 中先运行 <code>node --version</code>。需要 Node.js 20 或更高版本；如果找不到命令，请先<a href="https://nodejs.org/zh-cn/download" target="_blank" rel="noreferrer">安装 Node.js</a>，重开窗口后再试。
      </p>
      <div className="install-ai-copy">
        <div><strong>不想自己操作？</strong><p>把下面这段说明发给你的 AI 助手，它会识别电脑系统并使用本页的官方命令。</p></div>
        <button type="button" className="button button-dark" onClick={copyForAi}>复制给 AI</button>
      </div>
      <p className="install-ai-prompt"><code>{aiPrompt}</code></p>
    </section>
    <section className="install-steps" aria-label="使用步骤">
      <article><span>01</span><div><h2>安装部署助手</h2><p>复制上面的命令执行一次。它会把同一份提示词和安全脚本交给你的 AI 工具。</p></div></article>
      <article><span>02</span><div><h2>输入邀请码</h2><p>回到 AI 对话，告诉它“使用邀请码加入 VibeHub”。AI 会向你询问邀请码，并告诉你实际进入了哪个营。</p></div></article>
      <article><span>03</span><div><h2>部署游戏</h2><p>游戏做好后，说：“部署我的游戏。”AI 会检查、提交，并说明是待老师审核还是已经上线。</p></div></article>
    </section>
    <footer className="install-footer"><span>Skill 负责教 AI 怎么做</span><span>脚本负责安全地绑定、打包和上传</span></footer>
  </main>;
}

export function InstallPage() {
  const detected = useMemo<Platform>(() => /Windows/i.test(navigator.userAgent) ? 'Windows' : 'macOS', []);
  return <InstallPageView initialPlatform={detected} origin={window.location.origin} />;
}
