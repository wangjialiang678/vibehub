import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const nginxPath = ['/Applications/ServBay/sbin/nginx', '/usr/sbin/nginx', '/usr/local/sbin/nginx']
  .find((candidate) => existsSync(candidate));

test('nginx 将预览隔离到逐 preview 子域，主域不再代理预览', () => {
  const config = readFileSync(resolve('..', 'infra', 'nginx', 'vibehub-locations.conf'), 'utf8');
  const preview = readFileSync(resolve('..', 'infra', 'nginx', 'vibehub-preview-server.conf'), 'utf8');
  const mainPreviewStart = config.indexOf('location ~ "^/vibehub/_preview/');
  const mainPreviewEnd = config.indexOf('\nlocation ', mainPreviewStart + 1);
  const mainPreviewLocation = config.slice(mainPreviewStart, mainPreviewEnd);
  assert.match(mainPreviewLocation, /return 404;/);
  assert.doesNotMatch(mainPreviewLocation, /proxy_pass/);
  assert.match(preview, /server_name "~\^\(\?<vh_pid>\[a-z0-9\]\{16\}\)\\\.preview\\\.supermind-ai\\\.cn\$";/);
  assert.match(preview, /access_log off;/);
  assert.match(preview, /error_log \/dev\/null crit;/);
  assert.match(preview, /proxy_pass http:\/\/127\.0\.0\.1:4300;/);
  assert.doesNotMatch(preview, /\$request_uri|\$args|\$query_string/);
});

test('nginx 仍剥离 BaaS 的伪造项目 header，并为含量词的作品路径正则加引号', () => {
  const config = readFileSync(resolve('..', 'infra', 'nginx', 'vibehub-locations.conf'), 'utf8');
  assert.ok(config.includes('location ~ "^/vibehub/(?<vh_user>[a-z0-9][a-z0-9_-]*)/(?<vh_proj>[a-z0-9][a-z0-9_-]*)(?<vh_rest>/.*)?$" {'));
  assert.match(config, /location \^~ \/baas\/ \{[\s\S]*proxy_set_header X-Vibehub-Project "";/);
});

test('nginx 能解析主域与独立预览虚拟主机配置', { skip: !nginxPath }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibehub-nginx-'));
  try {
    const key = join(dir, 'preview.key');
    const cert = join(dir, 'preview.crt');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=preview.supermind-ai.cn', '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
    const locations = readFileSync(resolve('..', 'infra', 'nginx', 'vibehub-locations.conf'), 'utf8');
    const preview = readFileSync(resolve('..', 'infra', 'nginx', 'vibehub-preview-server.conf'), 'utf8')
      .replace('/etc/letsencrypt/live/preview.supermind-ai.cn/fullchain.pem', cert)
      .replace('/etc/letsencrypt/live/preview.supermind-ai.cn/privkey.pem', key);
    const configPath = join(dir, 'nginx.conf');
    writeFileSync(configPath, `error_log stderr;\npid ${join(dir, 'nginx.pid')};\nevents {}\nhttp {\naccess_log off;\nserver { listen 8080; server_name supermind-ai.cn;\n${locations}\n}\n${preview}\n}\n`);
    execFileSync(nginxPath, ['-t', '-p', `${dir}/`, '-c', configPath], { stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('生产服务把 preview claim secret 作为必需的外部配置读取', () => {
  const unit = readFileSync(resolve('..', 'infra', 'systemd', 'vibehub.service'), 'utf8');
  assert.match(unit, /^EnvironmentFile=\/etc\/vibehub\/vibehub\.env$/m);
  assert.match(unit, /^Environment=VIBEHUB_PREVIEW_ORIGIN_TEMPLATE=https:\/\/\{previewId\}\.preview\.supermind-ai\.cn$/m);
  assert.doesNotMatch(unit, /VIBEHUB_PREVIEW_CLAIM_SECRET=\S+/);
});
