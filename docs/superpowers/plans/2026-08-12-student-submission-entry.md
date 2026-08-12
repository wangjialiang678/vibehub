# Student Submission Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every invited student a visible submission action, supporting direct HTML/ZIP/folder/tar.gz uploads and an independent npm-installed AI deployment path that does not depend on SkillHub.

**Architecture:** Both browser and Skill submissions call one server-side version creation service. Input adapters normalize HTML, ZIP, and tar.gz into a checked staging directory; the shared service owns validation, secret scanning, preview creation, diagnosis, review state, quota enforcement, and audit fields. The React app adds one `/app/submit` page reused by dashboard, sidebar, and version-history calls to action; npm remains the public Skill distribution channel and SkillHub is optional mirroring only.

**Tech Stack:** Node.js 22, Fastify 5, SQLite, `tar`, `yauzl`, React 18, TypeScript, Vite, TanStack Query, `fflate`, Node test runner, Vitest.

---

## File map

- Create `server/src/services/archive-input.js`: identify HTML/ZIP/tar.gz and normalize untrusted uploads into a staging directory.
- Modify `server/src/services/unpack.js`: share archive-entry checks between tar and ZIP; reject every dangerous path instead of silently skipping it.
- Create `server/src/services/version-submission.js`: field validation, rate/concurrency checks, immutable version creation, preview, diagnosis, and response contract.
- Modify `server/src/routes/skill.js`: keep bind/status/preflight and delegate Skill uploads to the shared service.
- Create `server/src/routes/submissions.js`: cookie-authenticated project-scoped browser upload route.
- Modify `server/src/index.js`: register the browser submission route.
- Create `server/test/archive-input.test.js`: HTML and ZIP normalization plus archive safety tests.
- Create `server/test/submission-routes.test.js`: browser/Skill parity, authorization, validation, rate, and concurrency tests.
- Create `web/src/lib/submissionFiles.ts`: prepare single HTML, ZIP/tar.gz, and folder inputs; ZIP folders with `fflate`.
- Modify `web/src/lib/api.ts`: multipart upload with progress/error support.
- Create `web/src/pages/StudentSubmitPage.tsx`: web-upload and AI-assisted panels.
- Create `web/src/student-submit.test.ts`: route, formats, prompt, SkillHub independence, and CTA coverage.
- Modify `web/src/App.tsx`, `web/src/components/Shell.tsx`, `web/src/pages/StudentPage.tsx`, `web/src/pages/StudentVersionsPage.tsx`, and `web/src/styles.css`: make submission discoverable and responsive.
- Modify `web/src/pages/AdminInvitesPage.tsx`: copy complete per-code student instructions.
- Modify `skill/SKILL.md`, `skill/AGENTS.md`, `README.md`, `docs/guide/index.html`, `docs/handbook/deployment.md`, and `docs/specs/architecture.md`: keep public npm as the only required distribution path.

### Task 1: Normalize HTML, ZIP, and tar.gz safely

**Files:**
- Create: `server/src/services/archive-input.js`
- Modify: `server/src/services/unpack.js`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`
- Test: `server/test/archive-input.test.js`
- Test: `server/test/unpack.test.js`

- [ ] **Step 1: Write failing format and security tests**

Add tests that exercise the public adapter rather than ZIP internals:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { normalizeUpload, UploadFormatError } from '../src/services/archive-input.js';

test('单个 HTML 被规范化为根目录 index.html', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vh-html-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'game.html');
  const staging = join(root, 'stage');
  writeFileSync(source, '<main>game</main>');
  const result = await normalizeUpload({ source, filename: 'game.html', staging });
  assert.equal(result.format, 'html');
  assert.equal(readFileSync(join(staging, 'index.html'), 'utf8'), '<main>game</main>');
});

test('ZIP 解出网页但拒绝目录穿越', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vh-zip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const safe = join(root, 'safe.zip');
  writeFileSync(safe, zipSync({ 'index.html': strToU8('<main>zip</main>') }));
  await normalizeUpload({ source: safe, filename: 'safe.zip', staging: join(root, 'safe') });
  assert.ok(existsSync(join(root, 'safe', 'index.html')));

  const bad = join(root, 'bad.zip');
  writeFileSync(bad, zipSync({ '../escape.html': strToU8('bad') }));
  await assert.rejects(
    normalizeUpload({ source: bad, filename: 'bad.zip', staging: join(root, 'bad') }),
    (error) => error instanceof UploadFormatError && error.code === 'bundle_invalid',
  );
});
```

Also extend `server/test/unpack.test.js` with a handcrafted tar entry containing `../escape.html` and assert the whole archive rejects with `bundle_invalid`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd server
node --test test/archive-input.test.js test/unpack.test.js
```

Expected: FAIL because `archive-input.js` and `normalizeUpload` do not exist and tar traversal is not rejected as a whole.

- [ ] **Step 3: Install the two focused archive dependencies**

Run:

```bash
cd server
npm install yauzl
npm install --save-dev fflate
```

Expected: `package.json` and `package-lock.json` add `yauzl`; test-only ZIP generation adds `fflate` under dev dependencies.

- [ ] **Step 4: Implement the format adapter and shared entry policy**

Create `archive-input.js` with this public contract:

```js
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { safeExtract, safeExtractZip } from './unpack.js';

export class UploadFormatError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}

export async function normalizeUpload({ source, filename, staging }) {
  const lower = String(filename || '').toLowerCase();
  const head = readFileSync(source).subarray(0, 4);
  mkdirSync(staging, { recursive: true });
  if (extname(lower) === '.html' || extname(lower) === '.htm') {
    copyFileSync(source, join(staging, 'index.html'));
    return { format: 'html', totalBytes: readFileSync(source).byteLength, fileCount: 1, rejected: [] };
  }
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const result = await safeExtractZip(source, staging);
    return { format: 'zip', ...result };
  }
  if (head[0] === 0x1f && head[1] === 0x8b && (lower.endsWith('.tar.gz') || lower.endsWith('.tgz'))) {
    const result = await safeExtract(source, staging);
    return { format: 'tar.gz', ...result };
  }
  throw new UploadFormatError('unsupported_format', '请选择 HTML、ZIP、文件夹或 tar.gz 网页作品。', 'React/Vite 项目请先构建，或改用 AI 帮你提交');
}
```

In `unpack.js`, export one `checkArchiveEntry({ path, type, size, mode, counters })` policy used by both tar and `yauzl.open(..., { lazyEntries: true })`. Reject absolute paths, `..` path components, symlinks, device entries, executable files, sensitive paths, and limit violations by throwing `UnpackError`; skip only macOS metadata and `node_modules`. ZIP extraction must call `openReadStream`, create parent directories, stream to disk, and call `zipfile.readEntry()` only after the stream closes.

- [ ] **Step 5: Run archive tests and verify GREEN**

Run:

```bash
cd server
node --test test/archive-input.test.js test/unpack.test.js
```

Expected: all archive tests PASS and no file is created outside the staging directory.

- [ ] **Step 6: Commit the archive boundary**

```bash
git add server/package.json server/package-lock.json server/src/services/archive-input.js server/src/services/unpack.js server/test/archive-input.test.js server/test/unpack.test.js
git commit -m "feat: accept safe browser upload formats"
```

### Task 2: Extract one shared version-submission service

**Files:**
- Create: `server/src/services/version-submission.js`
- Modify: `server/src/routes/skill.js`
- Test: `server/test/submission-service.test.js`
- Test: `server/test/security-regression.test.js`

- [ ] **Step 1: Write failing service tests**

Cover field validation, source recording, secret rejection, and duplicate semantics:

```js
test('提交元数据只接受有限字符串与玩法数组', () => {
  assert.deepEqual(validateSubmissionMeta({ summary: '新关卡', flows: ['开始游戏'] }), { summary: '新关卡', flows: ['开始游戏'] });
  assert.throws(() => validateSubmissionMeta({ summary: 'x'.repeat(501), flows: [] }), /500/);
  assert.throws(() => validateSubmissionMeta({ summary: '', flows: Array(6).fill('play') }), /5/);
  assert.throws(() => validateSubmissionMeta({ summary: '', flows: [42] }), /字符串/);
});

test('共享服务记录真实提交来源', async () => {
  const result = await submitVersion(fixture({ submittedVia: 'web' }));
  const row = db.prepare('SELECT submitted_via FROM versions WHERE id=?').get(result.version_id);
  assert.equal(row.submitted_via, 'web');
});
```

Add a regression assertion that a rejected or pruned earlier SHA does not prevent a new review submission, while an intact current pending version with identical SHA returns the existing version response.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd server
node --test test/submission-service.test.js test/security-regression.test.js
```

Expected: FAIL because `submitVersion` and `validateSubmissionMeta` are missing.

- [ ] **Step 3: Implement the shared service**

Export `validateSubmissionMeta` exactly as below:

```js
export function validateSubmissionMeta(input = {}) {
  const summary = input.summary == null ? '' : input.summary;
  const flows = input.flows == null ? [] : input.flows;
  if (typeof summary !== 'string' || summary.length > 500) throw new SubmissionError('invalid_meta', '更新说明最多 500 字。', 400);
  if (!Array.isArray(flows) || flows.length > 5 || flows.some((item) => typeof item !== 'string' || item.length > 80)) {
    throw new SubmissionError('invalid_meta', '核心玩法最多 5 条，每条最多 80 字符串。', 400);
  }
  return { summary: summary.trim(), flows: flows.map((item) => item.trim()).filter(Boolean) };
}
```

Also export `submitVersion({ projectId, userId, auth, source, filename, meta, submittedVia, diagnosisQueue })`. Move the existing version-creation statements from `server/src/routes/skill.js` beginning at `const projectId = req.auth.project_id` and ending at its `finally` block into this function, then make these exact substitutions:

- replace `req.auth.project_id` with `projectId`, `req.auth.user_id` with `userId`, and `req.auth` with `auth`;
- replace multipart parsing and `tmpFile` creation with the supplied `source` and `filename`;
- call `validateSubmissionMeta(meta)` before normalizing the upload;
- replace `safeExtract(tmpFile, staging)` with `normalizeUpload({ source, filename, staging })`;
- write `submittedVia` into `versions.submitted_via` instead of the literal `'skill'`;
- turn every `return err(reply, code, status, message, hint)` into `throw new SubmissionError(code, message, status, hint)`;
- return the same object currently passed to `reply.code(201).send(...)`;
- delete `source` and `staging` in `finally`, but do not delete the finalized immutable version directory;
- keep the existing order: validate → extract → require `index.html` → quota → hash/sequence → rewrite/SDK → persist → synchronous secret scan → preview → pending replacement → prune → diagnosis queue → preview grant.

`SubmissionError` carries `code`, `message`, `hint`, and HTTP `status`. The route must only receive multipart parts and translate service errors into the existing `{ error: ... }` response.

- [ ] **Step 4: Run service and existing security tests**

```bash
cd server
node --test test/submission-service.test.js test/security-regression.test.js test/skill-flow.test.js
```

Expected: PASS; existing Skill golden path remains unchanged.

- [ ] **Step 5: Commit the shared service**

```bash
git add server/src/services/version-submission.js server/src/routes/skill.js server/test/submission-service.test.js server/test/security-regression.test.js
git commit -m "refactor: share version submission pipeline"
```

### Task 3: Add the authenticated browser submission route

**Files:**
- Create: `server/src/routes/submissions.js`
- Create: `server/src/services/submission-guard.js`
- Modify: `server/src/index.js`
- Test: `server/test/submission-routes.test.js`

- [ ] **Step 1: Write failing route tests**

Create integration tests for these exact outcomes:

```js
test('学员 cookie 可向自己的项目提交 HTML 并记录 web 来源', async () => {
  const response = await app.inject({
    method: 'POST', url: `/api/projects/${project.id}/versions`,
    headers: { cookie: sessionCookie, origin: 'http://localhost:5173' },
    payload: multipartHtml('<main>web game</main>', { summary: '第一版', flows: ['开始游戏'] }),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(db.prepare('SELECT submitted_via FROM versions ORDER BY submitted_at DESC LIMIT 1').get().submitted_via, 'web');
});

test('学员不能向别人的项目提交', async () => {
  const response = await app.inject({ method: 'POST', url: `/api/projects/${other.id}/versions`, headers: studentHeaders, payload });
  assert.equal(response.statusCode, 404);
});

test('网页提交限制频率和并发', async () => {
  for (let i = 0; i < 5; i += 1) assert.equal((await submit()).statusCode, 201);
  const limited = await submit();
  assert.equal(limited.statusCode, 429);
  assert.match(limited.json().error.message, /10 分钟/);
});
```

Also test invalid Origin returns 403, missing file returns 400, invalid metadata returns 400, and teacher credentials without a project cannot upload.

- [ ] **Step 2: Run route tests and verify RED**

```bash
cd server
node --test test/submission-routes.test.js
```

Expected: FAIL with route not found.

- [ ] **Step 3: Implement project-scoped guard and route**

`submission-guard.js` owns in-memory process-local admission:

```js
const active = new Set();
const attempts = new Map();
export function acquireSubmission(projectId, nowMs = Date.now()) {
  const recent = (attempts.get(projectId) || []).filter((at) => nowMs - at < 600_000);
  if (active.has(projectId)) return { ok: false, status: 409, message: '这个项目正在提交，请等待当前检查完成。' };
  if (recent.length >= 5) return { ok: false, status: 429, message: '10 分钟内最多提交 5 次，请稍后再试。' };
  active.add(projectId); attempts.set(projectId, [...recent, nowMs]);
  return { ok: true, release: () => active.delete(projectId) };
}
```

`submissions.js` must call `authRequired(['student'])`, load `req.params.id`, verify `assertProjectAccess` and equality with `req.auth.project_id`, enforce allowed cookie Origin through the existing global hook, stream one `bundle` part to `paths.tmp`, parse `meta`, call `submitVersion({ submittedVia: 'web' })`, and release the guard in `finally`.

- [ ] **Step 4: Register the route and verify GREEN**

Add `await app.register(submissionRoutes, { diagnosisQueue });` immediately after `skillRoutes` in `server/src/index.js`.

Run:

```bash
cd server
node --test test/submission-routes.test.js test/skill-flow.test.js
```

Expected: all tests PASS; both routes return the same response fields.

- [ ] **Step 5: Commit browser submission API**

```bash
git add server/src/routes/submissions.js server/src/services/submission-guard.js server/src/index.js server/test/submission-routes.test.js
git commit -m "feat: add browser project submission API"
```

### Task 4: Prepare browser files and upload with progress

**Files:**
- Create: `web/src/lib/submissionFiles.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Test: `web/src/lib/submissionFiles.test.ts`

- [ ] **Step 1: Write failing browser file-preparation tests**

```ts
it('keeps a single HTML and existing archive unchanged', async () => {
  const html = new File(['<main>x</main>'], 'game.html', { type: 'text/html' });
  expect((await prepareSubmissionFiles([html])).file).toBe(html);
});

it('packs folder files with relative paths into ZIP', async () => {
  const index = Object.assign(new File(['<main>x</main>'], 'index.html'), { webkitRelativePath: 'game/index.html' });
  const css = Object.assign(new File(['body{}'], 'style.css'), { webkitRelativePath: 'game/assets/style.css' });
  const prepared = await prepareSubmissionFiles([index, css]);
  expect(prepared.file.name).toBe('game.zip');
  expect(Object.keys(unzipSync(new Uint8Array(await prepared.file.arrayBuffer())))).toEqual(['game/index.html', 'game/assets/style.css']);
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
cd web
npx vitest run src/lib/submissionFiles.test.ts
```

Expected: FAIL because the module is missing.

- [ ] **Step 3: Install `fflate` and implement the helper**

```bash
cd web
npm install fflate
```

Implement:

```ts
import { zipSync } from 'fflate';

export async function prepareSubmissionFiles(files: File[]) {
  if (!files.length) throw new Error('请选择网页文件或文件夹。');
  if (files.length === 1 && !files[0].webkitRelativePath) return { file: files[0], count: 1 };
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[file.webkitRelativePath || file.name] = new Uint8Array(await file.arrayBuffer());
  const root = files[0].webkitRelativePath.split('/')[0] || 'game';
  return { file: new File([zipSync(entries, { level: 6 })], `${root}.zip`, { type: 'application/zip' }), count: files.length };
}
```

Reject client selections above 30 MB before preparing; server limits remain authoritative.

- [ ] **Step 4: Add multipart API with upload progress**

Export:

```ts
submitProjectVersion: (projectId, file, meta, onProgress) => new Promise<SubmissionResponse>((resolve, reject) => {
  const body = new FormData();
  body.append('bundle', file, file.name);
  body.append('meta', JSON.stringify(meta));
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/versions`);
  xhr.withCredentials = true;
  xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round(event.loaded / event.total * 100));
  xhr.onload = () => parseSubmissionXhr(xhr, resolve, reject);
  xhr.onerror = () => reject(new ApiError(0, '网络中断，请重新选择文件后再试。'));
  xhr.send(body);
}),
```

Do not set `Content-Type`; the browser must add the multipart boundary.

- [ ] **Step 5: Run helper/API tests and commit**

```bash
cd web
npx vitest run src/lib/submissionFiles.test.ts src/lib/presentation.test.ts
git add package.json package-lock.json src/lib/submissionFiles.ts src/lib/submissionFiles.test.ts src/lib/api.ts
git commit -m "feat: prepare browser game uploads"
```

Expected: tests PASS and TypeScript reports no errors.

### Task 5: Build the two-mode student submission page

**Files:**
- Create: `web/src/pages/StudentSubmitPage.tsx`
- Create: `web/src/components/SubmissionCta.tsx`
- Create: `web/src/student-submit.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Shell.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing UI contract tests**

```ts
it('registers one student submission route with both modes', () => {
  expect(app).toContain('path="/app/submit"');
  expect(page).toContain('网页直接提交');
  expect(page).toContain('让 AI 帮我提交');
  expect(page).toContain('HTML');
  expect(page).toContain('ZIP');
  expect(page).toContain('选择文件夹');
  expect(page).toContain('to="/install"');
});

it('does not make SkillHub part of student installation', () => {
  expect(page).not.toMatch(/SkillHub|HUB_TOKEN|skillhub\.supermind/);
  expect(installPage).toContain('VITE_SKILL_INSTALL_COMMAND');
});
```

- [ ] **Step 2: Run the UI test and verify RED**

```bash
cd web
npx vitest run src/student-submit.test.ts
```

Expected: FAIL because route and page are absent.

- [ ] **Step 3: Implement the page state machine**

`StudentSubmitPage` must use these explicit states:

```ts
type SubmitStage = 'idle' | 'preparing' | 'uploading' | 'checking' | 'success';
type SubmitMode = 'web' | 'ai';
```

The web panel has separate file and folder inputs, optional summary, comma/newline-separated flows, progress, and a single enabled submit button. On success invalidate `['project', projectId]` and `['versions', projectId]`, show the returned preview action, and explain that diagnosis precedes teacher review. The AI panel links to `/install` and copies exactly `使用邀请码加入 VibeHub，然后部署我的游戏。` without embedding the current cookie or invite.

- [ ] **Step 4: Register navigation and responsive styles**

Add `/app/submit` to `App.tsx`. Add sidebar item `{ label: '提交作品', to: '/app/submit', icon: 'upload' }` and implement an upload arrow SVG. Style the mode tabs, drop/select area, progress bar, limits note, and success card using existing CSS variables; at `max-width: 720px`, stack the two panels and make actions full width.

- [ ] **Step 5: Run tests, typecheck, and commit**

```bash
cd web
npx vitest run src/student-submit.test.ts
npx tsc -b
git add src/pages/StudentSubmitPage.tsx src/components/SubmissionCta.tsx src/student-submit.test.ts src/App.tsx src/components/Shell.tsx src/styles.css
git commit -m "feat: add student submission page"
```

Expected: UI contract tests and TypeScript PASS.

### Task 6: Make submission discoverable and improve teacher handoff

**Files:**
- Modify: `web/src/pages/StudentPage.tsx`
- Modify: `web/src/pages/StudentVersionsPage.tsx`
- Modify: `web/src/pages/AdminInvitesPage.tsx`
- Test: `web/src/student-submit.test.ts`
- Test: `web/src/teacher-features.test.ts`

- [ ] **Step 1: Extend failing CTA and handoff tests**

Assert dashboard and version page both link to `/app/submit`, no longer render disabled “继续开发”, and teacher instructions include both methods:

```ts
expect(studentPage).toContain('提交我的游戏');
expect(studentPage).toContain('to="/app/submit"');
expect(studentPage).not.toContain('button is-disabled">⌘　继续开发');
expect(versionsPage).toContain('开始第一次提交');
expect(invitesPage).toContain('复制发给学员的说明');
expect(invitesPage).toContain('网页直接提交');
expect(invitesPage).toContain('让 AI 帮我提交');
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd web
npx vitest run src/student-submit.test.ts src/teacher-features.test.ts
```

Expected: FAIL on missing CTA and teacher-copy text.

- [ ] **Step 3: Add state-aware calls to action**

Use `SubmissionCta` in the dashboard heading and version-history heading/empty state. Its label mapping is:

```ts
if (reviewStatus === 'rejected') return '修改并重新提交';
if (pending) return '提交新版本';
if (live) return '提交下一版本';
return '提交我的游戏';
```

Rename the existing preview action to “打开预览”; do not render an inert button when no preview exists.

- [ ] **Step 4: Add complete teacher copy per revealed code**

Generate one block per code so codes cannot be accidentally shared:

```ts
export function studentInviteMessage(campName: string, code: string) {
  return `欢迎加入《${campName}》！\n\n你的个人邀请码：${code}\n请不要和其他同学互换。\n\n1. 打开 https://hub.supermind-ai.cn/login 并输入邀请码\n2. 进入后点击“提交我的游戏”\n3. 已有 HTML、ZIP 或文件夹：选“网页直接提交”\n4. 使用 Codex、Claude Code 或 WorkBuddy：选“让 AI 帮我提交”，安装不需要 SkillHub\n\n提交后先生成私有预览，老师审核通过后才会正式上线。`;
}
```

“复制发给学员的说明” copies all per-code blocks separated by `\n\n────────\n\n`; only show it while plaintext codes remain in component state.

- [ ] **Step 5: Run tests and commit**

```bash
cd web
npx vitest run src/student-submit.test.ts src/teacher-features.test.ts
git add src/pages/StudentPage.tsx src/pages/StudentVersionsPage.tsx src/pages/AdminInvitesPage.tsx src/student-submit.test.ts src/teacher-features.test.ts
git commit -m "feat: surface submission throughout student flow"
```

Expected: tests PASS and teacher copy never uses masked historical codes.

### Task 7: Lock independent Skill installation and update documentation

**Files:**
- Modify: `server/test/skill-installer.test.js`
- Modify: `web/src/install-page.test.ts`
- Modify: `skill/SKILL.md`
- Modify: `skill/AGENTS.md`
- Modify: `README.md`
- Modify: `docs/guide/index.html`
- Modify: `docs/handbook/deployment.md`
- Modify: `docs/specs/architecture.md`

- [ ] **Step 1: Add independence regression assertions**

```js
test('学生安装包和运行时不依赖 SkillHub', () => {
  const installer = readFileSync(resolve('../skill/bin/install.mjs'), 'utf8');
  const cli = readFileSync(resolve('../skill/bin/vibehub'), 'utf8');
  assert.doesNotMatch(installer + cli, /HUB_TOKEN|HUB_WRITE_TOKEN|skillhub\.supermind-ai\.cn/);
  assert.match(cli, /https:\/\/hub\.supermind-ai\.cn/);
});
```

Front-end source test must assert the install page only reads `VITE_SKILL_INSTALL_COMMAND` and no student-facing file contains SkillHub credentials or install URLs.

- [ ] **Step 2: Run tests and verify their current result**

```bash
cd server && node --test test/skill-installer.test.js
cd ../web && npx vitest run src/install-page.test.ts src/student-submit.test.ts
```

Expected: independence tests PASS; any documentation-source assertion that still presents SkillHub as required must FAIL.

- [ ] **Step 3: Align Skill and docs**

Document this exact channel contract:

```text
学生主渠道：VibeHub /install → public npm package → local Agent skill directories.
运行时：local Skill/CLI → https://hub.supermind-ai.cn.
可选内部镜像：SuperMind SkillHub；失败不阻塞发布，不出现在学生步骤中。
```

Keep macOS and Windows on the same npm command. Keep `VITE_SKILL_INSTALL_COMMAND` unset until the package is publicly downloadable.

- [ ] **Step 4: Run Skill and documentation checks and commit**

```bash
python3 /Users/michael/.codex/skills/.system/skill-creator/scripts/quick_validate.py skill
cd server && node --test test/skill-installer.test.js test/skill-runtime.test.js
cd ../web && npx vitest run src/install-page.test.ts src/student-submit.test.ts
cd .. && git diff --check
git add skill README.md docs server/test/skill-installer.test.js web/src/install-page.test.ts
git commit -m "docs: make public npm the student skill channel"
```

Expected: Skill valid and all focused tests PASS.

### Task 8: Full verification, review, and release

**Files:**
- Modify only if verification exposes a defect.
- Delete authorized generated files: `web/pnpm-lock.yaml`, `web/pnpm-workspace.yaml`.
- Verify: all files changed by Tasks 1–7.

- [ ] **Step 1: Remove the two test-tool artifacts previously authorized by the user**

```bash
rm web/pnpm-lock.yaml web/pnpm-workspace.yaml
git status --short
```

Expected: neither file appears in the worktree; `web/package-lock.json` remains.

- [ ] **Step 2: Run all local verification**

```bash
cd server && npm test
cd ../web && npm test -- --run && npm run build
cd ..
python3 /Users/michael/.codex/skills/.system/skill-creator/scripts/quick_validate.py skill
git diff --check
```

Expected: all server tests PASS, all Vitest tests PASS, Vite production build succeeds, Skill is valid, and diff check is clean.

- [ ] **Step 3: Inspect the exact public npm artifact**

```bash
pkg_dir="$(mktemp -d)"
cd skill
npm pack --pack-destination "$pkg_dir"
tar -tzf "$pkg_dir"/*.tgz | sort
```

Expected artifact entries only:

```text
package/AGENTS.md
package/SKILL.md
package/agents/openai.yaml
package/bin/install.mjs
package/bin/vibehub
package/lib/platform.mjs
package/package.json
```

- [ ] **Step 4: Request independent code review and fix every high/medium finding**

Review archive traversal, multipart limits, cross-project auth, cookie Origin, preview claim leakage, submission concurrency/rate, SkillHub independence, Windows commands, and npm contents. Re-run the focused test for every fix, then the full suite.

- [ ] **Step 5: Commit the verified implementation**

```bash
git add -A
git commit -m "feat: add student web and AI submission paths"
```

Expected: clean status and a commit that contains implementation, tests, and synchronized docs.

- [ ] **Step 6: Publish the npm package after authentication**

First verify identity without exposing tokens:

```bash
npm whoami --registry=https://registry.npmjs.org/
```

If unauthenticated, stop and ask Michael to complete `npm login` or provide a publish token through the API vault. Once authenticated:

```bash
cd skill
npm publish --access public --registry=https://registry.npmjs.org/
npm view @supermind/vibehub-skill@1.0.0 version --registry=https://registry.npmjs.org/
```

Expected: view returns `1.0.0`. From a clean temporary home, run the public `npx` installer and verify all selected Agent directories contain `SKILL.md` and `bin/vibehub`.

- [ ] **Step 7: Optionally mirror the same version to SkillHub**

Load only `HUB_URL`, `HUB_TOKEN`, and `HUB_WRITE_TOKEN` from the vault without printing values; upload `skill/` using the SkillHub client workflow. If this step fails, record the failure and continue because students do not depend on it.

- [ ] **Step 8: Repair and verify the preview wildcard before app deployment**

Use `tccli dnspod` with the configured cloud profile to ensure `*.preview.supermind-ai.cn` resolves to the VibeHub production IP, verify the nginx wildcard virtual host and certificate cover `*.preview.supermind-ai.cn`, then test a generated preview hostname with `curl --noproxy '*'`. Never declare success from DNS alone.

- [ ] **Step 9: Atomically deploy server and console**

Follow `docs/handbook/deployment.md`: create a timestamped `/opt/vibehub-releases/<timestamp>`, sync server code excluding data/secrets/tests, run `npm ci --omit=dev`, switch `/opt/vibehub` symlink, restart `vibehub`, and require `systemctl is-active vibehub`. Build the console with:

```bash
VITE_API_BASE=https://hub.supermind-ai.cn \
VITE_SKILL_INSTALL_COMMAND='npx -y @supermind/vibehub-skill@latest' \
npm run build
```

Back up `/var/www/vibehub-console`, then sync `web/dist/`. Run `sudo nginx -t` before reload.

- [ ] **Step 10: Run production probes for both student paths**

Using a disposable test camp/invite, verify:

1. `/healthz`, `/login`, `/install`, and static assets return 200.
2. Invite login reaches `/app` and shows “提交我的游戏”.
3. Single HTML upload returns 201, opens a private preview hostname, diagnosis completes, and the teacher queue receives the version.
4. ZIP upload returns 201 and assets load from the isolated preview origin.
5. Public `npx` installation works without SkillHub credentials; the installed Skill binds and deploys a tiny static game.
6. Teacher approval produces a formal URL; rejected/new versions do not replace the current live version.
7. Logs do not contain cookie values, Authorization headers, file contents, or preview claims.

Expected: both paths complete end-to-end. If any probe fails, roll back the console or `/opt/vibehub` symlink before reporting release completion.
