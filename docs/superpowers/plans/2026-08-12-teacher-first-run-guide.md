# Teacher First-Run Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a teacher's first VibeHub login explain the management workspace, lead directly to student invitations, and keep contextual help available throughout the camp lifecycle.

**Architecture:** Redirect teacher sessions to the overview, derive journey progress from the existing overview API, and persist only the expanded first-run presentation in browser storage keyed by teacher and camp. Add focused React components for the welcome/journey card and help drawer, while keeping invitation generation and all authorization rules unchanged.

**Tech Stack:** React 18, React Router, TanStack Query, TypeScript, hand-written CSS, Fastify, SQLite, Vitest, Node test runner.

---

## File map

- Create `web/src/lib/teacherGuide.ts`: pure progress, storage-key, and share-copy helpers.
- Create `web/src/lib/teacherGuide.test.ts`: unit coverage for all pure guide behavior.
- Create `web/src/components/TeacherGuide.tsx`: first-run welcome, ongoing journey card, and help drawer.
- Create `web/src/components/TeacherGuide.test.tsx`: static markup coverage for guide content and actions.
- Modify `web/src/lib/presentation.ts`: send teachers to the overview after login.
- Modify `web/src/lib/presentation.test.ts`: lock the new login destination.
- Modify `web/src/components/Shell.tsx`: task-language navigation and persistent help trigger.
- Modify `web/src/components/TeacherPage.tsx`: provide teacher identity and help state through the shared shell.
- Modify `web/src/pages/AdminOverviewPage.tsx`: place first-run guidance before metrics and improve no-data actions.
- Modify `web/src/pages/AdminInvitesPage.tsx`: student-first copy, one-batch export, and shareable instructions.
- Modify `web/src/pages/AdminProjectsPage.tsx`: actionable empty states.
- Modify `web/src/pages/AdminPage.tsx`: actionable empty review state.
- Modify `web/src/styles.css`: responsive guide, task card, drawer, and invitation-success styles.
- Modify `web/src/lib/types.ts`: add student invitation counts to `CampOverview`.
- Modify `server/src/routes/admin.js`: return role-filtered student invitation counts.
- Modify `server/test/routes.test.js`: verify teacher invitation codes do not complete the student-invite step.
- Modify `web/src/teacher-features.test.ts`: assert routes, navigation labels, guide entry points, and invitation copy.
- Modify `docs/guide/index.html`: align teacher instructions with the new in-product guidance.

### Task 1: Pure guide behavior and teacher login destination

**Files:**
- Create: `web/src/lib/teacherGuide.ts`
- Create: `web/src/lib/teacherGuide.test.ts`
- Modify: `web/src/lib/presentation.test.ts`
- Modify: `web/src/lib/presentation.ts`

- [ ] **Step 1: Write failing tests for the teacher destination and journey state**

```ts
expect(postLoginPath('teacher')).toBe('/admin/overview');
expect(postLoginPath('admin')).toBe('/admin/overview');

expect(teacherGuideStorageKey('u_1', 'c_1')).toBe('vh:teacher-guide:u_1:c_1');
expect(getTeacherJourney({
  student_invites_total: 0,
  student_invites_bound: 0,
  projects: 0,
  pending_review: 0,
  published: 0,
})).toMatchObject({ completed: 0, total: 3 });
expect(getTeacherJourney({
  student_invites_total: 10,
  student_invites_bound: 8,
  projects: 5,
  pending_review: 2,
  published: 1,
})).toMatchObject({ completed: 3, total: 3 });
expect(studentInviteMessage('测试营地')).toContain('每人使用一个邀请码');
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `cd web && npm test -- src/lib/presentation.test.ts src/lib/teacherGuide.test.ts`

Expected: failure because `teacherGuide.ts` does not exist and the old teacher destination is `/admin`.

- [ ] **Step 3: Implement the pure helpers and route change**

```ts
export type TeacherJourneyCounts = {
  student_invites_total: number;
  student_invites_bound: number;
  projects: number;
  pending_review: number;
  published: number;
};

export function teacherGuideStorageKey(userId: string, campId: string) {
  return `vh:teacher-guide:${userId}:${campId}`;
}

export function getTeacherJourney(counts: TeacherJourneyCounts) {
  const steps = [
    { key: 'invite', complete: counts.student_invites_total > 0 },
    { key: 'projects', complete: counts.projects > 0 },
    { key: 'publish', complete: counts.published > 0 },
  ];
  return { steps, completed: steps.filter((step) => step.complete).length, total: steps.length };
}

export function studentInviteMessage(campName: string) {
  return `欢迎加入「${campName}」。请使用老师单独发给你的邀请码进入 VibeHub。每人使用一个邀请码，请不要转发给其他同学。进入后，按照页面提示把自己的项目接入营地。`;
}
```

Change `postLoginPath` so teacher and admin roles return `/admin/overview`.

- [ ] **Step 4: Run focused tests and confirm success**

Run: `cd web && npm test -- src/lib/presentation.test.ts src/lib/teacherGuide.test.ts`

Expected: both test files pass.

- [ ] **Step 5: Commit the behavior slice**

```bash
git add web/src/lib/presentation.ts web/src/lib/presentation.test.ts web/src/lib/teacherGuide.ts web/src/lib/teacherGuide.test.ts
git commit -m "feat: route teachers into guided overview"
```

### Task 2: Student-specific overview progress data

**Files:**
- Modify: `server/test/routes.test.js`
- Modify: `server/src/routes/admin.js`
- Modify: `web/src/lib/types.ts`

- [ ] **Step 1: Add a failing route test**

Create a teacher session, insert one teacher invite and two student invites, bind one student invite, request `/api/camps/:campId/overview`, and assert:

```js
assert.equal(body.counts.student_invites_total, 2);
assert.equal(body.counts.student_invites_bound, 1);
```

- [ ] **Step 2: Run the route test and confirm failure**

Run: `cd server && npm test -- --test-name-pattern="总览区分学员邀请码"`

Expected: the two new properties are undefined.

- [ ] **Step 3: Add role-filtered subqueries and matching TypeScript fields**

Add to the overview query:

```sql
(SELECT COUNT(*) FROM invites WHERE camp_id=$c AND role='student') AS student_invites_total,
(SELECT COUNT(*) FROM invites WHERE camp_id=$c AND role='student' AND status='bound') AS student_invites_bound,
```

Add both numeric properties to `CampOverview['counts']`.

- [ ] **Step 4: Run focused server and web type validation**

Run: `cd server && npm test -- --test-name-pattern="总览区分学员邀请码"`

Expected: pass.

Run: `cd web && npm run build`

Expected: build passes.

- [ ] **Step 5: Commit the data slice**

```bash
git add server/src/routes/admin.js server/test/routes.test.js web/src/lib/types.ts
git commit -m "feat: expose student invite progress"
```

### Task 3: First-run welcome and ongoing journey card

**Files:**
- Create: `web/src/components/TeacherGuide.tsx`
- Create: `web/src/components/TeacherGuide.test.tsx`
- Modify: `web/src/pages/AdminOverviewPage.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing static markup tests**

Render the first-run component with zero counts and assert it contains:

```ts
expect(markup).toContain('这是你的营地管理后台');
expect(markup).toContain('开始邀请学员');
expect(markup).toContain('邀请学员加入');
expect(markup).toContain('跟进和审核作品');
expect(markup).toContain('展示营地成果');
```

Render the compact journey with non-zero counts and assert it contains “已有 8 位学员加入”, “有 2 个作品等待审核”, and links to `/admin/invites`, `/admin/projects`, `/admin`, and `/c/test-camp`.

- [ ] **Step 2: Run the component test and confirm failure**

Run: `cd web && npm test -- src/components/TeacherGuide.test.tsx`

Expected: failure because the component does not exist.

- [ ] **Step 3: Implement the guide components**

Create `TeacherWelcome` and `TeacherJourneyCard` in a focused file. `TeacherWelcome` reads the keyed browser state inside an effect, shows the expanded introduction when unseen, and marks it seen before either action. `TeacherJourneyCard` is always rendered below it, uses `getTeacherJourney`, and exposes direct route links.

Integrate both at the top of `AdminOverviewPage` before the metric grid using `session.user.id`, `session.camp.id`, `session.camp.name`, and the overview counts. Change the overview header action label to “邀请学员”.

- [ ] **Step 4: Add responsive styling**

Add isolated classes prefixed with `teacher-guide-` and `teacher-journey-`. Desktop welcome uses a two-column explanation/action layout; under 780px it becomes one column. Keep the primary coral action visually dominant and give completed steps both a check mark and “已完成” text.

- [ ] **Step 5: Run focused tests and production build**

Run: `cd web && npm test -- src/components/TeacherGuide.test.tsx src/lib/teacherGuide.test.ts && npm run build`

Expected: tests and build pass.

- [ ] **Step 6: Commit the overview experience**

```bash
git add web/src/components/TeacherGuide.tsx web/src/components/TeacherGuide.test.tsx web/src/pages/AdminOverviewPage.tsx web/src/styles.css
git commit -m "feat: guide teachers through first camp setup"
```

### Task 4: Persistent help drawer and task-language navigation

**Files:**
- Modify: `web/src/components/TeacherGuide.tsx`
- Modify: `web/src/components/TeacherGuide.test.tsx`
- Modify: `web/src/components/Shell.tsx`
- Modify: `web/src/teacher-features.test.ts`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Update source and markup tests to describe the new navigation**

Assert the shell contains labels “营地总览”, “邀请学员”, “学员项目”, “作品审核”, “成果展示”, and “使用帮助”. Assert the help drawer markup contains the four task sections and real route targets.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cd web && npm test -- src/teacher-features.test.ts src/components/TeacherGuide.test.tsx`

Expected: failures for missing labels and drawer.

- [ ] **Step 3: Implement shell-level help state**

For teacher shells, add the invitation route to the primary navigation and rename all five labels. Add a bottom help button that opens `TeacherHelpDrawer`. The drawer renders in the shell so it is available on every teacher page. Close it from its close button, backdrop, or Escape key; its links close the drawer while navigating.

- [ ] **Step 4: Add drawer styles and mobile behavior**

Use a fixed backdrop and a right-aligned panel capped at 480px. On screens below 540px the panel fills the viewport width. Preserve visible focus outlines and disable page-obscuring decoration.

- [ ] **Step 5: Run tests and build**

Run: `cd web && npm test -- src/teacher-features.test.ts src/components/TeacherGuide.test.tsx && npm run build`

Expected: pass.

- [ ] **Step 6: Commit navigation and help**

```bash
git add web/src/components/TeacherGuide.tsx web/src/components/TeacherGuide.test.tsx web/src/components/Shell.tsx web/src/teacher-features.test.ts web/src/styles.css
git commit -m "feat: add teacher help throughout admin"
```

### Task 5: Invitation handoff and actionable empty states

**Files:**
- Modify: `web/src/pages/AdminInvitesPage.tsx`
- Modify: `web/src/pages/AdminOverviewPage.tsx`
- Modify: `web/src/pages/AdminProjectsPage.tsx`
- Modify: `web/src/pages/AdminPage.tsx`
- Modify: `web/src/teacher-features.test.ts`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add failing source assertions**

Assert the invite page contains “邀请学员加入营地”, “一个邀请码对应一位学员”, “复制发给学员的说明”, and “导出本批邀请码”. Assert the project and review empty states link to `/admin/invites` or `/admin/overview`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `cd web && npm test -- src/teacher-features.test.ts`

Expected: new assertions fail.

- [ ] **Step 3: Implement invitation handoff**

Keep the role select defaulted to student and add a concise explanation for role and device count. Generate a CSV Blob only from `revealedCodes` for “导出本批邀请码”; keep the existing full export action labeled “导出全部记录”. Use `studentInviteMessage(campName)` for the share-copy button, report copy/export success in the existing notice area, and preserve one-time code visibility.

- [ ] **Step 4: Implement actionable empty states**

Add direct links in empty overview/project states to `/admin/invites`. Add a “返回营地总览” link to the empty review queue. Keep the explanations explicit about when data will appear.

- [ ] **Step 5: Run all web tests and build**

Run: `cd web && npm test && npm run build`

Expected: all tests and the production build pass.

- [ ] **Step 6: Commit the handoff slice**

```bash
git add web/src/pages/AdminInvitesPage.tsx web/src/pages/AdminOverviewPage.tsx web/src/pages/AdminProjectsPage.tsx web/src/pages/AdminPage.tsx web/src/teacher-features.test.ts web/src/styles.css
git commit -m "feat: make teacher next actions explicit"
```

### Task 6: Documentation, full verification, and production release

**Files:**
- Modify: `docs/guide/index.html`
- Verify: `docs/handbook/deployment.md`

- [ ] **Step 1: Update the teacher guide facts**

Describe the new first-login overview, the “邀请学员” navigation entry, the one-batch export/share actions, the persistent “使用帮助” entry, and the data-driven journey card. Do not change student CLI instructions.

- [ ] **Step 2: Run repository checks**

Run: `cd web && npm test && npm run build`

Expected: all web tests pass and `dist/` builds.

Run: `cd server && npm test && npm run typecheck`

Expected: all server tests pass and typecheck exits zero.

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intended documentation changes remain.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/guide/index.html docs/superpowers/plans/2026-08-12-teacher-first-run-guide.md
git commit -m "docs: update teacher onboarding guide"
```

- [ ] **Step 4: Build and deploy using the documented atomic release flow**

Build the web app with `VITE_API_BASE=https://hub.supermind-ai.cn`, create a timestamped server release, install production dependencies, atomically switch `/opt/vibehub`, synchronize the console files, restart the service, and reload nginx only if its config changed. Preserve `/etc/vibehub/vibehub.env` and the production SQLite data directory.

- [ ] **Step 5: Perform production probes**

Verify `/healthz` returns success, `/login` returns the SPA, static assets return 200, and an authenticated teacher session lands on `/admin/overview`. Verify the welcome content, invitation page, help drawer, and mobile layout without generating or revoking a production invite.

- [ ] **Step 6: Record the release commit and final state**

Run `git status --short` and report the deployed commit, test counts, health status, and any production-only limitation. Do not declare success until the external probes pass.
