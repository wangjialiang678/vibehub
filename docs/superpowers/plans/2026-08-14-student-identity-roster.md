# Flexible Student Identity and Preview Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every student a flexible, privacy-safe identity that can be linked to an invite before or after redemption, expose it correctly to teachers and students, backfill the Shenzhen roster, and keep the student page synchronized when a pending preview becomes a live game.

**Architecture:** Add an independent `camp_roster` entity and an optional invite-to-roster link. A shared identity service validates names and performs invite binding/profile updates atomically. Existing user `real_name` remains private and `display_name` remains public. Teacher APIs support optional roster-first invite generation, historical code linking, correction and verification. The student app handles profile completion for both web and Skill/API flows. Preview polling continues throughout review and recovers from a stale grant with a project refetch.

**Tech Stack:** Node.js ESM, Fastify, SQLite (`node:sqlite`), React 18, TypeScript, TanStack Query, Vitest, Node test runner.

---

## File structure

- Modify `server/src/lib/db.js`: roster schema, invite link and public-name consent columns.
- Modify `server/src/services/invite-access.js`: atomic profile-aware binding.
- Create `server/src/services/student-identity.js`: validation, roster import/update and teacher projections.
- Modify `server/src/routes/skill.js` and `server/src/index.js`: profile fields in bind/session and `/api/me/profile`.
- Modify `server/src/routes/admin.js`: roster list/import/update and optional-name invite generation.
- Create `server/scripts/import-shenzhen-roster.mjs`: idempotent production backfill.
- Modify server tests for migrations, races, privacy and all three linking orders.
- Modify `web/src/pages/LoginPage.tsx`: profile completion/mismatch UI.
- Modify `web/src/pages/StudentPage.tsx`: name card, nickname editing, review polling and stale-preview recovery.
- Modify `web/src/pages/AdminInvitesPage.tsx`: roster-first generation, historical linking and roster management.
- Modify frontend API/types/tests/styles.
- Modify `skill/SKILL.md` and `skill/bin/vibehub.mjs`: profile-aware binding guidance/options.
- Modify `docs/specs/domain-model.md`, API and teacher/student workflow documentation.

### Task 1: Preview approval synchronization

**Files:**
- Modify: `web/src/lib/presentation.ts`
- Modify: `web/src/pages/StudentPage.tsx`
- Modify: `web/src/components/Ui.tsx`
- Modify: `web/src/teacher-features.test.ts`
- Modify: `web/src/student-submission-entries.test.ts`

- [ ] **Step 1: Write failing tests**

Cover polling while `pending_version` exists even after diagnosis completes, stopping after pending clears, inline grant 404 triggering one refetch with a synchronization message, and the open-preview action closing its blank window and refetching on a stale grant.

- [ ] **Step 2: Verify RED**

Run `npm test -- --run src/teacher-features.test.ts src/student-submission-entries.test.ts` from `web/` and confirm the new expectations fail on current behavior.

- [ ] **Step 3: Implement and verify GREEN**

Extend the polling helper with pending state, pass the query refetch callback into preview components, and translate a stale grant into state synchronization rather than “preview missing”. Run the focused tests.

### Task 2: Roster schema and identity service

**Files:**
- Modify: `server/src/lib/db.js`
- Create: `server/src/services/student-identity.js`
- Create: `server/test/student-identity.test.js`

- [ ] **Step 1: Write failing data/service tests**

Cover idempotent migration, duplicate names, name normalization/length/control characters, teacher-created and student-created roster entries, linking an existing invite, preserving a non-generic nickname, cross-camp 404 behavior and audit logs.

- [ ] **Step 2: Verify RED**

Run `node --test test/student-identity.test.js` from `server/`; expect missing table/service failures.

- [ ] **Step 3: Implement minimal schema/service**

Add `camp_roster`, the optional unique invite link, consent fields, validation helpers and transaction-safe CRUD/import functions. Do not infer identity from duplicate names.

- [ ] **Step 4: Verify GREEN**

Run the focused test and `node --check` on production modules.

### Task 3: Profile-aware invite binding and API

**Files:**
- Modify: `server/src/services/invite-access.js`
- Modify: `server/src/routes/skill.js`
- Modify: `server/src/index.js`
- Modify: `server/src/lib/auth.js` if the `/api/me` projection needs a shared helper
- Modify: `server/test/auth-security.test.js`
- Modify: `server/test/routes.test.js`

- [ ] **Step 1: Write failing binding/API tests**

Cover `profile_required`, unassigned self-fill, preassigned match and mismatch, no mutation on mismatch, already-bound login, web sessions not consuming Skill device quota, `/api/me` private fields, student nickname edits, unverified real-name corrections and verified-name rejection. Include a concurrent bind/revoke invariant test.

- [ ] **Step 2: Verify RED**

Run the two focused server suites and confirm failures are caused by missing profile behavior.

- [ ] **Step 3: Implement atomic binding and endpoints**

Pass optional `real_name`/`display_name` through web and Skill bind, perform every decision inside `BEGIN IMMEDIATE`, create/link roster/user/project in one transaction, and expose a scoped profile update endpoint. Record mismatches in the invite limiter without logging names.

- [ ] **Step 4: Verify GREEN**

Run focused tests, then the full server test suite.

### Task 4: Teacher roster APIs and privacy consent

**Files:**
- Modify: `server/src/routes/admin.js`
- Modify: `server/test/admin-routes.test.js` or the existing admin route suite
- Modify: `docs/specs/api.md`

- [ ] **Step 1: Write failing teacher tests**

Cover optional-name invite generation, list/import/update/verify, historical code linking, bound-user backfill, idempotent repeats, cross-camp isolation, CSV projections, real-name teacher display and rejecting public `realname` visibility without explicit consent.

- [ ] **Step 2: Implement teacher APIs**

Add roster endpoints and extend generation without removing raw-code generation. Return masked codes in persistent lists; return full codes only in the existing one-time generation response. Add consent audit metadata when real-name publication is requested.

- [ ] **Step 3: Verify GREEN**

Run focused admin tests and the full server suite.

### Task 5: Student and teacher web experience

**Files:**
- Modify: `web/src/pages/LoginPage.tsx`
- Modify: `web/src/pages/StudentPage.tsx`
- Modify: `web/src/pages/AdminInvitesPage.tsx`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/styles.css`
- Modify/create corresponding Vitest suites

- [ ] **Step 1: Write failing interaction tests**

Render and interact with: first-login profile step, mismatch/contact-teacher state, private-name/public-nickname labels, nickname retry, optional roster names during code generation, existing-code import, teacher verification/editing and mobile layouts. Assert no real name appears in public handout text or URLs.

- [ ] **Step 2: Implement the pages**

Keep code-only generation available. Use plain-language defaults and status labels: “学员自填·待确认”, “老师已确认”, “未分配”, “已绑定”. Preserve all existing per-code VibeHub Deploy prompts.

- [ ] **Step 3: Verify frontend**

Run focused tests, `npm test -- --run`, `npx tsc -b`, and `npm run build` from `web/`.

### Task 6: VibeHub Deploy profile completion

**Files:**
- Modify: `skill/SKILL.md`
- Modify: `skill/bin/vibehub.mjs`
- Modify: `skill/test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI/contract tests**

Cover `bind <code> --name <real-name> --nickname <public-name>`, omission compatibility, structured `profile_required` guidance and no names in credential files/log output.

- [ ] **Step 2: Implement and verify**

Send optional profile fields to `/api/skill/bind`. Teach agents to ask the learner for the missing private name and optional public nickname, then retry; never guess. Run all Skill/CLI tests and `quick_validate.py skill`.

### Task 7: Shenzhen roster import and documentation

**Files:**
- Create: `server/scripts/import-shenzhen-roster.mjs`
- Create: `server/test/import-shenzhen-roster.test.js`
- Modify: `docs/specs/domain-model.md`
- Modify: `docs/handbook/deployment.md`
- Modify: current workflow/README documentation

- [ ] **Step 1: Write an idempotent import test**

Use 11 names and 11 codes in the agreed order, known nicknames for 笑笑/小麦, safe aliases for the other nine, and assert four spare codes remain unassigned. Repeat the import and assert no duplicate roster entries or changed project/token/version data.

- [ ] **Step 2: Implement the import helper**

Accept a camp slug and JSON input; require every code to exist in that camp. Run in one transaction, link already-bound users, and only replace empty/`新学员` public names.

- [ ] **Step 3: Update documentation**

Document the data model, privacy rules, three flexible workflows, backup/import procedure and student/teacher visible states.

### Task 8: Review, integrate, deploy and verify

- [ ] **Step 1: Complete verification**

Run full server, web and Skill tests; TypeScript; production web build; syntax checks; `git diff --check`; and inspect logs/URLs for name leakage. Self-review all transaction, authorization and privacy paths. No independent subagent is used because the active session forbids spawning one.

- [ ] **Step 2: Integrate without losing the existing dirty worktree**

Commit this branch in scoped changes. In the main worktree, save unrelated local edits to a named stash, cherry-pick the verified commits, restore the stash, and manually preserve both sides of any overlap. Re-run the complete verification on the integrated tree and push `main` without force.

- [ ] **Step 3: Back up and deploy production**

Use server-vault credentials without printing them. Create a SQLite online backup before starting the new release. Deploy backend to a timestamped `/opt/vibehub-releases/<id>`, build/deploy frontend to `/var/www/vibehub-console/releases/<id>`, atomically switch the current symlink, restart and verify health.

- [ ] **Step 4: Import Shenzhen data**

Run the committed import helper once against production, verify 11 linked roster rows and 4 unassigned spare codes, and confirm existing projects/versions/tokens are unchanged. Do not delete production data.

- [ ] **Step 5: Production acceptance**

Verify `/healthz`, login/profile response shape, teacher roster counts, public privacy, self-hosted Skill assets, a live approved student project, and that a stale pending preview refetches into the live URL. Record release IDs, backup path and probe results in the handoff.
