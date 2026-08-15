export function normalizePublicOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

export function publicAppBaseUrl(configuredUrl?: string, browserOrigin?: string): string {
  const baseUrl = configuredUrl?.trim()
    || browserOrigin?.trim()
    || (typeof window !== 'undefined' ? window.location.origin : '');
  return normalizePublicOrigin(baseUrl);
}

export function buildVibeHubDeployPrompt(origin: string, inviteCode?: string): string {
  const distributionRoot = `${normalizePublicOrigin(origin)}/downloads/vibehub-skill/`;
  const manifestUrl = `${distributionRoot}manifest.json`;
  const installerUrl = `${distributionRoot}install.mjs`;
  const normalizedInviteCode = inviteCode?.trim();
  const inviteInstruction = normalizedInviteCode
    ? `安装完成后，先检查本机是否已有该项目的有效连接：已有就保留原连接，不要重复绑定；只有没有可用连接时，才使用项目邀请码 ${normalizedInviteCode} 完成绑定。不要再次询问，也不要把邀请码写进代码、日志或网址。`
    : '安装完成后先检查本机已有的 VibeHub 项目连接；如果没有可用连接，再询问我的个人邀请码，不要猜测，收到后完成绑定。';

  return [
    '请帮我安装或更新 VibeHub Deploy，并把当前网页游戏提交到 VibeHub。',
    `唯一允许使用的安装来源是 VibeHub 官方公开文件：清单 ${manifestUrl}，安装脚本 ${installerUrl}。请先读取清单和安装脚本；下载清单列出的每个文件后，逐项核对实际字节数和 SHA-256，全部一致才安装或更新。整个过程由你完成，不要让我打开命令行或执行任何命令，也不要改用其他下载来源。`,
    '请自动识别我的电脑是 macOS 还是 Windows，并找到当前 Agent 的 Skill 目录。如果缺少 Node.js 20，请向我解释原因并协助完成安装，然后继续。',
    inviteInstruction,
    '请先检查当前目录的 VibeHub 作品绑定，再确认目标：已有有效绑定就使用当前作品；没有绑定且这是新作品时，使用“project create”能力创建独立作品；没有绑定但要更新已有作品时，先列出连接，再使用“project link”能力按完整连接标识关联。信息不足时只问一个简短问题。以服务端返回的真实营地和作品为准，不能覆盖或误用其他作品。',
    '目标作品确认后，请立即部署当前游戏：先检查、构建并过滤当前游戏文件，再提交到 VibeHub。不需要等我再次确认或再说“部署我的游戏”。完成后告诉我提交到哪个作品、是否已经进入老师审核，以及这还不等于公开上线。',
  ].join('\n\n');
}
