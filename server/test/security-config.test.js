import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('nginx 剥离伪造项目 header，并为含量词的作品路径正则加引号', () => {
  const config = readFileSync(resolve('..', 'infra', 'nginx', 'vibehub-locations.conf'), 'utf8');
  assert.ok(config.includes('location ~ "^/vibehub/_preview/(?<vh_pid>[a-z0-9]{16})(?<vh_prest>/.*)?$" {'));
  assert.ok(config.includes('location ~ "^/vibehub/(?<vh_user>[a-z0-9][a-z0-9_-]*)/(?<vh_proj>[a-z0-9][a-z0-9_-]*)(?<vh_rest>/.*)?$" {'));
  assert.match(config, /location \^~ \/baas\/ \{[\s\S]*proxy_set_header X-Vibehub-Project "";/);
});
