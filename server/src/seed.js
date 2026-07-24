/** 种子数据：建一个课程、一个老师、几个邀请码，方便本地跑通黄金路径。 */
import { nanoid, customAlphabet } from 'nanoid';
import { db, now } from './lib/db.js';
import { issueToken } from './lib/auth.js';

const codeGen = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 4);

const campId = 'c_' + nanoid(10);
db.prepare(`INSERT INTO camps (id,slug,name,kind,theme,intro,created_at)
            VALUES (?,?,?,?,?,?,?)`).run(
  campId, 'ai-product-2026s', 'AI 产品共创课', 'course',
  '2026 夏季 · VIBE CODING',
  '这里收集了 AI 产品共创课中已经正式发布的作品。每一个入口，都通往一位学员亲手完成的产品。',
  now());

const teacherId = 'u_' + nanoid(10);
db.prepare('INSERT INTO users (id,username,display_name,real_name,created_at) VALUES (?,?,?,?,?)')
  .run(teacherId, 'teacher-lele', '乐乐老师', '乐乐', now());
db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
  .run(campId, teacherId, 'teacher', now());

const teacherToken = issueToken({ kind: 'web', userId: teacherId, campId, role: 'teacher' });

const codes = [];
for (let i = 0; i < 10; i++) {
  const code = `CAMP-${codeGen()}`;
  db.prepare(`INSERT INTO invites (code,camp_id,role,status,max_devices,created_at)
              VALUES (?,?,?,'unused',3,?)`).run(code, campId, 'student', now());
  codes.push(code);
}

console.log(JSON.stringify({
  camp_id: campId,
  camp_slug: 'ai-product-2026s',
  teacher_token: teacherToken,
  student_invite_codes: codes,
}, null, 2));
