import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'vh-submission-service-'));
process.env.VIBEHUB_DATA_DIR = dataDir;
process.env.VIBEHUB_MODEL_GATEWAY_URL = '';
process.env.VIBEHUB_PREVIEW_CLAIM_SECRET = 'submission-service-preview-secret-32-bytes';

const { buildApp } = await import('../src/index.js');
const { db, now } = await import('../src/lib/db.js');
const { issueToken, resolveToken } = await import('../src/lib/auth.js');
const { paths } = await import('../src/lib/config.js');
const { cleanupTmp, pruneProjectArtifacts } = await import('../src/services/storage.js');
const { makePreview } = await import('../src/services/publish.js');
const {
  SubmissionError,
  findActiveDuplicateVersion,
  submitVersion,
  validateSubmissionMeta,
} = await import('../src/services/version-submission.js');

const app = await buildApp({ probePreview: async () => ({ status: 'ok', entry_status: 200, resource_failures: [] }) });
let sequence = 0;

function clearDatabase() {
  db.exec(`
    DELETE FROM audit_logs;
    DELETE FROM page_views;
    DELETE FROM baas_calls;
    DELETE FROM baas_files;
    DELETE FROM baas_counters;
    DELETE FROM baas_records;
    DELETE FROM diagnoses;
    DELETE FROM deployments;
    DELETE FROM reviews;
    DELETE FROM versions;
    DELETE FROM projects;
    DELETE FROM tokens;
    DELETE FROM invites;
    DELETE FROM camp_members;
    DELETE FROM users;
    DELETE FROM camps;
  `);
  for (const dir of Object.values(paths)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

function fixture() {
  sequence += 1;
  const campId = `c_submission_${sequence}`;
  const userId = `u_submission_${sequence}`;
  const projectId = `p_submission_${sequence}`;
  db.prepare('INSERT INTO camps (id,slug,name,created_at) VALUES (?,?,?,?)')
    .run(campId, `submission-${sequence}`, '提交服务测试营地', now());
  db.prepare('INSERT INTO users (id,username,display_name,created_at) VALUES (?,?,?,?)')
    .run(userId, `submitter-${sequence}`, '提交者', now());
  db.prepare('INSERT INTO camp_members (camp_id,user_id,role,joined_at) VALUES (?,?,?,?)')
    .run(campId, userId, 'student', now());
  db.prepare(`INSERT INTO projects (id,camp_id,owner_user_id,slug,title,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(projectId, campId, userId, `work-${sequence}`, '测试作品', now(), now());
  const token = issueToken({ kind: 'skill', userId, campId, projectId, role: 'student' });
  const auth = resolveToken(token);
  const enqueued = [];
  const diagnosisQueue = {
    enqueue(task) {
      enqueued.push(task);
      return { queued: true, diagnosisId: `d_queued_${sequence}_${enqueued.length}` };
    },
  };
  return { campId, userId, projectId, auth, diagnosisQueue, enqueued, token };
}

function htmlSource(content = '<main>这是一个内容完整、可以提交和预览的网页作品。</main>') {
  const root = mkdtempSync(join(tmpdir(), 'vh-submission-source-'));
  const source = join(root, '作品.html');
  writeFileSync(source, content);
  return { root, source };
}

function addStoredVersion(f, { seq, previewId }) {
  const versionId = `v_stored_${sequence}_${seq}`;
  const dir = join(paths.versions, versionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), `<main>stored ${seq}</main>`);
  db.prepare(`INSERT INTO versions
    (id,project_id,label,seq,bundle_sha,bundle_size,file_count,preview_id,submitted_by,submitted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(versionId, f.projectId, `v${seq}`, seq, `sha-stored-${sequence}-${seq}`, 32, 1, previewId, f.userId, now());
  makePreview({ previewId, versionId });
  return { versionId, dir, previewPath: join(paths.previews, previewId) };
}

function multipartUploads(files) {
  const boundary = `----vibehub-submission-${Date.now()}-${sequence}`;
  const chunks = [];
  for (const [filename, content] of files) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="${filename}"\r\nContent-Type: text/html\r\n\r\n`),
      Buffer.from(content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, payload: Buffer.concat(chunks) };
}

async function submit(f, overrides = {}) {
  const upload = htmlSource(overrides.content);
  const result = await submitVersion({
    projectId: f.projectId,
    userId: f.userId,
    auth: f.auth,
    source: upload.source,
    filename: overrides.filename || '作品.html',
    meta: overrides.meta || {},
    submittedVia: overrides.submittedVia || 'skill',
    diagnosisQueue: f.diagnosisQueue,
  });
  return { result, upload };
}

beforeEach(clearDatabase);
after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交元数据规范化缺省值并修剪玩法两端空白', () => {
  assert.deepEqual(validateSubmissionMeta(), { summary: '', flows: [] });
  assert.deepEqual(
    validateSubmissionMeta({ summary: ' 新关卡 ', flows: ['  开始游戏  ', '   '], label: ' v2.0.0 ' }),
    { summary: '新关卡', flows: ['开始游戏'], label: 'v2.0.0' },
  );
});

test('提交元数据拒绝错误类型、数量和原始超长字符串', () => {
  const invalid = [
    { summary: 42 },
    { summary: 'x'.repeat(501) },
    { flows: '开始游戏' },
    { flows: Array(6).fill('play') },
    { flows: [42] },
    { flows: [` ${'x'.repeat(80)} `] },
    { label: 42 },
    { label: 'x'.repeat(81) },
  ];
  for (const meta of invalid) {
    assert.throws(
      () => validateSubmissionMeta(meta),
      (error) => error instanceof SubmissionError && error.code === 'invalid_meta' && error.status === 400 && /最多|必须/.test(error.message),
    );
  }
});

test('共享服务记录来源与规范化后的元数据并清理 source 和 staging', async () => {
  const f = fixture();
  const { result, upload } = await submit(f, {
    submittedVia: 'web',
    meta: { summary: ' 新内容 ', flows: [' 进入关卡 '], label: ' v3.0.0 ' },
  });

  const row = db.prepare('SELECT * FROM versions WHERE id=?').get(result.version_id);
  assert.equal(row.submitted_via, 'web');
  assert.equal(row.summary, '新内容');
  assert.equal(row.flows, JSON.stringify(['进入关卡']));
  assert.equal(row.label, 'v3.0.0');
  assert.equal(existsSync(upload.source), false);
  assert.equal(existsSync(join(paths.tmp, `stage_${result.version_id}`)), false);
  assert.equal(existsSync(join(paths.versions, result.version_id, 'index.html')), true);
  assert.equal(f.enqueued.length, 1);
});

test('共享服务只接受 web 或 skill 提交来源且仍清理 source', async () => {
  const f = fixture();
  const upload = htmlSource();
  await assert.rejects(
    submitVersion({
      projectId: f.projectId, userId: f.userId, auth: f.auth,
      source: upload.source, filename: '作品.html', meta: {}, submittedVia: 'api', diagnosisQueue: f.diagnosisQueue,
    }),
    (error) => error instanceof SubmissionError && error.status === 400,
  );
  assert.equal(existsSync(upload.source), false);
});

test('同步密钥扫描拒绝提交、记录诊断并删除产物和临时文件', async () => {
  const f = fixture();
  const upload = htmlSource('<main>作品</main><script>const token="sk-secret12345678"</script>');
  await assert.rejects(
    submitVersion({
      projectId: f.projectId, userId: f.userId, auth: f.auth,
      source: upload.source, filename: '作品.html', meta: {}, submittedVia: 'skill', diagnosisQueue: f.diagnosisQueue,
    }),
    (error) => error instanceof SubmissionError && error.code === 'secret_detected' && error.status === 422,
  );

  const row = db.prepare('SELECT * FROM versions WHERE project_id=?').get(f.projectId);
  assert.equal(row.artifact_pruned, 1);
  assert.equal(existsSync(join(paths.versions, row.id)), false);
  assert.equal(existsSync(join(paths.tmp, `stage_${row.id}`)), false);
  assert.equal(existsSync(upload.source), false);
  assert.equal(db.prepare('SELECT status FROM diagnoses WHERE version_id=?').get(row.id).status, 'blocked');
  assert.equal(db.prepare('SELECT pending_version_id FROM projects WHERE id=?').get(f.projectId).pending_version_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE version_id=?').get(row.id).n, 0);
});

test('含密钥的新提交不会撤销或清理此前仍有效的待审版本', async () => {
  const f = fixture();
  const first = await submit(f);
  const oldVersionId = first.result.version_id;
  const oldReviewId = `r_old_pending_${sequence}`;
  db.prepare('INSERT INTO reviews (id,version_id,project_id,camp_id,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(oldReviewId, oldVersionId, f.projectId, f.campId, 'pending', now());
  const upload = htmlSource('<main>作品</main><script>const token="sk-secret12345678"</script>');

  await assert.rejects(
    submitVersion({
      projectId: f.projectId, userId: f.userId, auth: f.auth,
      source: upload.source, filename: '作品.html', meta: {}, submittedVia: 'skill', diagnosisQueue: f.diagnosisQueue,
    }),
    (error) => error instanceof SubmissionError && error.code === 'secret_detected',
  );

  assert.equal(db.prepare('SELECT pending_version_id FROM projects WHERE id=?').get(f.projectId).pending_version_id, oldVersionId);
  assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(oldReviewId).status, 'pending');
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(oldVersionId).artifact_pruned, 0);
  assert.equal(existsSync(join(paths.versions, oldVersionId, 'index.html')), true);
});

test('诊断入队失败会恢复旧 pending 并清除新版本的数据库和文件状态', async () => {
  const f = fixture();
  const first = await submit(f);
  const oldVersionId = first.result.version_id;
  const oldReviewId = `r_queue_pending_${sequence}`;
  db.prepare('INSERT INTO reviews (id,version_id,project_id,camp_id,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(oldReviewId, oldVersionId, f.projectId, f.campId, 'pending', now());
  const upload = htmlSource('<main>这是第二份不同的完整作品，诊断队列将模拟故障。</main>');
  const failingQueue = { enqueue() { throw new Error('queue unavailable'); } };

  await assert.rejects(
    submitVersion({
      projectId: f.projectId, userId: f.userId, auth: f.auth,
      source: upload.source, filename: '作品.html', meta: {}, submittedVia: 'skill', diagnosisQueue: failingQueue,
    }),
    (error) => error instanceof SubmissionError && error.status === 500,
  );

  assert.equal(db.prepare('SELECT pending_version_id FROM projects WHERE id=?').get(f.projectId).pending_version_id, oldVersionId);
  assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(oldReviewId).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id=?').get(f.projectId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE version_id!=?').get(oldVersionId).n, 0);
  assert.deepEqual(readdirSync(paths.versions), [oldVersionId]);
  assert.equal(existsSync(upload.source), false);
});

test('产物清理 COMMIT 部分失败不影响提交，失败项恢复且后续项继续清理', async () => {
  const f = fixture();
  const first = await submit(f);
  const oldVersionId = first.result.version_id;
  db.prepare('INSERT INTO reviews (id,version_id,project_id,camp_id,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(`r_prune_pending_${sequence}`, oldVersionId, f.projectId, f.campId, 'pending', now());
  db.prepare("UPDATE projects SET live_version_id=?,publish_status='published' WHERE id=?").run(oldVersionId, f.projectId);
  // 项目索引按 seq DESC 扫描：先让 21 失败，再验证 20 仍会继续清理。
  const later = addStoredVersion(f, { seq: 20, previewId: `s${String(sequence).padStart(15, '0')}` });
  const failed = addStoredVersion(f, { seq: 21, previewId: `f${String(sequence).padStart(15, '0')}` });
  const upload = htmlSource('<main>这是最终清理故障时仍应保持可诊断的新版本。</main>');
  const warnings = [];
  const queue = {
    log: { warn(detail, message) { warnings.push({ detail, message }); } },
    enqueue: f.diagnosisQueue.enqueue,
  };
  const originalExec = db.exec.bind(db);
  let commitFailed = false;
  db.exec = (sql) => {
    if (!commitFailed && String(sql).trim().toUpperCase() === 'COMMIT') {
      commitFailed = true;
      throw new Error('forced first prune commit failure');
    }
    return originalExec(sql);
  };

  let result;
  try {
    result = await submitVersion({
      projectId: f.projectId, userId: f.userId, auth: f.auth,
      source: upload.source, filename: '作品.html', meta: {}, submittedVia: 'skill', diagnosisQueue: queue,
    });
  } finally {
    db.exec = originalExec;
  }

  assert.equal(commitFailed, true);
  assert.equal(db.prepare('SELECT pending_version_id FROM projects WHERE id=?').get(f.projectId).pending_version_id, result.version_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE id=?').get(result.version_id).n, 1);
  assert.equal(existsSync(join(paths.versions, result.version_id, 'index.html')), true);
  assert.equal(f.enqueued.at(-1).versionId, result.version_id);
  assert.deepEqual(warnings[0]?.detail?.failures?.map((item) => item.version_id), [failed.versionId]);
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(failed.versionId).artifact_pruned, 0);
  assert.equal(existsSync(failed.dir), true);
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(later.versionId).artifact_pruned, 1);
  assert.equal(existsSync(later.dir), false);
  assert.equal(warnings.length, 1);
  assert.equal(existsSync(upload.source), false);
});

test('数据库清理标记失败时不先删除版本目录，并继续清理后续版本', () => {
  const f = fixture();
  const failed = addStoredVersion(f, { seq: 30, previewId: `d${String(sequence).padStart(15, '0')}` });
  const later = addStoredVersion(f, { seq: 31, previewId: `t${String(sequence).padStart(15, '0')}` });
  db.exec(`CREATE TRIGGER fail_one_prune BEFORE UPDATE OF artifact_pruned ON versions
           WHEN OLD.id='${failed.versionId}' AND NEW.artifact_pruned=1
           BEGIN SELECT RAISE(ABORT, 'forced marker failure'); END`);

  let cleanup;
  try {
    cleanup = pruneProjectArtifacts(f.projectId);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_one_prune');
  }

  assert.equal(cleanup.pruned, 1);
  assert.deepEqual(cleanup.failures.map((item) => item.version_id), [failed.versionId]);
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(failed.versionId).artifact_pruned, 0);
  assert.equal(existsSync(failed.dir), true);
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(later.versionId).artifact_pruned, 1);
  assert.equal(existsSync(later.dir), false);
});

test('版本目录和预览链接处理后 COMMIT 失败会完整恢复产物与数据库标记', () => {
  const f = fixture();
  const failed = addStoredVersion(f, { seq: 40, previewId: `c${String(sequence).padStart(15, '0')}` });
  const originalExec = db.exec.bind(db);
  let commitFailed = false;
  db.exec = (sql) => {
    if (!commitFailed && String(sql).trim().toUpperCase() === 'COMMIT') {
      commitFailed = true;
      throw new Error('forced commit failure after quarantine');
    }
    return originalExec(sql);
  };

  let cleanup;
  try {
    cleanup = pruneProjectArtifacts(f.projectId);
  } finally {
    db.exec = originalExec;
  }

  assert.equal(commitFailed, true);
  assert.deepEqual(cleanup.failures.map((item) => item.version_id), [failed.versionId]);
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(failed.versionId).artifact_pruned, 0);
  assert.equal(existsSync(join(failed.dir, 'index.html')), true);
  assert.equal(existsSync(failed.previewPath), true);
  assert.equal(lstatSync(failed.previewPath).isSymbolicLink(), true);
});

test('COMMIT 回滚后恢复 rename 失败会保留唯一产物隔离区且不被 tmp 清理', () => {
  const f = fixture();
  const failed = addStoredVersion(f, { seq: 41, previewId: `x${String(sequence).padStart(15, '0')}` });
  const originalExec = db.exec.bind(db);
  let commitFailed = false;
  db.exec = (sql) => {
    if (!commitFailed && String(sql).trim().toUpperCase() === 'COMMIT') {
      commitFailed = true;
      // 原路径冲突模拟 rollback 后版本目录无法 rename 回原位。
      mkdirSync(failed.dir, { recursive: true });
      writeFileSync(join(failed.dir, 'conflict.txt'), 'occupied');
      throw new Error('forced commit and recovery failure');
    }
    return originalExec(sql);
  };

  let cleanup;
  try {
    cleanup = pruneProjectArtifacts(f.projectId);
  } finally {
    db.exec = originalExec;
  }

  const recoveryDirs = readdirSync(paths.tmp).filter((entry) => entry.startsWith('prune_recovery_'));
  assert.equal(commitFailed, true);
  assert.equal(cleanup.failures[0].recovery_errors.length, 1);
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(failed.versionId).artifact_pruned, 0);
  assert.equal(recoveryDirs.length, 1);
  assert.equal(existsSync(join(paths.tmp, recoveryDirs[0], 'version', 'index.html')), true);
  cleanupTmp(0);
  assert.equal(existsSync(join(paths.tmp, recoveryDirs[0], 'version', 'index.html')), true);
});

test('COMMIT 成功后的隔离区删除失败会留下可由 tmp 清理收敛的 delete 标记', () => {
  const f = fixture();
  const obsolete = addStoredVersion(f, { seq: 42, previewId: `d${String(sequence).padStart(15, '0')}` });
  let removeAttempted = false;

  const cleanup = pruneProjectArtifacts(f.projectId, {
    removeQuarantine() {
      removeAttempted = true;
      throw new Error('forced committed quarantine removal failure');
    },
  });

  const deleteDirs = readdirSync(paths.tmp).filter((entry) => entry.startsWith('prune_delete_'));
  assert.equal(removeAttempted, true);
  assert.deepEqual(cleanup, { pruned: 1, failures: [] });
  assert.equal(db.prepare('SELECT artifact_pruned FROM versions WHERE id=?').get(obsolete.versionId).artifact_pruned, 1);
  assert.equal(existsSync(obsolete.dir), false);
  assert.equal(existsSync(obsolete.previewPath), false);
  assert.equal(deleteDirs.length, 1);

  const deletePath = join(paths.tmp, deleteDirs[0]);
  utimesSync(deletePath, new Date(0), new Date(0));
  cleanupTmp(0);
  assert.equal(existsSync(deletePath), false);
});

test('tmp 清理保留恢复隔离区但回收已提交的 work 和 delete 隔离区', () => {
  const recovery = join(paths.tmp, 'prune_recovery_keep');
  const work = join(paths.tmp, 'prune_work_old');
  const deletion = join(paths.tmp, 'prune_delete_old');
  for (const path of [recovery, work, deletion]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'artifact.txt'), 'data');
    utimesSync(path, new Date(0), new Date(0));
  }

  cleanupTmp(0);

  assert.equal(existsSync(recovery), true);
  assert.equal(existsSync(work), false);
  assert.equal(existsSync(deletion), false);
});

test('预览授权失败会在诊断入队前回滚新版本', async () => {
  const f = fixture();
  const upload = htmlSource();
  const wrongAuth = { ...f.auth, project_id: 'p_other_project' };

  await assert.rejects(
    submitVersion({
      projectId: f.projectId, userId: f.userId, auth: wrongAuth,
      source: upload.source, filename: '作品.html', meta: {}, submittedVia: 'skill', diagnosisQueue: f.diagnosisQueue,
    }),
    (error) => error instanceof SubmissionError && error.code === 'preview_unavailable' && error.status === 500,
  );

  assert.equal(f.enqueued.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id=?').get(f.projectId).n, 0);
  assert.deepEqual(readdirSync(paths.versions), []);
  assert.equal(existsSync(upload.source), false);
});

test('相同 SHA 只有当前完整 pending 或 live 版本才算重复', async () => {
  const f = fixture();
  const first = await submit(f);
  const row = db.prepare('SELECT * FROM versions WHERE id=?').get(first.result.version_id);
  assert.equal(findActiveDuplicateVersion(f.projectId, row.bundle_sha)?.id, row.id);

  const duplicateSource = htmlSource();
  await assert.rejects(
    submitVersion({
      projectId: f.projectId, userId: f.userId, auth: f.auth,
      source: duplicateSource.source, filename: '作品.html', meta: {}, submittedVia: 'skill', diagnosisQueue: f.diagnosisQueue,
    }),
    (error) => error instanceof SubmissionError && error.code === 'duplicate_version' && error.status === 409,
  );
  assert.equal(existsSync(duplicateSource.source), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id=?').get(f.projectId).n, 1);

  db.prepare('UPDATE projects SET pending_version_id=NULL WHERE id=?').run(f.projectId);
  db.prepare('INSERT INTO reviews (id,version_id,project_id,camp_id,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(`r_rejected_${sequence}`, row.id, f.projectId, f.campId, 'rejected', now());
  pruneProjectArtifacts(f.projectId);
  assert.equal(findActiveDuplicateVersion(f.projectId, row.bundle_sha), null);

  const second = await submit(f);
  assert.equal(second.result.seq, 2);
  assert.notEqual(second.result.version_id, row.id);

  const secondRow = db.prepare('SELECT * FROM versions WHERE id=?').get(second.result.version_id);
  db.prepare('UPDATE projects SET pending_version_id=NULL WHERE id=?').run(f.projectId);
  db.prepare('INSERT INTO reviews (id,version_id,project_id,camp_id,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(`r_superseded_${sequence}`, secondRow.id, f.projectId, f.campId, 'superseded', now());
  assert.equal(findActiveDuplicateVersion(f.projectId, secondRow.bundle_sha), null);
  const third = await submit(f);
  assert.equal(third.result.seq, 3);
});

test('同一项目并发提交只允许一条流水线落库并清理两份 source', async () => {
  const f = fixture();
  const first = htmlSource();
  const second = htmlSource();
  const request = (source) => submitVersion({
    projectId: f.projectId,
    userId: f.userId,
    auth: f.auth,
    source,
    filename: '作品.html',
    meta: {},
    submittedVia: 'skill',
    diagnosisQueue: f.diagnosisQueue,
  });

  const settled = await Promise.allSettled([request(first.source), request(second.source)]);

  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = settled.find((item) => item.status === 'rejected');
  assert.ok(rejected.reason instanceof SubmissionError);
  assert.equal(rejected.reason.code, 'submission_in_progress');
  assert.equal(rejected.reason.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id=?').get(f.projectId).n, 1);
  assert.equal(existsSync(first.source), false);
  assert.equal(existsSync(second.source), false);
});

test('preflight 不让历史记录挡提交，但识别当前完整版本', async () => {
  const f = fixture();
  const { result } = await submit(f);
  const row = db.prepare('SELECT bundle_sha FROM versions WHERE id=?').get(result.version_id);
  const headers = { authorization: `Bearer ${f.token}` };

  const active = await app.inject({ method: 'POST', url: '/api/skill/versions/preflight', headers, payload: { sha256: row.bundle_sha } });
  assert.equal(active.statusCode, 200);
  assert.equal(active.json().duplicate, true);
  assert.equal(active.json().version_id, result.version_id);

  db.prepare('UPDATE projects SET pending_version_id=NULL WHERE id=?').run(f.projectId);
  pruneProjectArtifacts(f.projectId);
  const historical = await app.inject({ method: 'POST', url: '/api/skill/versions/preflight', headers, payload: { sha256: row.bundle_sha } });
  assert.equal(historical.statusCode, 200);
  assert.equal(historical.json().duplicate, false);
});

test('Skill 多 bundle 请求失败后不会在 tmp 留下先前上传文件', async () => {
  const f = fixture();
  const form = multipartUploads([
    ['first.html', '<main>first</main>'],
    ['second.html', '<main>second</main>'],
  ]);
  const response = await app.inject({
    method: 'POST',
    url: '/api/skill/versions',
    headers: {
      authorization: `Bearer ${f.token}`,
      'content-type': `multipart/form-data; boundary=${form.boundary}`,
    },
    payload: form.payload,
  });

  assert.ok(response.statusCode >= 400);
  assert.deepEqual(readdirSync(paths.tmp), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id=?').get(f.projectId).n, 0);
});
