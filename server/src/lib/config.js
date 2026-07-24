import { homedir } from 'node:os';

const env = process.env;

// 数据根目录。生产用 /var/lib/vibehub，本地默认放用户目录，绝不进仓库。
export const DATA_DIR = env.VIBEHUB_DATA_DIR || `${homedir()}/.vibehub-data`;

export const PORT = Number(env.VIBEHUB_PORT || 4300);
export const HOST = env.VIBEHUB_HOST || '127.0.0.1';

// 控制台与 API 的 origin。**必须与作品 origin 不同**——否则学员作品的 JS
// 能读到平台 cookie。详见 docs/specs/decisions-r1.md 修订 1。
export const CONSOLE_ORIGIN = env.VIBEHUB_CONSOLE_ORIGIN || `http://localhost:5173`;

// 作品对外根地址。决策 2：路径式 supermind-ai.cn/vibehub/<username>/<project>/
export const WORKS_ORIGIN = env.VIBEHUB_WORKS_ORIGIN || `http://localhost:${PORT}`;
export const WORKS_PREFIX = env.VIBEHUB_WORKS_PREFIX || '/vibehub';

export const paths = {
  versions: `${DATA_DIR}/versions`,
  sites: `${DATA_DIR}/sites`,
  previews: `${DATA_DIR}/previews`,
  uploads: `${DATA_DIR}/uploads`,
  tmp: `${DATA_DIR}/tmp`,
};

export const LIMITS = {
  bundleBytes: 30 * 1024 * 1024,      // 上传包上限
  unpackedBytes: 200 * 1024 * 1024,   // 解包后总大小
  fileCount: 5000,
  singleFileBytes: 20 * 1024 * 1024,
  baasRecordBytes: 64 * 1024,
  baasRecordsPerProject: 100_000,
  baasFileBytes: 20 * 1024 * 1024,
  baasBytesPerProject: 500 * 1024 * 1024,
  diagnosisPerDay: 20,
};

export const worksUrl = (username, slug) =>
  `${WORKS_ORIGIN}${WORKS_PREFIX}/${username}/${slug}/`;

export const worksPath = (username, slug) =>
  `${WORKS_PREFIX}/${username}/${slug}/`;

export const previewUrl = (previewId) =>
  `${WORKS_ORIGIN}${WORKS_PREFIX}/_preview/${previewId}/`;

export const previewPath = (previewId) =>
  `${WORKS_PREFIX}/_preview/${previewId}/`;
