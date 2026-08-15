import { nanoid } from 'nanoid';
import { db, now } from '../lib/db.js';
import { countDevices, issueToken } from '../lib/auth.js';
import { comparableStudentName, normalizeStudentName, safeGeneratedNickname } from './student-identity.js';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_TRACKED_KEYS = 10_000;

export class InviteRateLimiter {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.byIp = new Map();
    this.byCode = new Map();
  }

  #active(map, key) {
    const cutoff = this.clock() - WINDOW_MS;
    const active = (map.get(key) || []).filter((at) => at > cutoff);
    if (active.length) map.set(key, active);
    else map.delete(key);
    return active;
  }

  isBlocked(ip, code) {
    return this.#active(this.byIp, ip).length >= MAX_ATTEMPTS ||
      this.#active(this.byCode, code).length >= MAX_ATTEMPTS;
  }

  recordFailure(ip, code) {
    const at = this.clock();
    for (const [map, key] of [[this.byIp, ip], [this.byCode, code]]) {
      const active = this.#active(map, key);
      active.push(at);
      map.set(key, active);
      if (map.size > MAX_TRACKED_KEYS) map.delete(map.keys().next().value);
    }
  }
}

export const normalizeInviteCode = (code) => String(code || '').trim().toUpperCase();

export function bindInvite(code, { kind, deviceName, realName: rawRealName, displayName: rawDisplayName }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 所有授权判断必须在同一个写事务内重读；不能用事务前快照与撤销/并发兑换竞争。
    const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
    if (!invite) {
      db.exec('ROLLBACK');
      return { error: ['invite_not_found', 404, '这个邀请码不存在，检查一下有没有输错。', '注意区分数字 0 和字母 O'] };
    }
    if (invite.status === 'revoked') {
      db.exec('ROLLBACK');
      return { error: ['invite_revoked', 403, '这个邀请码已经被撤销了。', '找老师要一个新的'] };
    }
    if (invite.expires_at && invite.expires_at < now()) {
      db.exec('ROLLBACK');
      return { error: ['invite_expired', 403, '这个邀请码已经过期了。', '找老师要一个新的'] };
    }
    if (kind === 'skill' && countDevices(invite.code) >= invite.max_devices) {
      db.exec('ROLLBACK');
      return { error: ['invite_device_limit', 403,
        `这个邀请码最多绑定 ${invite.max_devices} 台设备，已经用完了。`, '让老师撤销旧设备，或者要一个新码'] };
    }

    const camp = db.prepare('SELECT * FROM camps WHERE id = ?').get(invite.camp_id);
    let user = invite.bound_user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(invite.bound_user_id) : null;
    let project = invite.bound_project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(invite.bound_project_id) : null;
    if (!user) {
      let roster = invite.roster_entry_id ? db.prepare('SELECT * FROM camp_roster WHERE id=? AND camp_id=?').get(invite.roster_entry_id, camp.id) : null;
      if (invite.role === 'student' && !rawRealName) {
        db.exec('ROLLBACK');
        return { error: ['profile_required', 409, roster ? '请确认这是你的邀请码，并填写真实姓名。' : '第一次进入需要补充学员姓名。', '真实姓名只给老师看，公开昵称可以另外填写'] };
      }
      let realName = null;
      let displayName = null;
      if (invite.role === 'student') {
        try {
          realName = normalizeStudentName(rawRealName, 'real_name');
          if (roster && comparableStudentName(realName) !== comparableStudentName(roster.real_name)) {
            db.exec('ROLLBACK');
            return { error: ['profile_mismatch', 409, '姓名与老师分配的邀请码不一致。', '请检查邀请码，或联系老师确认'] };
          }
          const sequence = db.prepare('SELECT COUNT(*) AS n FROM camp_roster WHERE camp_id=?').get(camp.id).n + 1;
          displayName = roster?.display_name || normalizeStudentName(rawDisplayName || safeGeneratedNickname(sequence), 'display_name');
        } catch (error) {
          db.exec('ROLLBACK');
          return { error: [error.code || 'invalid_profile', error.status || 400, error.message || '学员资料格式不正确。'] };
        }
      }
      const uid = 'u_' + nanoid(10);
      const uname = `student-${nanoid(6).toLowerCase()}`;
      db.prepare('INSERT INTO users (id,username,display_name,real_name,created_at) VALUES (?,?,?,?,?)')
        .run(uid, uname, invite.role === 'student' ? displayName : '新成员', realName, now());
      db.prepare('INSERT OR IGNORE INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
        .run(camp.id, uid, invite.role, now());
      if (invite.role === 'student') {
        if (!roster) {
          const rosterId = 'roster_' + nanoid(12);
          db.prepare(`INSERT INTO camp_roster
            (id,camp_id,real_name,display_name,user_id,source,verification_status,created_at,updated_at)
            VALUES (?,?,?,?,?,'student','self_reported',?,?)`)
            .run(rosterId, camp.id, realName, displayName, uid, now(), now());
          db.prepare('UPDATE invites SET roster_entry_id=? WHERE code=?').run(rosterId, invite.code);
          roster = db.prepare('SELECT * FROM camp_roster WHERE id=?').get(rosterId);
        } else {
          db.prepare('UPDATE camp_roster SET user_id=?,updated_at=? WHERE id=?').run(uid, now(), roster.id);
        }
      }
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    }
    if (!project && invite.role === 'student') {
      const pid = 'p_' + nanoid(10);
      const slug = `project-${nanoid(6).toLowerCase()}`;
      db.prepare(`INSERT INTO projects (id,camp_id,owner_user_id,slug,title,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(pid, camp.id, user.id, slug, '我的作品', now(), now());
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    }
    db.prepare(`UPDATE invites SET status='bound', bound_user_id=?, bound_project_id=?, bound_at=COALESCE(bound_at,?) WHERE code=?`)
      .run(user.id, project?.id ?? null, now(), invite.code);
    const token = issueToken({
      kind, userId: user.id, campId: camp.id, projectId: project?.id,
      role: invite.role, inviteCode: invite.code, deviceName,
    });
    db.exec('COMMIT');
    return {
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name, real_name: user.real_name },
      camp: { id: camp.id, slug: camp.slug, name: camp.name },
      project: project ? { id: project.id, slug: project.slug, title: project.title } : null,
      role: invite.role,
      message: `已连接到《${camp.name}》${project ? `，你的作品：${project.title}` : ''}`,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN 失败时没有事务 */ }
    throw error;
  }
}
