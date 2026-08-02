import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('nginx 剥离伪造项目 header，并为含量词的作品路径正则加引号', () => {
  const config = readFileSync(resolve('..', 'infra', 'nginx', 'vibehub-locations.conf'), 'utf8');
  assert.ok(config.includes('location ~ "^/vibehub/_preview/(?<vh_pid>[a-z0-9]{16})(?<vh_prest>/.*)?$" {'));
  assert.match(config, /location ~ "\^\/vibehub\/_preview\/[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:4300;/);
  assert.match(config, /location ~ "\^\/vibehub\/_preview\/[\s\S]*access_log off;/);
  assert.doesNotMatch(config, /location ~ "\^\/vibehub\/_preview\/[\s\S]*alias \/var\/lib\/vibehub\/previews/);
  assert.ok(config.includes('location ~ "^/vibehub/(?<vh_user>[a-z0-9][a-z0-9_-]*)/(?<vh_proj>[a-z0-9][a-z0-9_-]*)(?<vh_rest>/.*)?$" {'));
  assert.match(config, /location \^~ \/baas\/ \{[\s\S]*proxy_set_header X-Vibehub-Project "";/);
});

test('生产服务把 preview claim secret 作为必需的外部配置读取', () => {
  const unit = readFileSync(resolve('..', 'infra', 'systemd', 'vibehub.service'), 'utf8');
  assert.match(unit, /^EnvironmentFile=\/etc\/vibehub\/vibehub\.env$/m);
  assert.doesNotMatch(unit, /VIBEHUB_PREVIEW_CLAIM_SECRET=\S+/);
});
