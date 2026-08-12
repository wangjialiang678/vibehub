const MB = 1024 * 1024;
const PACKAGE_LIMIT = 30 * MB;
const HTML_LIMIT = 20 * MB;
const FILE_COUNT_LIMIT = 5000;
const ARCHIVE_EXTENSIONS = ['.zip', '.tar.gz', '.tgz'];
const HTML_EXTENSIONS = ['.html', '.htm'];
const SENSITIVE_DIRECTORIES = new Set(['.git', '.aws', '.ssh', 'node_modules']);
const SENSITIVE_FILES = new Set(['.env', '.npmrc', 'credentials.json']);
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.pfx', '.p12', '.log'];

function hasExtension(name: string, extensions: string[]) {
  const normalized = name.toLowerCase();
  return extensions.some((extension) => normalized.endsWith(extension));
}

function assertSize(file: File) {
  if (hasExtension(file.name, HTML_EXTENSIONS) && file.size > HTML_LIMIT) {
    throw new Error('HTML 文件不能超过 20 MB，请压缩页面中的图片、音频或视频后再试。');
  }
  if (file.size > PACKAGE_LIMIT) {
    throw new Error('上传包不能超过 30 MB，请压缩大文件后再试。');
  }
}

function normalizeFolderPath(file: File) {
  const rawPath = file.webkitRelativePath;
  const path = rawPath.replace(/\\/g, '/');
  const parts = path.split('/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || parts.some((part) => !part || part === '..')) {
    throw new Error(`文件路径不安全：${rawPath || file.name}`);
  }

  for (const part of parts) {
    const name = part.toLowerCase();
    if (name === 'node_modules') {
      throw new Error(`文件夹包含 node_modules：${rawPath}。请移除后重新选择。`);
    }
    if (SENSITIVE_DIRECTORIES.has(name)
      || SENSITIVE_FILES.has(name)
      || name.startsWith('.env.')
      || name.startsWith('id_rsa')
      || name.startsWith('id_ed25519')
      || SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
      throw new Error(`文件夹包含敏感文件：${rawPath}。请移除后重新选择。`);
    }
  }
  return path;
}

interface ZipWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

type ZipWorkerFactory = () => ZipWorker;

function zipFolderInWorker(files: File[], paths: string[], workerFactory: ZipWorkerFactory) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = workerFactory();
    let settled = false;
    let index = 0;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      action();
    };
    const fail = () => finish(() => reject(new Error('文件夹压缩失败，请重新选择后再试。')));
    const sendNext = async () => {
      if (settled) return;
      if (index >= files.length) {
        worker.postMessage({ type: 'finish' });
        return;
      }
      const current = index++;
      try {
        const data = await files[current].arrayBuffer();
        if (!settled) worker.postMessage({ type: 'add', path: paths[current], data }, [data]);
      } catch {
        fail();
      }
    };
    worker.onmessage = (event) => {
      const message = event.data as { type?: string; archive?: unknown };
      if (message.type === 'added') {
        void sendNext();
      } else if (message.type === 'done' && message.archive instanceof ArrayBuffer) {
        const archive = message.archive;
        finish(() => resolve(archive));
      } else {
        fail();
      }
    };
    worker.onerror = fail;
    void sendNext();
  });
}

export function createPrepareSubmissionFiles(workerFactory: ZipWorkerFactory) {
  return async (files: File[]): Promise<File> => {
    if (files.length === 0) throw new Error('请选择要提交的 HTML、压缩包或网页文件夹。');

    const single = files.length === 1 ? files[0] : null;
    if (single && !single.webkitRelativePath) {
      if (!hasExtension(single.name, [...HTML_EXTENSIONS, ...ARCHIVE_EXTENSIONS])) {
        throw new Error('只支持单个 HTML、ZIP、tar.gz 文件，或选择一个网页文件夹。');
      }
      assertSize(single);
      return single;
    }

    const hasFolderPath = files.some((file) => Boolean(file.webkitRelativePath));
    if (hasFolderPath && files.some((file) => !file.webkitRelativePath)) {
      throw new Error('文件夹中存在空文件路径，请重新选择整个文件夹。');
    }
    if (!hasFolderPath) {
      throw new Error('多个文件需要通过“选择文件夹”添加，不能直接多选普通文件。');
    }
    if (files.length > FILE_COUNT_LIMIT) {
      throw new Error(`文件夹中的文件不能超过 ${FILE_COUNT_LIMIT} 个，请清理后重新选择。`);
    }
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > PACKAGE_LIMIT) {
      throw new Error('文件夹内容不能超过 30 MB，请压缩大文件后再试。');
    }

    const paths = files.map(normalizeFolderPath);
    if (new Set(paths).size !== paths.length) {
      throw new Error('文件夹中存在重复路径，请整理后重新选择。');
    }
    const root = paths[0].split('/')[0];
    if (paths.some((path) => path.split('/')[0] !== root)) {
      throw new Error('一次只能选择一个网页文件夹。');
    }

    const archive = await zipFolderInWorker(files, paths, workerFactory);
    if (archive.byteLength > PACKAGE_LIMIT) {
      throw new Error('压缩后的上传包超过 30 MB，请压缩大文件后再试。');
    }
    return new File([archive], `${root}.zip`, { type: 'application/zip' });
  };
}

const browserZipWorkerFactory = () => new Worker(
  new URL('../workers/submissionZip.worker.ts', import.meta.url),
  { type: 'module' },
);

export const prepareSubmissionFiles = createPrepareSubmissionFiles(browserZipWorkerFactory);
