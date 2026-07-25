import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('nginx 剥离伪造项目 header，并拒绝作品与预览中的 dotfile', () => {
  const config = readFileSync(resolve('..', 'infra', 'nginx', 'vibehub.conf'), 'utf8');
  assert.match(config, /location ~ \/\\\.\(\?!well-known\(\?:\/\|\$\)\) \{\s*deny all;/);
  assert.doesNotMatch(config, /\(\?!well-known\)(?!\()/);
  assert.match(config, /location \/baas\/ \{[\s\S]*proxy_set_header X-Vibehub-Project "";/);
});
