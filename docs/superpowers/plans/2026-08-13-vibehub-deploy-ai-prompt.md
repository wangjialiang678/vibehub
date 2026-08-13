# VibeHub Deploy AI Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the student-facing installation action a natural-language prompt for AI agents, rename the Skill to VibeHub Deploy, and publish an independent SuperMind SkillHub mirror without mentioning SkillHub to students.

**Architecture:** A shared frontend prompt builder generates both the public `/install` copy and teacher per-invite handouts from the official VibeHub origin. The existing integrity-checked bootstrap remains the machine layer behind the AI prompt. Skill metadata and target folders move to `vibehub-deploy`, while the public download URL remains backward-compatible and SkillHub receives a separate mirror.

**Tech Stack:** React 18, TypeScript, Vitest, Node.js 20+ ESM, Node test runner, SuperMind SkillHub HTTP API.

---

## File structure

- Create `web/src/lib/vibehubDeployPrompt.ts`: pure origin normalization and natural-language prompt builder.
- Create `web/src/lib/vibehubDeployPrompt.test.ts`: prompt content, origin and secret-boundary tests.
- Modify `web/src/pages/InstallPage.tsx`: remove visible commands/platform tabs and make the AI prompt the only primary action.
- Modify `web/src/install-page.test.ts`: prompt-first rendering and copy interaction tests.
- Modify `web/src/pages/AdminInvitesPage.tsx`: reuse the prompt builder for generic and per-code teacher handouts.
- Modify `web/src/student-submission-entries.test.ts`: teacher prompt reuse and invite isolation tests.
- Modify `web/src/styles.css`: prompt-first card and responsive layout.
- Modify `skill/SKILL.md`, `skill/agents/openai.yaml`, `skill/bin/install.mjs`, `skill/package.json`, `skill/distribution-files.mjs`: new technical/display name and install targets.
- Modify `server/test/skill-installer.test.js`: new folder/name/distribution assertions and compatibility regression.
- Modify current README, architecture and deployment documentation: prompt-first public experience and independent SkillHub mirror.

### Task 1: Shared natural-language AI prompt

**Files:**
- Create: `web/src/lib/vibehubDeployPrompt.ts`
- Create: `web/src/lib/vibehubDeployPrompt.test.ts`

- [ ] **Step 1: Write failing prompt tests**

Test `buildVibeHubDeployPrompt(origin, inviteCode?)` with `https://hub.example.test/`. Require the exact display name, official distribution root, `manifest.json`, `install.mjs`, AI-owned installation, macOS/Windows, current Agent, Node.js 20, invite request/binding, and “部署我的游戏”. Assert absence of `curl`, PowerShell, `npx`, `npm`, SkillHub, tokens, and city names. With a concrete code, assert it appears once; without one, assert the AI must ask for it.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/lib/vibehubDeployPrompt.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure builder**

Export `normalizePublicOrigin` and `buildVibeHubDeployPrompt`. The prose must instruct the Agent to use only `${origin}/downloads/vibehub-skill/`, read the manifest and installer, perform the official installation itself, never ask the student to execute a terminal command, ask for an invite if absent, bind, and wait for explicit deploy intent.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused test, then commit only the new helper and test as `feat: add VibeHub Deploy AI prompt`.

### Task 2: Prompt-first student and teacher UI

**Files:**
- Modify: `web/src/pages/InstallPage.tsx`
- Modify: `web/src/install-page.test.ts`
- Modify: `web/src/pages/AdminInvitesPage.tsx`
- Modify: `web/src/student-submission-entries.test.ts`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing UI tests**

Require `/install` to render one prompt, one primary “复制这段话给 AI” action and a secondary `/login` link. Assert no platform tabs, terminal command builder, shell/PowerShell content, `node --version`, npm, SkillHub or city. Invoke the copy helper and verify exact prompt plus success/failure status.

Require teacher generic AI guide and every student-code message to contain the shared prompt contract. Student codes remain isolated and teacher-role code reveal remains prompt-free.

- [ ] **Step 2: Run focused tests and verify RED**

Run `npx vitest run src/install-page.test.ts src/student-submission-entries.test.ts` and confirm failures come from the old command UI and old AI guide.

- [ ] **Step 3: Implement the prompt-first pages**

Replace InstallPage platform state/commands with a rendered prompt card and copy action. Keep the three-step explanation as copy → paste to AI → provide invite/deploy. In AdminInvitesPage, call the shared builder with the placeholder or per-student code and describe the website path separately. Do not add SkillHub text anywhere under `web/src`.

- [ ] **Step 4: Verify frontend and commit**

Run focused tests, full `npm test -- --run`, `npx tsc -b`, and `npm run build`. Commit as `feat: make VibeHub Deploy prompt-first`.

### Task 3: Rename Skill identity and target directories

**Files:**
- Modify: `skill/SKILL.md`
- Modify: `skill/agents/openai.yaml`
- Modify: `skill/bin/install.mjs`
- Modify: `skill/package.json`
- Modify: `skill/distribution-files.mjs`
- Modify: `server/test/skill-installer.test.js`

- [ ] **Step 1: Write failing identity/install tests**

Require Skill frontmatter `name: vibehub-deploy`, OpenAI display `VibeHub Deploy`, local package metadata `vibehub-deploy-skill-source`, manifest version `1.0.0`, and default installs under `.agents/.claude/.codebuddy/skills/vibehub-deploy`. Require custom dirs to end in `skills/vibehub-deploy`. Keep CLI filename `bin/vibehub` and seven-file manifest.

- [ ] **Step 2: Run installer tests and verify RED**

Run the identity name pattern and confirm old `vibehub` folders/metadata fail.

- [ ] **Step 3: Implement rename**

Change the frontmatter and UI metadata, package local name, installer target parts, help/errors, backup basename, and custom-dir validation. Do not change VibeHub API routes, CLI name, credentials or the public download path.

- [ ] **Step 4: Validate and commit**

Run all installer tests and `quick_validate.py skill`; commit as `feat: rename deployment skill to VibeHub Deploy`.

### Task 4: Documentation, review and independent SkillHub mirror

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/architecture.md`
- Modify: `docs/handbook/deployment.md`
- Modify: `docs/superpowers/specs/2026-08-13-self-hosted-skill-distribution-design.md`

- [ ] **Step 1: Update current documentation**

Document that students copy prose to AI and only know the VibeHub public origin. Document `vibehub-deploy`, the backward-compatible download path, and SkillHub as a separately maintained internal mirror that must never appear in student copy.

- [ ] **Step 2: Run complete verification**

Run installer tests, full web tests, TypeScript, production build, full server tests with the known-good bundled Node runtime, Skill validation, `rg` secret/channel assertions, and `git diff --check`.

- [ ] **Step 3: Independent review**

Review prompt injection/ambiguity, origin handling, absence of internal channel leakage, invite isolation, renamed folder compatibility, manifest integrity, generated assets and docs. Fix all Critical/Important findings and rerun focused/full tests.

- [ ] **Step 4: Publish code and website**

Merge without touching unrelated Shanghai-camp work, push main, build with production public/API origins, deploy a timestamped static release, atomically switch `current`, and verify `/install`, manifest hashes, prompt text and a clean temporary install into `skills/vibehub-deploy`.

- [ ] **Step 5: Publish the independent SkillHub mirror**

Copy the exact committed `skill/` directory to a temporary folder named `vibehub-deploy`, create a tarball, and upload with vault-provided `HUB_URL`/`HUB_WRITE_TOKEN`. Use display name `VibeHub Deploy`, universal platform, automation category, and Chinese value/caution metadata. Query the index and assert both `vibehub-deploy` and legacy `vibehub` exist. Do not expose or persist tokens, and do not add SkillHub to student UI.

