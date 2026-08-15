import { nanoid } from 'nanoid';
import { db, now } from '../lib/db.js';
import { issueToken, rotateToken } from '../lib/auth.js';

const TITLE_MAX = 80;
const REQUEST_ID_PATTERN = /^pc_[A-Za-z0-9_-]{13,125}$/;
const CREATE_LIMIT = 5;
const CREATE_WINDOW_MS = 60 * 1000;
const RECONNECT_WINDOW_MS = 60 * 1000;
const CREATE_FIELDS = new Set(['title', 'request_id']);

export class StudentProjectCreationError extends Error {
  constructor(code, status, message, hint = null, retryAfterSeconds = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function validateInput(input) {
  const unknownFields = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.keys(input).filter((key) => !CREATE_FIELDS.has(key))
    : [];
  if (unknownFields.length) {
    throw new StudentProjectCreationError('invalid_project_fields', 400, '创建请求包含不允许的字段。');
  }
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > TITLE_MAX || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(title)) {
    throw new StudentProjectCreationError(
      'invalid_project_title', 400, `作品名称需要填写，且不能超过 ${TITLE_MAX} 个字。`,
    );
  }
  const requestId = typeof input?.request_id === 'string' ? input.request_id.trim() : '';
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new StudentProjectCreationError('invalid_request_id', 400, '创建请求标识不正确，请重新运行创建命令。');
  }
  return { title, requestId };
}

function scopedStudent(auth) {
  if (auth.kind !== 'skill' || auth.role !== 'student' || !auth.project_id || !auth.invite_code) return null;
  const identity = db.prepare(`SELECT t.* FROM tokens t JOIN invites i ON i.code=t.invite_code
    WHERE t.id=? AND t.kind='skill' AND t.role='student'
      AND t.user_id=? AND t.camp_id=? AND t.project_id=? AND t.invite_code=?
      AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>=?)
      AND i.status!='revoked' AND (i.expires_at IS NULL OR i.expires_at>=?)`)
    .get(auth.id, auth.user_id, auth.camp_id, auth.project_id, auth.invite_code, now(), now());
  if (!identity) return null;
  const membership = db.prepare('SELECT role FROM camp_members WHERE camp_id=? AND user_id=?')
    .get(auth.camp_id, auth.user_id);
  if (membership?.role !== 'student') return null;
  const currentProject = db.prepare(`SELECT id FROM projects
    WHERE id=? AND camp_id=? AND owner_user_id=?`).get(auth.project_id, auth.camp_id, auth.user_id);
  return currentProject ? identity : null;
}

function projectView(project) {
  return { id: project.id, slug: project.slug, title: project.title };
}

function issueProjectToken(auth, projectId) {
  return issueToken({
    kind: 'skill', userId: auth.user_id, campId: auth.camp_id, projectId,
    role: 'student', inviteCode: auth.invite_code, derivedFromTokenId: auth.id,
    deviceName: auth.device_name,
  });
}

function reconnectProjectToken(auth, projectId) {
  const tokens = db.prepare(`SELECT * FROM tokens
    WHERE kind='skill' AND user_id=? AND camp_id=? AND invite_code=? AND project_id=?
      AND derived_from_token_id=?
    ORDER BY (revoked_at IS NULL) DESC,created_at,id`)
    .all(auth.user_id, auth.camp_id, auth.invite_code, projectId, auth.id);
  if (!tokens.length) {
    const belongsToAnotherParent = db.prepare(`SELECT 1 FROM tokens
      WHERE kind='skill' AND user_id=? AND camp_id=? AND invite_code=? AND project_id=?
        AND derived_from_token_id IS NOT NULL
      LIMIT 1`).get(auth.user_id, auth.camp_id, auth.invite_code, projectId);
    if (belongsToAnotherParent) {
      throw new StudentProjectCreationError('not_found', 404, '找不到这个内容。');
    }
    return issueProjectToken(auth, projectId);
  }

  const anchor = tokens[0];
  const lastRotation = anchor.last_used_at ? Date.parse(anchor.last_used_at) : NaN;
  if (Number.isFinite(lastRotation) && Date.now() - lastRotation < RECONNECT_WINDOW_MS) {
    throw new StudentProjectCreationError(
      'project_reconnect_rate_limited', 429, '作品连接刚刚已恢复，请一分钟后再试。', null, 60,
    );
  }

  // 旧版可能对同一 parent/project 插入过多行。先全部失效，再清理无子节点的冗余行。
  db.prepare(`UPDATE tokens SET revoked_at=?
    WHERE user_id=? AND camp_id=? AND invite_code=? AND derived_from_token_id=? AND project_id=?
      AND revoked_at IS NULL AND id!=?`)
    .run(now(), auth.user_id, auth.camp_id, auth.invite_code, auth.id, projectId, anchor.id);
  db.prepare(`DELETE FROM tokens WHERE user_id=? AND camp_id=? AND invite_code=?
    AND derived_from_token_id=? AND project_id=? AND id!=?
    AND NOT EXISTS (SELECT 1 FROM tokens child WHERE child.derived_from_token_id=tokens.id)`)
    .run(auth.user_id, auth.camp_id, auth.invite_code, auth.id, projectId, anchor.id);
  return rotateToken(anchor.id);
}

export function createStudentProject(auth, input) {
  const { title, requestId } = validateInput(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    const student = scopedStudent(auth);
    if (!student) throw new StudentProjectCreationError('not_found', 404, '找不到这个内容。');

    const existing = db.prepare(`SELECT * FROM projects
      WHERE owner_user_id=? AND camp_id=? AND creation_request_id=?`)
      .get(student.user_id, student.camp_id, requestId);
    if (existing) {
      const camp = db.prepare('SELECT id,slug,name FROM camps WHERE id=?').get(student.camp_id);
      const token = reconnectProjectToken(student, existing.id);
      db.exec('COMMIT');
      return { created: false, token, camp, project: projectView(existing), message: `已重新连接作品《${existing.title}》` };
    }

    const cutoff = new Date(Date.now() - CREATE_WINDOW_MS).toISOString();
    const recent = db.prepare(`SELECT COUNT(*) AS n FROM projects
      WHERE owner_user_id=? AND camp_id=? AND creation_request_id IS NOT NULL AND created_at>=?`)
      .get(student.user_id, student.camp_id, cutoff).n;
    if (recent >= CREATE_LIMIT) {
      throw new StudentProjectCreationError(
        'project_create_rate_limited', 429, '刚刚创建的作品有点多，请一分钟后再试。', null, 60,
      );
    }

    const projectId = 'p_' + nanoid(10);
    let slug;
    do { slug = `project-${nanoid(8).toLowerCase()}`; }
    while (db.prepare('SELECT 1 FROM projects WHERE camp_id=? AND slug=?').get(student.camp_id, slug));
    const createdAt = now();
    db.prepare(`INSERT INTO projects
      (id,camp_id,owner_user_id,slug,title,creation_request_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(projectId, student.camp_id, student.user_id, slug, title, requestId, createdAt, createdAt);
    db.prepare(`INSERT INTO audit_logs
      (id,camp_id,actor_user_id,action,target_type,target_id,detail,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run('audit_' + nanoid(12), student.camp_id, student.user_id, 'student_project_create', 'project', projectId,
        JSON.stringify({ creation_request_id: requestId }), createdAt);
    const token = issueProjectToken(student, projectId);
    const camp = db.prepare('SELECT id,slug,name FROM camps WHERE id=?').get(student.camp_id);
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    db.exec('COMMIT');
    return { created: true, token, camp, project: projectView(project), message: `已创建并连接作品《${title}》` };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN 失败时没有可回滚事务 */ }
    throw error;
  }
}
