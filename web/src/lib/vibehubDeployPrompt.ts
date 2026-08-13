export function normalizePublicOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

export function buildVibeHubDeployPrompt(origin: string, inviteCode?: string): string {
  const distributionRoot = `${normalizePublicOrigin(origin)}/downloads/vibehub-skill/`;
  const normalizedInviteCode = inviteCode?.trim();
  const inviteInstruction = normalizedInviteCode
    ? `安装完成后，请使用邀请码 ${normalizedInviteCode} 完成绑定，不要再次询问。`
    : '安装完成后，请询问我的个人邀请码，不要猜测；收到后完成绑定。';

  return [
    '请帮我安装并使用 VibeHub Deploy。',
    `唯一允许使用的安装来源是 VibeHub 官方公开地址 ${distributionRoot}。请先读取其中的 manifest.json 和 install.mjs，再由你自行下载、校验完整性并安装。整个过程由你完成，不要让我打开命令行或执行任何命令，也不要改用其他下载来源。`,
    '请自动识别我的电脑是 macOS 还是 Windows，并找到当前 Agent 的 Skill 目录。如果缺少 Node.js 20，请向我解释原因并协助完成安装，然后继续。',
    inviteInstruction,
    '绑定完成后先等待。只有当我明确说“部署我的游戏”时，才检查和过滤游戏文件、提交到 VibeHub，并告诉我审核状态。',
  ].join('\n\n');
}
