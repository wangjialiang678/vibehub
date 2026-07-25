/** 种子数据：建一个课程、一个老师、几个邀请码，方便本地跑通黄金路径。 */
import { nanoid, customAlphabet } from 'nanoid';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db, now } from './lib/db.js';
import { issueToken } from './lib/auth.js';
import { publishVersion, versionDir } from './services/publish.js';

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

// 集合页演示用的已发布作品；必须带分类，才能让「创作主题」反映真实内容。
const sampleStudentId = 'u_' + nanoid(10);
db.prepare('INSERT INTO users (id,username,display_name,created_at) VALUES (?,?,?,?)')
  .run(sampleStudentId, 'city-walker', '城市漫游者', now());
db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
  .run(campId, sampleStudentId, 'student', now());

const sampleProjectId = 'p_' + nanoid(10);
const sampleVersionId = 'v_' + nanoid(12);
const sampleSlug = 'city-notes';
const sampleHtml = '<!doctype html><meta charset="utf-8"><title>城市漫游手册</title><main><h1>城市漫游手册</h1><p>记录此刻的街道、声音和偶遇。</p></main>';
db.prepare(`INSERT INTO projects
  (id,camp_id,owner_user_id,slug,title,tagline,category,dev_status,publish_status,live_version_id,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  sampleProjectId, campId, sampleStudentId, sampleSlug, '城市漫游手册', '记录街道、声音和偶遇。', '城市与生活',
  'published', 'published', sampleVersionId, now(), now());
db.prepare(`INSERT INTO versions
  (id,project_id,label,seq,summary,flows,bundle_sha,bundle_size,file_count,preview_id,submitted_by,submitted_via,submitted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  sampleVersionId, sampleProjectId, 'v0.1.0', 1, '创建城市漫游手册。', '[]', 'seed-city-notes', Buffer.byteLength(sampleHtml), 1,
  'seedcitynotes001', sampleStudentId, 'seed', now());
mkdirSync(versionDir(sampleVersionId), { recursive: true });
writeFileSync(`${versionDir(sampleVersionId)}/index.html`, sampleHtml);
publishVersion({ username: 'city-walker', slug: sampleSlug, versionId: sampleVersionId });

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
