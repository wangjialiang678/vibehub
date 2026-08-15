#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { db } from '../src/lib/db.js';
import { paths } from '../src/lib/config.js';
import { extractDocumentTitle } from '../src/services/version-submission.js';

export function deriveProjectTagline(summary) {
  const value = String(summary || '')
    .replace(/^(?:首次提交|本次提交|更新说明)\s*[：:]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return null;
  return value.length <= 160 ? value : `${value.slice(0, 159)}…`;
}

export function planCampMetadataBackfill({ database = db, campSlug, publishRosterNames = false }) {
  if (!campSlug) throw new Error('必须通过 --camp 指定营地。');
  const camp = database.prepare('SELECT id,slug FROM camps WHERE slug=?').get(campSlug);
  if (!camp) throw new Error(`找不到营地：${campSlug}`);

  const rosterNames = [];
  if (publishRosterNames) {
    const roster = database.prepare(`SELECT r.id,r.real_name,r.display_name,r.user_id
      FROM camp_roster r WHERE r.camp_id=?`).all(camp.id);
    for (const row of roster) {
      const realName = String(row.real_name || '').trim();
      if (!realName) continue;
      if (row.display_name !== realName) rosterNames.push({ id: row.id, displayName: realName });
    }
  }

  const projectRealnames = [];
  if (publishRosterNames) {
    const scopedProjects = database.prepare(`SELECT p.id,p.visibility FROM projects p
      WHERE p.camp_id=? AND EXISTS (
        SELECT 1 FROM camp_roster r WHERE r.camp_id=p.camp_id AND r.user_id=p.owner_user_id
      )`).all(camp.id);
    for (const project of scopedProjects) {
      if (project.visibility == null || project.visibility === 'nickname') projectRealnames.push({ id: project.id });
    }
  }

  const projectTitles = [];
  const projectTaglines = [];
  const projects = database.prepare(`SELECT p.id,p.title,p.tagline,p.live_version_id,v.summary
    FROM projects p JOIN versions v ON v.id=p.live_version_id
    WHERE p.camp_id=? AND p.live_version_id IS NOT NULL
      AND p.publish_status IN ('published','published_with_pending')`).all(camp.id);
  for (const project of projects) {
    if (project.title === '我的作品') {
      const indexPath = join(paths.versions, project.live_version_id, 'index.html');
      const title = existsSync(indexPath) ? extractDocumentTitle(indexPath) : null;
      if (title && title !== project.title) projectTitles.push({ id: project.id, title });
    }
    if (!String(project.tagline || '').trim()) {
      const tagline = deriveProjectTagline(project.summary);
      if (tagline) projectTaglines.push({ id: project.id, tagline });
    }
  }

  return {
    camp,
    rosterNames,
    projectRealnames,
    projectTitles,
    projectTaglines,
    counts: {
      roster_names: rosterNames.length,
      project_realnames: projectRealnames.length,
      project_titles: projectTitles.length,
      project_taglines: projectTaglines.length,
    },
  };
}

export function applyCampMetadataBackfill({ database = db, campSlug, actorUsername, publishRosterNames = false }) {
  if (!actorUsername) throw new Error('正式写入必须通过 --actor 指定老师账号。');
  database.exec('BEGIN IMMEDIATE');
  try {
    const plan = planCampMetadataBackfill({ database, campSlug, publishRosterNames });
    const actor = database.prepare(`SELECT u.id FROM users u JOIN camp_members m ON m.user_id=u.id
      WHERE u.username=? AND m.camp_id=? AND m.role IN ('teacher','admin')`).get(actorUsername, plan.camp.id);
    if (!actor) throw new Error('执行者不是该营地的老师或管理员。');

    const at = new Date().toISOString();
    const updateRoster = database.prepare('UPDATE camp_roster SET display_name=?,updated_at=? WHERE id=?');
    const updateVisibility = database.prepare(`UPDATE projects SET visibility='realname',realname_consent_at=?,realname_consent_by=?,updated_at=? WHERE id=?`);
    const updateTitle = database.prepare('UPDATE projects SET title=?,updated_at=? WHERE id=?');
    const updateTagline = database.prepare('UPDATE projects SET tagline=?,updated_at=? WHERE id=?');
    for (const item of plan.rosterNames) updateRoster.run(item.displayName, at, item.id);
    for (const item of plan.projectRealnames) updateVisibility.run(at, actor.id, at, item.id);
    for (const item of plan.projectTitles) updateTitle.run(item.title, at, item.id);
    for (const item of plan.projectTaglines) updateTagline.run(item.tagline, at, item.id);

    const changed = Object.values(plan.counts).some((count) => count > 0);
    if (changed) {
      database.prepare(`INSERT INTO audit_logs
        (id,camp_id,actor_user_id,action,target_type,target_id,detail,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        `audit_${nanoid(12)}`,
        plan.camp.id,
        actor.id,
        'camp_metadata_backfill',
        'camp',
        plan.camp.id,
        JSON.stringify({ authorization_confirmed: true, publish_roster_names: publishRosterNames, counts: plan.counts }),
        at,
      );
    }
    database.exec('COMMIT');
    return { counts: plan.counts };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* BEGIN 失败时没有事务 */ }
    throw error;
  }
}

function parseArgs(argv) {
  const options = { apply: false, publishRosterNames: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--camp') options.campSlug = argv[++i];
    else if (argv[i] === '--actor') options.actorUsername = argv[++i];
    else if (argv[i] === '--publish-roster-names') options.publishRosterNames = true;
    else if (argv[i] === '--apply') options.apply = true;
    else throw new Error(`不认识参数：${argv[i]}`);
  }
  return options;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.apply
      ? applyCampMetadataBackfill(options)
      : planCampMetadataBackfill(options);
    process.stdout.write(`${JSON.stringify({ mode: options.apply ? 'applied' : 'dry_run', counts: result.counts })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : '处理失败'}\n`);
    process.exitCode = 1;
  }
}
