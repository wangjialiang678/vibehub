import { nanoid } from 'nanoid';
import { db, now } from '../lib/db.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export class IdentityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeStudentName(value, field = 'real_name', { optional = false } = {}) {
  const text = String(value ?? '').trim().normalize('NFKC');
  if (!text) {
    if (optional) return null;
    throw new IdentityError(`${field}_required`, field === 'real_name' ? '请填写学员真实姓名。' : '请填写公开昵称。');
  }
  if (CONTROL_CHARS.test(text)) throw new IdentityError(`invalid_${field}`, '姓名或昵称包含不可用字符。');
  if ([...text].length > 40) throw new IdentityError(`invalid_${field}`, '姓名和昵称最多 40 个字。');
  return text;
}

export function comparableStudentName(value) {
  return normalizeStudentName(value, 'real_name').replace(/[\s·・‧•]/g, '').toLocaleLowerCase('zh-CN');
}

export function safeGeneratedNickname(sequence = 1, prefix = '营地创作者') {
  return `${prefix}${String(sequence).padStart(2, '0')}`;
}

function rosterView(id) {
  return db.prepare(`SELECT r.*, i.code, i.status AS invite_status, i.bound_project_id,
                            p.title AS project_title
                     FROM camp_roster r
                     LEFT JOIN invites i ON i.roster_entry_id=r.id
                     LEFT JOIN projects p ON p.id=i.bound_project_id
                     WHERE r.id=?`).get(id);
}

function audit({ campId, actorUserId, action, targetId, detail }) {
  db.prepare(`INSERT INTO audit_logs (id,camp_id,actor_user_id,action,target_type,target_id,detail,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run('audit_' + nanoid(12), campId, actorUserId || null, action, 'roster_entry', targetId, JSON.stringify(detail || {}), now());
}

export function listRosterEntries(campId) {
  return db.prepare(`SELECT r.*, i.code, i.status AS invite_status, i.bound_project_id,
                            p.title AS project_title
                     FROM camp_roster r
                     LEFT JOIN invites i ON i.roster_entry_id=r.id
                     LEFT JOIN projects p ON p.id=i.bound_project_id
                     WHERE r.camp_id=? ORDER BY r.created_at,r.id`).all(campId);
}

export function profileForUser(userId, campId) {
  const row = db.prepare(`SELECT id,real_name,display_name,source,verification_status
                          FROM camp_roster WHERE user_id=? AND camp_id=? LIMIT 1`).get(userId, campId);
  return row || null;
}

export function updateOwnProfile({ userId, campId, input }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    let roster = db.prepare('SELECT * FROM camp_roster WHERE user_id=? AND camp_id=? LIMIT 1').get(userId, campId);
    if (!user) throw new IdentityError('profile_not_found', '还没有找到你的学员资料，请联系老师。', 404);
    if (!roster) {
      const invite = db.prepare(`SELECT * FROM invites WHERE camp_id=? AND bound_user_id=? AND role='student' LIMIT 1`).get(campId, userId);
      if (!invite) throw new IdentityError('profile_not_found', '还没有找到你的学员资料，请联系老师。', 404);
      const realName = normalizeStudentName(input.real_name, 'real_name');
      const displayName = normalizeStudentName(input.display_name || user.display_name || safeGeneratedNickname(1), 'display_name');
      const id = 'roster_' + nanoid(12);
      db.prepare(`INSERT INTO camp_roster
        (id,camp_id,real_name,display_name,user_id,source,verification_status,created_at,updated_at)
        VALUES (?,?,?,?,?,'student','self_reported',?,?)`)
        .run(id, campId, realName, displayName, userId, now(), now());
      db.prepare('UPDATE invites SET roster_entry_id=? WHERE code=?').run(id, invite.code);
      roster = db.prepare('SELECT * FROM camp_roster WHERE id=?').get(id);
    }
    const displayName = input.display_name === undefined ? user.display_name : normalizeStudentName(input.display_name, 'display_name');
    let realName = roster.real_name;
    if (input.real_name !== undefined) {
      const requested = normalizeStudentName(input.real_name, 'real_name');
      if (roster.verification_status === 'verified' && requested !== roster.real_name) {
        throw new IdentityError('real_name_locked', '真实姓名已经由老师确认。如需更正，请联系老师。', 409);
      }
      realName = requested;
    }
    db.prepare('UPDATE users SET real_name=?,display_name=? WHERE id=?').run(realName, displayName, userId);
    db.prepare('UPDATE camp_roster SET real_name=?,display_name=?,updated_at=? WHERE id=?')
      .run(realName, displayName, now(), roster.id);
    db.exec('COMMIT');
    return {
      user: { id: user.id, username: user.username, real_name: realName, display_name: displayName, avatar_url: user.avatar_url },
      profile: { id: roster.id, source: roster.source, verification_status: roster.verification_status },
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 没有活动事务 */ }
    throw error;
  }
}

export function importRosterEntries({ campId, entries, actorUserId, source = 'teacher', manageTransaction = true }) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 200) {
    throw new IdentityError('invalid_roster', '名单需要包含 1 到 200 名学员。');
  }
  if (manageTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const camp = db.prepare('SELECT id FROM camps WHERE id=?').get(campId);
    if (!camp) throw new IdentityError('not_found', '找不到这个营地。', 404);
    let created = 0;
    const items = [];
    for (const [index, raw] of entries.entries()) {
      const realName = normalizeStudentName(raw?.real_name, 'real_name');
      const displayName = normalizeStudentName(raw?.display_name || safeGeneratedNickname(index + 1), 'display_name');
      const code = raw?.code ? String(raw.code).trim().toUpperCase() : null;
      let invite = null;
      let roster = null;
      if (code) {
        invite = db.prepare('SELECT * FROM invites WHERE code=? AND camp_id=?').get(code, campId);
        if (!invite) throw new IdentityError('invite_not_found', `邀请码 ${code} 不属于这个营地。`, 404);
        if (invite.role !== 'student') throw new IdentityError('invalid_invite_role', '老师邀请码不能关联学员名单。');
        if (invite.roster_entry_id) roster = db.prepare('SELECT * FROM camp_roster WHERE id=?').get(invite.roster_entry_id);
        if (roster && roster.camp_id !== campId) throw new IdentityError('roster_conflict', '邀请码的名单关联不属于这个营地。', 409);
        if (roster?.user_id && invite.bound_user_id && roster.user_id !== invite.bound_user_id) {
          throw new IdentityError('roster_conflict', '邀请码与名单已经关联到不同账号，请联系技术支持。', 409);
        }
      }
      if (!roster) {
        const id = 'roster_' + nanoid(12);
        db.prepare(`INSERT INTO camp_roster
          (id,camp_id,real_name,display_name,user_id,source,verification_status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(id, campId, realName, displayName, invite?.bound_user_id || null,
            source, source === 'teacher' ? 'verified' : 'self_reported', now(), now());
        if (invite) db.prepare('UPDATE invites SET roster_entry_id=? WHERE code=?').run(id, invite.code);
        roster = db.prepare('SELECT * FROM camp_roster WHERE id=?').get(id);
        created++;
      } else {
        db.prepare(`UPDATE camp_roster SET real_name=?,display_name=?,user_id=COALESCE(user_id,?),
                    source=CASE WHEN ?='teacher' THEN 'teacher' ELSE source END,
                    verification_status=CASE WHEN ?='teacher' THEN 'verified' ELSE verification_status END,
                    updated_at=? WHERE id=?`)
          .run(realName, displayName, invite?.bound_user_id || null, source, source, now(), roster.id);
      }
      if (invite?.bound_user_id) {
        const user = db.prepare('SELECT display_name FROM users WHERE id=?').get(invite.bound_user_id);
        db.prepare(`UPDATE users SET real_name=?,display_name=? WHERE id=?`)
          .run(realName, !user?.display_name || user.display_name === '新学员' ? displayName : user.display_name, invite.bound_user_id);
      }
      items.push(rosterView(roster.id));
    }
    if (actorUserId) audit({ campId, actorUserId, action: 'roster_import', targetId: campId, detail: { count: entries.length, created } });
    if (manageTransaction) db.exec('COMMIT');
    return { created, items };
  } catch (error) {
    if (manageTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* 没有活动事务 */ }
    }
    throw error;
  }
}

export function updateRosterEntry({ campId, rosterId, input, actorUserId }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT * FROM camp_roster WHERE id=? AND camp_id=?').get(rosterId, campId);
    if (!current) throw new IdentityError('not_found', '找不到这名学员。', 404);
    const realName = input.real_name === undefined ? current.real_name : normalizeStudentName(input.real_name, 'real_name');
    const displayName = input.display_name === undefined ? current.display_name : normalizeStudentName(input.display_name, 'display_name');
    const verification = input.verified === undefined ? current.verification_status : input.verified ? 'verified' : 'self_reported';
    db.prepare(`UPDATE camp_roster SET real_name=?,display_name=?,verification_status=?,updated_at=? WHERE id=?`)
      .run(realName, displayName, verification, now(), rosterId);
    if (current.user_id) db.prepare('UPDATE users SET real_name=?,display_name=? WHERE id=?').run(realName, displayName, current.user_id);
    audit({ campId, actorUserId, action: 'roster_update', targetId: rosterId,
      detail: { real_name_changed: realName !== current.real_name, display_name_changed: displayName !== current.display_name, verification_status: verification } });
    db.exec('COMMIT');
    return rosterView(rosterId);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 没有活动事务 */ }
    throw error;
  }
}
