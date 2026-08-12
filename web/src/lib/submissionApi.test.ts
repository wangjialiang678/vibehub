import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, createSubmitProjectVersion } from './api';

class FakeXMLHttpRequest {
  method = '';
  url = '';
  async = true;
  withCredentials = false;
  status = 0;
  timeout = 0;
  responseText = '';
  sentBody: Document | XMLHttpRequestBodyInit | null = null;
  readonly requestHeaders = new Map<string, string>();
  readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(method: string, url: string, async = true) {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders.set(name.toLowerCase(), value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.sentBody = body;
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ lengthComputable, loaded, total } as ProgressEvent);
  }

  complete(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const response = {
  version_id: 'v_123',
  seq: 2,
  label: 'v0.2.0',
  preview_url: 'https://preview.example.test/game',
  preview_expires_at: '2026-08-13T12:00:00.000Z',
  rewrites: 1,
  deployment: { status: 'ready' },
  diagnosis: { id: 'diag_1', status: 'running' },
  review: { status: 'waiting_for_diagnosis' },
  message: '提交成功',
};

describe('submitProjectVersion', () => {
  let xhr: FakeXMLHttpRequest;

  beforeEach(() => {
    xhr = new FakeXMLHttpRequest();
  });

  it('posts multipart data with credentials and reports upload progress', async () => {
    const progress: number[] = [];
    const submit = createSubmitProjectVersion(() => xhr as unknown as XMLHttpRequest);
    const file = new File(['<main>game</main>'], 'index.html', { type: 'text/html' });

    const pending = submit('project / 1', file, { summary: '更新', flows: ['开始'] }, (value) => progress.push(value));
    xhr.progress(1, 4);
    xhr.complete(201, response);

    await expect(pending).resolves.toEqual(response);
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/projects/project%20%2F%201/versions');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.timeout).toBe(120_000);
    expect(xhr.sentBody).toBeInstanceOf(FormData);
    const form = xhr.sentBody as FormData;
    expect(form.get('bundle')).toBe(file);
    expect(form.get('meta')).toBe(JSON.stringify({ summary: '更新', flows: ['开始'] }));
    expect(progress).toEqual([0, 25, 100]);
    expect(xhr.requestHeaders.has('content-type')).toBe(false);
  });

  it('turns a JSON server error into ApiError with its status and message', async () => {
    const submit = createSubmitProjectVersion(() => xhr as unknown as XMLHttpRequest);
    const pending = submit('p1', new File(['bad'], 'bad.zip'), {}, () => undefined);

    xhr.complete(422, { error: { code: 'secret_detected', message: '检测到敏感文件' } });

    await expect(pending).rejects.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      message: '检测到敏感文件',
    });
  });

  it('uses a readable message when the network is interrupted', async () => {
    const submit = createSubmitProjectVersion(() => xhr as unknown as XMLHttpRequest);
    const pending = submit('p1', new File(['game'], 'game.zip'), {}, () => undefined);

    xhr.onerror?.();

    await expect(pending).rejects.toMatchObject({ status: 0 });
    await expect(pending).rejects.toThrow('网络');
  });

  it.each([
    ['timeout', '超过 120 秒'],
    ['abort', '取消'],
  ])('handles an upload %s with a readable error', async (event, message) => {
    const submit = createSubmitProjectVersion(() => xhr as unknown as XMLHttpRequest);
    const pending = submit('p1', new File(['game'], 'game.zip'), {}, () => undefined);

    if (event === 'timeout') xhr.ontimeout?.();
    else xhr.onabort?.();

    await expect(pending).rejects.toMatchObject({ status: 0 });
    await expect(pending).rejects.toThrow(message);
  });

  it('ignores uncomputable progress and duplicate terminal events', async () => {
    const progress: number[] = [];
    const submit = createSubmitProjectVersion(() => xhr as unknown as XMLHttpRequest);
    const pending = submit('p1', new File(['game'], 'game.zip'), {}, (value) => progress.push(value));

    xhr.progress(5, 0, false);
    xhr.complete(201, response);
    xhr.onerror?.();
    xhr.complete(201, response);

    await expect(pending).resolves.toEqual(response);
    expect(progress).toEqual([0, 100]);
  });

  it('rejects a successful status whose response is incomplete', async () => {
    const submit = createSubmitProjectVersion(() => xhr as unknown as XMLHttpRequest);
    const pending = submit('p1', new File(['game'], 'game.zip'), {}, () => undefined);

    xhr.complete(204, '');

    await expect(pending).rejects.toMatchObject({ status: 204 });
    await expect(pending).rejects.toThrow('响应不完整');
  });
});
