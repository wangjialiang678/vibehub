import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

test('嵌入 iframe 的作品不会上报浏览量，SDK 不再发送可伪造的项目 header', async () => {
  const source = readFileSync(resolve('src/runtime/sdk.js'), 'utf8');
  const frameWindow = {};
  const beacons = [];
  const requests = [];
  frameWindow.self = frameWindow;
  frameWindow.top = {};

  vm.runInNewContext(source, {
    window: frameWindow,
    location: { pathname: '/vibehub/student/demo/' },
    navigator: { sendBeacon: (...args) => { beacons.push(args); return true; } },
    Blob: class Blob { constructor(parts, options) { this.parts = parts; this.options = options; } },
    fetch: (...args) => {
      requests.push(args);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    FormData: class FormData { append() {} },
  });

  assert.equal(beacons.length, 0);
  await frameWindow.vibehub.list('messages');
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].headers['x-vibehub-project'], undefined);
  assert.equal(frameWindow.vibehub.remove, undefined, '公开作品 SDK 不应暴露删除数据能力');
});
