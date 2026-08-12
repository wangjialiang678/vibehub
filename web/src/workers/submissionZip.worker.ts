/// <reference lib="webworker" />

import { zipSync } from 'fflate';

const entries: Record<string, Uint8Array> = {};

self.onmessage = (event: MessageEvent) => {
  const message = event.data as { type?: string; path?: string; data?: ArrayBuffer };
  try {
    if (message.type === 'add' && typeof message.path === 'string' && message.data instanceof ArrayBuffer) {
      entries[message.path] = new Uint8Array(message.data);
      self.postMessage({ type: 'added' });
      return;
    }
    if (message.type === 'finish') {
      // STORE 模式避免合法的高重复文件超过服务端 100:1 解压缩比防线。
      const archive = zipSync(entries, { level: 0 });
      const data = new Uint8Array(archive).buffer;
      self.postMessage({ type: 'done', archive: data }, { transfer: [data] });
      return;
    }
    throw new Error('unknown submission ZIP worker message');
  } catch {
    self.postMessage({ type: 'error' });
  }
};

export {};
