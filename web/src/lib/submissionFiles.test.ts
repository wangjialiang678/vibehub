import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createPrepareSubmissionFiles, prepareSubmissionFiles } from './submissionFiles';

const MB = 1024 * 1024;

function browserFile(
  name: string,
  content: BlobPart | BlobPart[],
  webkitRelativePath = '',
  type = 'application/octet-stream',
) {
  const file = new File(Array.isArray(content) ? content : [content], name, { type });
  Object.defineProperty(file, 'webkitRelativePath', { value: webkitRelativePath });
  return file;
}

class FakeZipWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly entries: Record<string, Uint8Array> = {};

  postMessage(message: { type: string; path?: string; data?: ArrayBuffer }, transfer?: Transferable[]) {
    if (message.type === 'add' && message.path && message.data) {
      expect(transfer).toEqual([message.data]);
      this.entries[message.path] = new Uint8Array(message.data);
      queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { type: 'added' } })));
      return;
    }
    const archive = zipSync(this.entries, { level: 0 });
    queueMicrotask(() => this.onmessage?.(new MessageEvent('message', {
      data: { type: 'done', archive: archive.buffer },
    })));
  }

  terminate() {
    this.terminated = true;
  }
}

describe('prepareSubmissionFiles', () => {
  it.each([
    ['index.HTML', 'text/html'],
    ['game.zip', 'application/zip'],
    ['game.tar.gz', 'application/gzip'],
    ['game.TGZ', 'application/gzip'],
  ])('returns a single supported %s file unchanged', async (name, type) => {
    const file = browserFile(name, 'game', '', type);

    await expect(prepareSubmissionFiles([file])).resolves.toBe(file);
  });

  it('zips a selected folder and preserves browser relative paths', async () => {
    const files = [
      browserFile('index.html', '<main>hello</main>', 'my-game/index.html', 'text/html'),
      browserFile('app.js', 'console.log("hello")', 'my-game/assets/app.js', 'text/javascript'),
    ];

    const worker = new FakeZipWorker();
    const prepare = createPrepareSubmissionFiles(() => worker);
    const archive = await prepare(files);
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));

    expect(archive.name).toBe('my-game.zip');
    expect(new TextDecoder().decode(entries['my-game/index.html'])).toBe('<main>hello</main>');
    expect(new TextDecoder().decode(entries['my-game/assets/app.js'])).toBe('console.log("hello")');
    expect(worker.terminated).toBe(true);
  });

  it('rejects folders with more than 5000 files before starting a worker', async () => {
    const files = Array.from({ length: 5001 }, (_, index) =>
      browserFile(`${index}.txt`, '', `game/${index}.txt`));
    let workerCreated = false;
    const prepare = createPrepareSubmissionFiles(() => {
      workerCreated = true;
      return new FakeZipWorker();
    });

    await expect(prepare(files)).rejects.toThrow('5000');
    expect(workerCreated).toBe(false);
  });

  it('terminates the worker and reports a readable compression error', async () => {
    const worker = new FakeZipWorker();
    worker.postMessage = () => queueMicrotask(() => worker.onerror?.({} as ErrorEvent));
    const prepare = createPrepareSubmissionFiles(() => worker);

    await expect(prepare([browserFile('index.html', 'hello', 'game/index.html')]))
      .rejects.toThrow('压缩失败');
    expect(worker.terminated).toBe(true);
  });

  it('rejects an empty selection', async () => {
    await expect(prepareSubmissionFiles([])).rejects.toThrow('请选择');
  });

  it('rejects an unsupported standalone file', async () => {
    await expect(prepareSubmissionFiles([browserFile('notes.txt', 'hello')])).rejects.toThrow('HTML');
  });

  it('rejects multiple ordinary files that were not selected as a folder', async () => {
    const files = [browserFile('index.html', 'one'), browserFile('app.js', 'two')];

    await expect(prepareSubmissionFiles(files)).rejects.toThrow('文件夹');
  });

  it('rejects a package or folder whose input exceeds 30 MB', async () => {
    const archive = browserFile('game.zip', new Uint8Array(30 * MB + 1));
    const folder = browserFile('large.bin', new Uint8Array(30 * MB + 1), 'game/large.bin');

    await expect(prepareSubmissionFiles([archive])).rejects.toThrow('30 MB');
    await expect(prepareSubmissionFiles([folder])).rejects.toThrow('30 MB');
  });

  it('rejects a standalone HTML file over 20 MB', async () => {
    const html = browserFile('index.html', new Uint8Array(20 * MB + 1), '', 'text/html');

    await expect(prepareSubmissionFiles([html])).rejects.toThrow('20 MB');
  });

  it.each([
    ['/game/index.html', '路径'],
    ['../game/index.html', '路径'],
    ['game/../index.html', '路径'],
    ['game/.env', '敏感'],
    ['game/.git/config', '敏感'],
    ['game/node_modules/pkg/index.js', 'node_modules'],
  ])('rejects an unsafe folder path: %s', async (path, message) => {
    const file = browserFile('index.html', 'hello', path);

    await expect(prepareSubmissionFiles([file])).rejects.toThrow(message);
  });

  it('rejects an empty path inside a folder selection', async () => {
    const files = [
      browserFile('index.html', 'hello', 'game/index.html'),
      browserFile('app.js', 'hello', ''),
    ];

    await expect(prepareSubmissionFiles(files)).rejects.toThrow('路径');
  });
});
