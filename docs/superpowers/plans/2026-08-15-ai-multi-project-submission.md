# AI Multi-Project Submission Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Let a student use one original invitation and an AI agent to create, bind, and submit unlimited independent VibeHub projects without teacher UI work, while keeping every credential scoped to one project.

**Architecture:** Add a student-only Skill project-creation endpoint that creates a project and derived project credential transactionally. Extend the CLI with directory bindings so each source directory resolves an exact connection before any build or network work. Consolidate the web copy flow around one shared install-and-deploy prompt and make AI submission the default.

**Tech Stack:** Node.js, Fastify, better-sqlite3, React, TypeScript, Vitest, Node test runner, SQLite, GitHub Actions, nginx/systemd release symlinks.

---

## Task 1: Fix the unrelated CI port-binding failure

**Files:**
- Modify: `server/test/security-config.test.js`

- [ ] Add/adjust the test fixture so the temporary nginx config replaces `listen 443 ssl http2;` with `listen 8443 ssl http2;`.
- [ ] Run `node --test test/security-config.test.js` from `server/` and confirm it passes without changing `infra/nginx/vibehub-preview-server.conf`.

## Task 2: Add schema support for idempotent projects and derived credentials

**Files:**
- Modify: `server/src/lib/db.js`
- Modify: `server/src/lib/auth.js`
- Test: `server/test/project-creation.test.js`
- Test: `server/test/auth-security.test.js`

- [ ] Write a failing migration test proving an existing database gains nullable `projects.creation_request_id` and `tokens.derived_from_token_id` plus the conditional uniqueness rule.
- [ ] Write a failing device-count test proving derived project tokens do not consume another device slot, while a second root token does.
- [ ] Run only those tests and observe the intended failures.
- [ ] Add additive columns/indexes through the existing idempotent migration helpers.
- [ ] Extend token issuance to accept an optional derivation source and change device counting to root Skill tokens only.
- [ ] Re-run focused tests to green.

## Task 3: Implement transactional student project creation

**Files:**
- Create: `server/src/services/student-project-creation.js`
- Modify: `server/src/routes/skill.js`
- Modify if reuse is needed: `server/src/services/invite-access.js`
- Test: `server/test/project-creation.test.js`
- Test: `server/test/routes.test.js`

- [ ] Write failing API tests for: student success; same owner/camp; old/new token isolation; rejected forged identity fields; non-student/web/teacher denial; title validation; `Cache-Control: no-store`.
- [ ] Write failing idempotency tests for sequential and concurrent repeated `request_id` calls producing one project.
- [ ] Write failing rollback, derived-token device-count, invite-revocation, and A/B upload-isolation tests.
- [ ] Run focused tests and capture RED caused by the missing endpoint/schema behavior.
- [ ] Implement `POST /api/skill/projects`, deriving all identity from `req.auth` and revalidating membership and current project ownership.
- [ ] Normalize titles to 1–80 characters and reject control characters and unrecognized identity/slug/project fields.
- [ ] In one SQLite transaction: resolve idempotency, insert project, insert `student_project_create` audit event, and create a derived project token.
- [ ] Add a per-process five-create-attempts/minute/student guard after idempotency lookup, without any cumulative project cap.
- [ ] Ensure token values and request authorization are absent from logs.
- [ ] Re-run focused tests to green.

## Task 4: Add local project binding primitives to the CLI

**Files:**
- Modify: `skill/bin/vibehub`
- Test: `server/test/cli.test.js`

- [ ] Write failing CLI tests for binding-file format, credentials mode 0600, and absence of token/invite/name in `.vibehub/project.json`.
- [ ] Write failing tests for sensitive binding fields, missing/mismatched credentials, and multiple connections without a binding; each must stop before build and HTTP.
- [ ] Write a failing test proving `deploy /path/to/B` uses B's directory binding even when global active is A and locks the same token for preflight/upload.
- [ ] Write a failing legacy test: exactly one unbound connection may auto-link once; the same connection may not silently auto-link to another source directory.
- [ ] Run focused CLI tests and observe RED.
- [ ] Add strict parsing and atomic writes for `.vibehub/project.json` and pending creation state.
- [ ] Record canonical `local_paths` metadata per connection in the HOME credential store; migrate absent fields as empty arrays.
- [ ] Add `.vibehub/` to a containing Git repository's local `.git/info/exclude` without changing shared `.gitignore`.
- [ ] Resolve and lock the exact credential before build/preflight/upload; print the target project and fail closed on ambiguity.
- [ ] Re-run focused tests to green.

## Task 5: Add project create/link commands and retry recovery

**Files:**
- Modify: `skill/bin/vibehub`
- Test: `server/test/cli.test.js`

- [ ] Write failing tests for `project create --title "作品 B" [dir]`, including request shape, successful credential save/activation/binding, old-connection preservation, and local-store immutability on failure.
- [ ] Write a failing recovery test proving a pending `request_id` is reused after a lost response/local-save interruption.
- [ ] Write failing tests for `project link <full connection_key> [dir]` and refusal to overwrite an existing different binding.
- [ ] Run focused tests and observe RED.
- [ ] Implement both commands using the current connection as authorization only; never submit client owner/camp/project/slug.
- [ ] On success, atomically store the new credential, update `local_paths`, replace pending binding, and set active.
- [ ] Update CLI help and human-readable errors around “作品连接”.
- [ ] Confirm `.vibehub` remains excluded from generated archives.
- [ ] Re-run focused tests to green.

## Task 6: Update the Skill contract and self-hosted distribution

**Files:**
- Modify: `skill/SKILL.md`
- Modify: `skill/AGENTS.md`
- Modify: `skill/bin/install.mjs`
- Modify: `skill/distribution-files.mjs`
- Test: `server/test/skill-runtime.test.js`
- Test: `server/test/skill-installer.test.js`

- [ ] Write failing tests requiring the Skill and mirrored agent rules to explain new-vs-existing project decisions, exact directory binding, and immediate deployment without a second instruction.
- [ ] Write a failing distribution test expecting version `1.0.1` and the existing seven-file allowlist.
- [ ] Run focused tests and observe RED.
- [ ] Update Skill/AGENTS/installer guidance and bump `SKILL_VERSION` to `1.0.1`.
- [ ] Rebuild distribution into `web/public/downloads/vibehub-skill` with `skill/scripts/build-distribution.mjs`.
- [ ] Re-run installer/runtime/integrity tests to green.

## Task 7: Consolidate the one-paste AI prompt

**Files:**
- Modify: `web/src/lib/vibehubDeployPrompt.ts`
- Modify: `web/src/pages/InstallPage.tsx`
- Modify: `web/src/pages/StudentSubmitPage.tsx`
- Modify: `web/src/pages/AdminInvitesPage.tsx`
- Test: `web/src/lib/vibehubDeployPrompt.test.ts`
- Test: `web/src/student-submit.test.ts`
- Test: `web/src/install-page.test.ts`
- Test: `web/src/student-submission-entries.test.ts`

- [ ] Write failing prompt tests requiring exact official manifest/installer URLs, install/update, optional one-time bind, create/link decision, deploy-now behavior, integrity checks, and no “wait for another instruction”.
- [ ] Write a failing student-page test proving AI is the default and the one copy button copies the shared complete prompt; keep web upload selectable.
- [ ] Write failing install/teacher tests proving one shared primary copy action, one code per student handout, and browser fallback in the same content rather than a second guide.
- [ ] Run focused Vitest files and observe RED.
- [ ] Make `buildVibeHubDeployPrompt` the sole builder and centralize the public base URL helper.
- [ ] Remove the short standalone student prompt and separate install CTA; default `initialMode` to `ai`.
- [ ] Merge teacher generic guidance into one AI-recommended copy card while retaining per-student one-time code handouts.
- [ ] Re-run focused web tests to green.

## Task 8: Synchronize product and operations documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/handbook/deployment.md`
- Modify: `docs/specs/architecture.md`
- Modify: `docs/specs/domain-model.md`
- Modify: `docs/superpowers/specs/2026-08-13-vibehub-deploy-ai-prompt-design.md`

- [ ] Document the student AI flow: first invite bind, project create/link, directory-safe deploy, and unlimited projects.
- [ ] Document derived credential/device-count/revocation behavior and the new audit event.
- [ ] Mark the older two-step prompt decision as superseded on 2026-08-15 without rewriting its historical content.
- [ ] Add timestamp-plus-commit SQLite backup and explicit code/database rollback guidance.
- [ ] Run link/path searches for obsolete two-step wording and resolve relevant matches.

## Task 9: Run integration and independent reviews

- [ ] Rebuild the self-hosted Skill distribution.
- [ ] Run all server tests: `node --test test/*.test.js`.
- [ ] Run all web tests: `node node_modules/vitest/vitest.mjs run`.
- [ ] Run the web production build: TypeScript build followed by Vite build.
- [ ] Run `git diff --check`, inspect the full diff and ensure only planned files changed.
- [ ] Ask an independent spec-compliance reviewer to compare implementation to the approved design.
- [ ] Ask an independent code-quality/security reviewer to inspect transactionality, auth, secret handling, CLI fail-closed behavior, and tests.
- [ ] Fix all critical/important findings and repeat the affected test suites and review.

## Task 10: Publish through GitHub

- [ ] Confirm `gh` authentication and repository/branch targets.
- [ ] Stage only explicit planned paths, commit coherent implementation units, and push `codex/student-ai-multi-project-mvp` without force.
- [ ] Open a ready PR with summary, risk notes, test evidence, schema compatibility, and deployment order.
- [ ] Wait for all GitHub checks to finish; diagnose and fix any real failure.
- [ ] Merge only after checks are green, then record the exact main commit SHA for release artifacts.

## Task 11: Back up and deploy the MVP

- [ ] Load VibeHub production credentials through server-vault without printing secrets; confirm host identity and current release symlinks read-only.
- [ ] Create an online SQLite backup named with UTC timestamp and release commit SHA; verify the backup opens and passes integrity check.
- [ ] Build/install a new backend release, atomically switch `/opt/vibehub`, restart `vibehub.service`, and verify `/healthz` and unauthenticated auth boundaries.
- [ ] Build the web/Skill static release from the same main SHA, atomically switch the console symlink, and verify `/install`, `manifest.json`, `install.mjs`, all seven file hashes, Skill version, and CLI help.
- [ ] Run the isolated production golden path: bind test student A, create directory/project B, deploy distinct A/B bundles, verify separate queue/version ownership, then revoke the test invite and verify both credentials fail.
- [ ] If any critical probe fails, switch code symlinks back and use the verified database backup only when the migration/data state requires it.

## Task 12: Start the full web multi-project phase

- [ ] After MVP production verification, create a separate follow-up branch/design checkpoint for `/api/me/projects`, web project creation/session switching, `/app/projects`, and the mobile project selector.
- [ ] Reuse the project-creation service and project-scoped session rotation; do not widen project authorization.
- [ ] Repeat TDD, review, GitHub checks, backup, and deployment as a separately releasable change.
