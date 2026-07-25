import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, now } from './db.js';
import { CONSOLE_ORIGIN } from './config.js';

const hash = (t) => createHash('sha256').update(t).digest('hex');

/**
 * 凭证是不透明随机串，不是 JWT——必须支持即时吊销
 * （老师撤销邀请码 → 该码签发的所有 token 立刻失效）。
 * 库里只存哈希。
 */
export function issueToken({ kind, userId, campId, projectId, role, inviteCode, deviceName }) {
  const raw = (kind === 'skill' ? 'vhk_' : 'vhs_') + randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO tokens (id,token_hash,kind,user_id,camp_id,project_id,role,invite_code,device_name,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run('t_' + nanoid(12), hash(raw), kind, userId, campId, projectId ?? null, role, inviteCode ?? null, deviceName ?? null, now());
  return raw;
}

export function resolveToken(raw) {
  if (!raw) return null;
  const row = db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(raw));
  if (!row) return null;
  if (row.expires_at && row.expires_at < now()) return null;
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return row;
}

export function revokeTokensForInvite(code) {
  return db.prepare('UPDATE tokens SET revoked_at = ? WHERE invite_code = ? AND revoked_at IS NULL')
    .run(now(), code).changes;
}

export function countDevices(code) {
  return db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE invite_code = ? AND revoked_at IS NULL').get(code)?.n ?? 0;
}

const isMutation = (method) => ['POST', 'PATCH', 'DELETE'].includes(method);

/** 只有控制台本身可用 cookie 发起会改变状态的请求。 */
export function hasAllowedCookieOrigin(req) {
  if (!isMutation(req.method)) return true;
  const origin = String(req.headers.origin || '');
  return origin === CONSOLE_ORIGIN || /^http:\/\/localhost(?::\d+)?$/.test(origin);
}

/** 项目级路由统一使用它，避免老师权限漏掉 camp 边界。 */
export function assertProjectAccess(project, auth) {
  if (!project || project.camp_id !== auth.camp_id) return false;
  return isTeacher(auth.role) || project.id === auth.project_id;
}

/**
 * 鉴权铁律（抄超脑上传平台 ADR-002 的教训）：
 * 服务端只认凭证内嵌的 scope，绝不接受客户端自报的 camp/project。
 */
export function authRequired(roles = null) {
  return async (req, reply) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const credentialSource = bearer ? 'bearer' : req.cookies?.vh_session ? 'cookie' : null;
    const raw = bearer || req.cookies?.vh_session;
    const tok = resolveToken(raw);
    if (!tok) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: '身份已失效，请重新用邀请码接入。', hint: '在 AI 工具里运行 vibehub bind <邀请码>' },
      });
    }
    if (credentialSource === 'cookie' && !hasAllowedCookieOrigin(req)) {
      return reply.code(403).send({
        error: { code: 'csrf_origin_invalid', message: '请从 VibeHub 控制台发起此操作。' },
      });
    }
    if (roles && !roles.includes(tok.role)) {
      // 越权一律 404，不告诉对方「存在但你无权」
      return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个内容。' } });
    }
    req.auth = tok;
    req.authSource = credentialSource;
  };
}

export const isTeacher = (role) => role === 'teacher' || role === 'admin';
