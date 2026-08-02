import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const AUDIENCE = 'vibehub-preview';
export const PREVIEW_CLAIM_TTL_SECONDS = 10 * 60;

const configuredSecret = process.env.VIBEHUB_PREVIEW_CLAIM_SECRET || '';
if (process.env.NODE_ENV === 'production' && configuredSecret.length < 32) {
  throw new Error('生产环境必须配置至少 32 字符的 VIBEHUB_PREVIEW_CLAIM_SECRET');
}
const secret = Buffer.from(configuredSecret || randomBytes(32).toString('base64url'));

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = (encoded) => createHmac('sha256', secret).update(encoded).digest('base64url');

export function redactPreviewClaim(value) {
  return String(value || '').replace(/([?&]claim=)[^&\s]+/gi, '$1[redacted]');
}

export function issuePreviewClaim({ previewId, versionId, projectId, identity }, issuedAt = Date.now()) {
  const iat = Math.floor(issuedAt / 1000);
  const payload = {
    aud: AUDIENCE,
    pid: previewId,
    vid: versionId,
    project_id: projectId,
    sub: identity.user_id,
    camp_id: identity.camp_id,
    scope_project_id: identity.project_id || null,
    role: identity.role,
    iat,
    exp: iat + PREVIEW_CLAIM_TTL_SECONDS,
  };
  const encoded = encode(payload);
  return {
    claim: `${encoded}.${sign(encoded)}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export function verifyPreviewClaim(claim, previewId, checkedAt = Date.now()) {
  if (typeof claim !== 'string' || claim.length > 4096) return null;
  const [encoded, signature, extra] = claim.split('.');
  if (!encoded || !signature || extra) return null;
  const expected = Buffer.from(sign(encoded));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  const nowSeconds = Math.floor(checkedAt / 1000);
  if (payload?.aud !== AUDIENCE || payload.pid !== previewId || !payload.vid || !payload.project_id ||
      !payload.sub || !payload.camp_id || !payload.role || !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) || payload.exp <= nowSeconds || payload.exp - payload.iat !== PREVIEW_CLAIM_TTL_SECONDS) return null;
  return payload;
}
