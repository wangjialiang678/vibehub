import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validatePreviewOriginTemplate } from '../src/lib/config.js';

test('预览 origin 模板必须让不同 preview id 得到不同 hostname', () => {
  assert.equal(
    validatePreviewOriginTemplate('https://{previewId}.preview.supermind-ai.cn'),
    'https://{previewId}.preview.supermind-ai.cn',
  );
  assert.throws(
    () => validatePreviewOriginTemplate('https://{previewId}@preview.supermind-ai.cn'),
    /无凭据|独立 hostname/,
  );
  assert.throws(
    () => validatePreviewOriginTemplate('https://user:{previewId}@preview.supermind-ai.cn'),
    /无凭据|独立 hostname/,
  );
});

test('预览 origin 模板拒绝路径、query、fragment 和非 HTTP 协议', () => {
  for (const template of [
    'https://preview.supermind-ai.cn/{previewId}',
    'https://preview.supermind-ai.cn?preview={previewId}',
    'https://preview.supermind-ai.cn#{previewId}',
    'data:text/plain,{previewId}',
  ]) {
    assert.throws(() => validatePreviewOriginTemplate(template));
  }
});
