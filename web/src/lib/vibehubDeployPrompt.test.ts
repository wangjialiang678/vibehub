import { describe, expect, it } from 'vitest';
import { buildVibeHubDeployPrompt, normalizePublicOrigin } from './vibehubDeployPrompt';

describe('VibeHub Deploy AI prompt', () => {
  it('normalizes whitespace and trailing slashes from the public origin', () => {
    expect(normalizePublicOrigin('  https://hub.example.test///  ')).toBe('https://hub.example.test');
  });

  it('builds a natural-language installation and deployment request', () => {
    const prompt = buildVibeHubDeployPrompt('https://hub.example.test/');

    expect(prompt).toContain('VibeHub Deploy');
    expect(prompt).toContain('https://hub.example.test/downloads/vibehub-skill/');
    expect(prompt).toContain('manifest.json');
    expect(prompt).toContain('install.mjs');
    expect(prompt).toContain('自行下载、校验完整性并安装');
    expect(prompt).toContain('macOS');
    expect(prompt).toContain('Windows');
    expect(prompt).toContain('当前 Agent');
    expect(prompt).toContain('Node.js 20');
    expect(prompt).toContain('询问我的个人邀请码');
    expect(prompt).toContain('绑定');
    expect(prompt).toContain('部署我的游戏');
  });

  it('keeps commands, internal channels, credentials and camp guesses out of the prompt', () => {
    const prompt = buildVibeHubDeployPrompt('https://hub.example.test/');

    for (const forbidden of [
      'curl',
      'PowerShell',
      'npx',
      'npm',
      'SkillHub',
      'token',
      '深圳',
      '上海',
      'Shenzhen',
      'Shanghai',
    ]) {
      expect(prompt.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('includes a supplied invite code exactly once without asking for it again', () => {
    const inviteCode = 'CAMP-7H2K';
    const prompt = buildVibeHubDeployPrompt('https://hub.example.test/', inviteCode);

    expect(prompt.match(new RegExp(inviteCode, 'g'))).toHaveLength(1);
    expect(prompt).not.toContain('询问我的个人邀请码');
    expect(prompt).toContain('绑定');
  });
});
