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

// 每个未审核预览必须拥有独立 origin。只换 host-only cookie 但仍共用 origin 时，
// 恶意作品可以跨路径 fetch 浏览器已授权的另一个预览并读取响应。
export const PREVIEW_ORIGIN_TEMPLATE = env.VIBEHUB_PREVIEW_ORIGIN_TEMPLATE ||
  (env.NODE_ENV === 'production'
    ? 'https://{previewId}.preview.supermind-ai.cn'
    : `http://{previewId}.preview.localhost:${PORT}`);
if ((PREVIEW_ORIGIN_TEMPLATE.match(/\{previewId\}/g) || []).length !== 1) {
  throw new Error('VIBEHUB_PREVIEW_ORIGIN_TEMPLATE 必须且只能包含一个 {previewId}');
}

// 模型网关使用营地中台已经提供的 OpenAI 兼容接口。token 只从运行环境读取，
// 未配置时诊断仍会以模板文案交付，不能因为模型故障卡住学员提交。
export const MODEL_GATEWAY_URL = env.VIBEHUB_MODEL_GATEWAY_URL || `http://127.0.0.1:${env.HUB_PORT || 4100}`;
export const MODEL_GATEWAY_TOKEN = env.VIBEHUB_MODEL_GATEWAY_TOKEN || '';

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
  baasRecordBytesPerProject: 32 * 1024 * 1024,
  baasCollectionsPerProject: 100,
  baasCounterKeysPerProject: 100,
  baasFileBytes: 20 * 1024 * 1024,
  baasBytesPerProject: 500 * 1024 * 1024,
  diagnosisPerDay: 20,
  projectDiskBytes: Number(env.VIBEHUB_PROJECT_DISK_BYTES || 200 * 1024 * 1024),
  probeTimeoutMs: 15_000,
  probeReadBytes: 2 * 1024 * 1024,
  probeResources: 100,
};

export const worksUrl = (username, slug) =>
  `${WORKS_ORIGIN}${WORKS_PREFIX}/${username}/${slug}/`;

export const worksPath = (username, slug) =>
  `${WORKS_PREFIX}/${username}/${slug}/`;

export const previewOrigin = (previewId) => {
  if (!/^[a-z0-9]{16}$/.test(previewId)) throw new Error('previewId 格式不合法');
  const url = new URL(PREVIEW_ORIGIN_TEMPLATE.replace('{previewId}', previewId));
  if (url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('VIBEHUB_PREVIEW_ORIGIN_TEMPLATE 必须是 HTTP(S) origin，不能包含路径、query 或 fragment');
  }
  return url.origin;
};

export const previewUrl = (previewId) =>
  `${previewOrigin(previewId)}${WORKS_PREFIX}/_preview/${previewId}/`;

export const previewPath = (previewId) =>
  `${WORKS_PREFIX}/_preview/${previewId}/`;
