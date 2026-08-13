# VibeHub Self-Hosted Skill Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unpublished npm installation path with a VibeHub-hosted, integrity-checked Skill installer for macOS and Windows, and expose reusable student onboarding instructions in the teacher admin.

**Architecture:** A deterministic generator copies the exact existing Skill runtime whitelist into `web/public/downloads/vibehub-skill`, writes a SHA-256 manifest, and publishes a small Node bootstrap installer. The bootstrap downloads only manifest-listed files from the same HTTPS distribution root, verifies sizes and hashes, then invokes the existing transactional installer. The React install page exposes separate macOS and PowerShell commands plus a copy-for-AI prompt; browser uploads remain independent.

**Tech Stack:** Node.js 20+ ESM, Web Crypto/`node:crypto`, Node test runner, React 18, TypeScript, Vitest, Vite static assets.

---

## File structure

- Create `skill/distribution-files.mjs`: one source of truth for the public Skill runtime whitelist and safe relative-path validation.
- Create `skill/scripts/build-distribution.mjs`: deterministic build step that copies files and writes the manifest.
- Create `skill/bootstrap/install.mjs`: network bootstrap that validates the manifest and delegates to the existing installer.
- Modify `skill/bin/install.mjs`: import the shared whitelist instead of maintaining a second list.
- Modify `skill/package.json`: retain local version metadata but remove npm-public package identity and bin publishing metadata.
- Modify `web/package.json`: generate distribution resources before development/build/test flows that require them.
- Modify `web/src/pages/InstallPage.tsx`: self-hosted platform commands and copy-for-AI UI.
- Modify `web/src/install-page.test.ts`: behavior assertions for the new install experience.
- Modify `server/test/skill-installer.test.js`: generator, integrity, bootstrap, cleanup, and install regression coverage.
- Modify `README.md`, `docs/handbook/deployment.md`, `docs/specs/architecture.md`, and the previous design/plan: replace npm as the student distribution channel and document production probes.

### Task 1: Deterministic public distribution artifact

**Files:**
- Create: `skill/distribution-files.mjs`
- Create: `skill/scripts/build-distribution.mjs`
- Modify: `skill/bin/install.mjs`
- Modify: `skill/package.json`
- Test: `server/test/skill-installer.test.js`

- [ ] **Step 1: Replace the npm-pack test with a failing distribution test**

Define the wished-for public API in the test:

```js
const generated = mkdtempSync(join(tmpdir(), 'vh-skill-dist-'));
const result = await run(process.execPath, [resolve('../skill/scripts/build-distribution.mjs'), '--out', generated], {
  cwd: resolve('..'), env: { ...process.env },
});
assert.equal(result.code, 0, result.stderr);
const manifest = JSON.parse(readFileSync(join(generated, 'manifest.json'), 'utf8'));
assert.equal(manifest.schema_version, 1);
assert.equal(manifest.skill_version, '1.0.0');
assert.deepEqual(manifest.files.map((file) => file.path), [
  'AGENTS.md', 'SKILL.md', 'agents/openai.yaml', 'bin/install.mjs', 'bin/vibehub', 'lib/platform.mjs',
]);
for (const entry of manifest.files) {
  const content = readFileSync(join(generated, 'files', entry.path));
  assert.equal(content.byteLength, entry.bytes);
  assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256);
}
assert.ok(existsSync(join(generated, 'install.mjs')));
```

Also assert that the manifest contains no absolute/`..` path and the output contains no `package.json`, `.npmrc`, token, or unrelated repository file.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='自托管分发' server/test/skill-installer.test.js
```

Expected: FAIL because `skill/scripts/build-distribution.mjs` does not exist and the old npm package assertions no longer match.

- [ ] **Step 3: Implement the whitelist and generator**

Export immutable values from `distribution-files.mjs`:

```js
export const SKILL_VERSION = '1.0.0';
export const DISTRIBUTION_FILES = Object.freeze([
  'AGENTS.md', 'SKILL.md', 'agents/openai.yaml', 'bin/install.mjs', 'bin/vibehub', 'lib/platform.mjs',
]);
export function assertSafeDistributionPath(path) {
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`unsafe distribution path: ${path}`);
  }
  return path;
}
```

`build-distribution.mjs` must parse only `--out`, clean and recreate the exact output directory, copy the bootstrap as `install.mjs`, copy each whitelist file under `files/`, and write `manifest.json` with `{ schema_version: 1, skill_version, generated_at, files: [{path, bytes, sha256}] }`. Sort files by path and write JSON with a trailing newline. Import `DISTRIBUTION_FILES` from the same module in `bin/install.mjs`.

Change `skill/package.json` to private local metadata:

```json
{
  "name": "vibehub-skill-source",
  "version": "1.0.0",
  "description": "让 AI 助手把网页游戏提交到 VibeHub 营地",
  "type": "module",
  "engines": { "node": ">=20" },
  "license": "UNLICENSED",
  "private": true
}
```

- [ ] **Step 4: Run focused installer tests and verify GREEN**

Run:

```bash
node --test server/test/skill-installer.test.js
```

Expected: all installer and distribution tests PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add skill/distribution-files.mjs skill/scripts/build-distribution.mjs skill/bin/install.mjs skill/package.json server/test/skill-installer.test.js
git commit -m "feat: build self-hosted skill artifacts"
```

### Task 2: Integrity-checked online bootstrap

**Files:**
- Create: `skill/bootstrap/install.mjs`
- Modify: `skill/scripts/build-distribution.mjs`
- Test: `server/test/skill-installer.test.js`

- [ ] **Step 1: Write failing local-HTTP bootstrap tests**

Start a real `node:http` server that serves a generated distribution. Run the generated `install.mjs` with a temporary HOME and an explicit test-only base URL argument:

```js
const result = await run(process.execPath, [join(generated, 'install.mjs'),
  '--base-url', `${origin}/downloads/vibehub-skill/`, '--home', home, '--targets', 'codex'], {
  cwd: resolve('..'), env: { ...process.env, NODE_ENV: 'test' },
});
assert.equal(result.code, 0, result.stderr);
assert.ok(existsSync(join(home, '.agents', 'skills', 'vibehub', 'SKILL.md')));
```

Add separate cases for a modified file hash, manifest 404, interrupted body, duplicate/unsafe manifest paths, and an existing Skill. Assert failures do not change the existing Skill and that no `vibehub-skill-download-*` directory remains under a test-controlled temporary root.

- [ ] **Step 2: Run bootstrap tests and verify RED**

Run:

```bash
node --test --test-name-pattern='在线安装' server/test/skill-installer.test.js
```

Expected: FAIL because the bootstrap has not implemented fetch, integrity checks, delegation, or cleanup.

- [ ] **Step 3: Implement the bootstrap**

The bootstrap must:

```js
const DEFAULT_BASE_URL = new URL('./', import.meta.url);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
```

- Require `--base-url`: the installer page passes its current public `/downloads/vibehub-skill/` root because the downloaded bootstrap runs from a local temporary path and cannot infer the response URL.
- Require a URL without credentials or fragments; require HTTPS in production and permit `http://127.0.0.1`/`localhost` only in tests.
- Fetch `manifest.json` with redirect rejection, verify content length while streaming, require schema `1`, exact Skill version format, exact whitelist set with no duplicate paths, per-file size in `1..MAX_FILE_BYTES`, and lowercase 64-character SHA-256.
- Create a `mkdtempSync(join(tmpdir(), 'vibehub-skill-download-'))` root; download files sequentially under `skill/`, reject redirects/non-2xx/truncated/oversized bodies, and verify bytes and SHA-256 before continuing.
- Invoke the downloaded `skill/bin/install.mjs` with `process.execPath` and forward only the existing installer arguments (`--home`, `--targets`, `--dir`, `--help`). Do not use a shell.
- Always recursively delete the download root in `finally`; print fixed Chinese recovery messages without URLs containing credentials or raw stack traces.

- [ ] **Step 4: Run bootstrap and existing installer tests and verify GREEN**

Run:

```bash
node --test server/test/skill-installer.test.js
```

Expected: all tests PASS, including existing backup/swap fault tests.

- [ ] **Step 5: Commit Task 2**

```bash
git add skill/bootstrap/install.mjs skill/scripts/build-distribution.mjs server/test/skill-installer.test.js
git commit -m "feat: install hosted skill with integrity checks"
```

### Task 3: Student-facing macOS, Windows, and AI installation paths

**Files:**
- Modify: `web/package.json`
- Modify: `web/src/pages/InstallPage.tsx`
- Modify: `web/src/install-page.test.ts`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing install-page behavior tests**

Assert source and rendered behavior:

```ts
expect(page).not.toMatch(/VITE_SKILL_INSTALL_COMMAND|npx|npm|SkillHub/i);
expect(page).toContain('/downloads/vibehub-skill/install.mjs');
expect(page).toContain('PowerShell');
expect(page).toContain('复制给 AI');
expect(page).toContain('node --version');
```

Render platform tabs and verify the macOS command uses `curl --fail --location` plus `node`, while the Windows command uses `Invoke-WebRequest` plus `node`. Verify each copy button calls `copyToClipboard` with the currently displayed exact command/prompt and reports success/failure through `role=status`.

- [ ] **Step 2: Run install-page tests and verify RED**

Run:

```bash
npx vitest run src/install-page.test.ts
```

Expected: FAIL because the current page uses one `VITE_SKILL_INSTALL_COMMAND`, mentions `npx`, and lacks the AI prompt.

- [ ] **Step 3: Implement the page and build integration**

Use a fixed same-origin download path and public origin derived from `window.location.origin`:

```ts
const INSTALLER_PATH = '/downloads/vibehub-skill/install.mjs';
const installerUrl = `${window.location.origin}${INSTALLER_PATH}`;
```

Commands:

```text
macOS: tmp="$(mktemp -t vibehub-skill.XXXXXX.mjs)" && curl --fail --silent --show-error --location "<url>" --output "$tmp" && node "$tmp" --base-url "<distribution-root>"; code=$?; rm -f "$tmp"; exit $code
Windows: $p=Join-Path $env:TEMP ('vibehub-skill-'+[guid]::NewGuid()+'.mjs'); try { Invoke-WebRequest -UseBasicParsing '<url>' -OutFile $p; node $p --base-url '<distribution-root>'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } finally { Remove-Item $p -Force -ErrorAction SilentlyContinue }
```

The AI prompt must say to open the official VibeHub installer URL, detect macOS/Windows, run the shown official command, then ask the student for an invite code; it must not contain a real code or city name.

Add `predev`, `prebuild`, and `pretest` scripts that run `node ../skill/scripts/build-distribution.mjs --out ./public/downloads/vibehub-skill`. Keep UI changes within existing design tokens and ensure buttons remain usable at 320px width.

- [ ] **Step 4: Run frontend verification and verify GREEN**

Run:

```bash
npm test -- --run
npx tsc -b
npm run build
```

Expected: all tests pass, TypeScript exits 0, and `dist/downloads/vibehub-skill/{install.mjs,manifest.json,files/...}` exists.

- [ ] **Step 5: Commit Task 3**

```bash
git add web/package.json web/src/pages/InstallPage.tsx web/src/install-page.test.ts web/src/styles.css
git commit -m "feat: offer hosted skill installation"
```

### Task 4: Teacher-facing student onboarding instructions

**Files:**
- Modify: `web/src/pages/AdminInvitesPage.tsx`
- Modify: `web/src/student-submission-entries.test.ts`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing teacher-admin behavior tests**

Assert that the invite page renders a persistent “发给学员的使用说明” section even before codes are generated. Verify separate browser and AI paths include `/login`, `/install`, HTML/ZIP/folder upload, macOS, Windows, WorkBuddy, Codex, the exact AI phrases, and a `CAMP-XXXX` placeholder rather than a real code or city. Verify copy success/failure uses `role=status` and does not log or persist invite codes.

Extend per-code assertions so every student message contains only its own code and both routes, while teacher-role codes still hide all student instructions.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/student-submission-entries.test.ts
```

Expected: FAIL because the persistent teacher guide and its copy interaction do not exist.

- [ ] **Step 3: Implement the persistent guide**

Add pure message builders for the browser route, AI route, and combined per-code handout. Render a panel in the teacher invite page before the one-time revealed-code panel. Use `VITE_PUBLIC_APP_URL` through `publicAppBaseUrl`, current camp name, and the placeholder `CAMP-XXXX`; do not hardcode Shenzhen or production host. Provide accessible “复制网页登录说明” and “复制 AI 部署说明” controls with fixed success/failure notices.

Keep one-time codes only in component state as today. Do not attempt to reconstruct full codes from masked history. When new student codes are generated, keep the per-code copy buttons and replace the placeholder with the specific code. When teacher codes are generated, show only the existing raw-code/export actions.

- [ ] **Step 4: Run frontend verification and verify GREEN**

Run:

```bash
npx vitest run src/student-submission-entries.test.ts
npm test -- --run
npx tsc -b
npm run build
```

Expected: focused and full tests pass, TypeScript exits 0, production build succeeds, and the guide remains usable at 320px width.

- [ ] **Step 5: Commit Task 4**

```bash
git add web/src/pages/AdminInvitesPage.tsx web/src/student-submission-entries.test.ts web/src/styles.css
git commit -m "feat: show student instructions to teachers"
```

### Task 5: Documentation, validation, and production release

**Files:**
- Modify: `README.md`
- Modify: `docs/handbook/deployment.md`
- Modify: `docs/specs/architecture.md`
- Modify: `docs/research/student-submission-entry-audit-20260812.md`
- Modify: `docs/superpowers/specs/2026-08-12-student-submission-entry-design.md`
- Modify: `docs/superpowers/plans/2026-08-12-student-submission-entry.md`

- [ ] **Step 1: Update current documentation and mark old npm decisions superseded**

Document `/install → VibeHub HTTPS assets → integrity bootstrap → existing local installer`. Remove `VITE_SKILL_INSTALL_COMMAND`, npm login/publish, npm package probes, and “即将开放”. Keep npm references that describe project development or student project builds; only remove npm as the Skill distribution channel. Add a dated supersession note to the old design and plan instead of rewriting historical task evidence.

- [ ] **Step 2: Validate the Skill with the canonical validator**

Run:

```bash
python3 /Users/michael/.codex/skills/.system/skill-creator/scripts/quick_validate.py skill
```

Expected: validation succeeds.

- [ ] **Step 3: Run fresh complete verification**

Run:

```bash
cd server && npm test
cd ../web && npm test -- --run && npx tsc -b && npm run build
git diff --check
```

Expected: zero failures. If the two known unrelated submission recovery baseline tests fail, record them separately, rerun the focused Skill installer and complete web suite, and do not claim the server suite is green until the baseline defect is fixed or explicitly waived.

- [ ] **Step 4: Independent review**

Request spec compliance review, then code-quality/security review. Require attention to manifest traversal, redirect handling, body limits, hash verification before execution, command quoting, Windows cleanup, old-version recovery, generated-file drift, and accidental npm/SkillHub dependency. Fix every Critical/Important issue and re-run focused plus full verification.

- [ ] **Step 5: Merge and publish**

Merge the isolated branch into main without overwriting unrelated Shanghai-camp changes. Push main. Build the console with `VITE_API_BASE` and `VITE_PUBLIC_APP_URL` only; deploy it atomically to `/var/www/vibehub-console`. The server does not require a new release unless review changes server runtime code.

- [ ] **Step 6: Production probes**

Verify:

```text
GET /install → 200
GET /downloads/vibehub-skill/install.mjs → 200
GET /downloads/vibehub-skill/manifest.json → 200 JSON
GET every manifest file → 200 and local SHA-256 equals manifest
```

From a clean temporary HOME on macOS, run the public bootstrap against production with `--targets codex`, verify installed files, then remove only that temporary HOME. Verify the PowerShell command with parser/unit tests; do not claim a real Windows-device run unless one is available. Confirm `/app/submit` remains 200 and the production service remains healthy.

- [ ] **Step 7: Final commit if documentation/review fixes remain**

```bash
git add README.md docs web skill server/test/skill-installer.test.js
git commit -m "docs: make VibeHub the skill distribution source"
```

Do not include unrelated files or generated `web/public/downloads/vibehub-skill` output in git; it is regenerated by lifecycle scripts.
