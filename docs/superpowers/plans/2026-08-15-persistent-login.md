# Persistent Web Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one successful VibeHub web login persist on the same browser until logout, browser data removal, or invite/session revocation.

**Architecture:** Keep the existing opaque, revocable database token model. Web tokens no longer receive a fixed server expiry; the host-only HttpOnly cookie uses a 400-day browser-compatible lifetime and is renewed after every successful cookie-authenticated request, while active legacy 12-hour sessions are upgraded in place. Skill/Bearer authentication is unchanged.

**Tech Stack:** Fastify, `@fastify/cookie`, Node SQLite, React, Vitest, Node test runner.

---

## File structure

- `server/src/lib/auth.js`: owns persistent web-cookie options and successful-cookie-session renewal.
- `server/src/services/invite-access.js`: issues new web tokens without a fixed expiry.
- `server/src/index.js`: applies the shared persistent cookie policy at login.
- `server/test/persistent-session.test.js`: isolates the web-session security and migration contract from unrelated route tests.
- `web/src/pages/LoginPage.tsx`: explains that the current browser remembers the user and warns about shared computers.
- `web/src/persistent-login.test.tsx`: renders the real login page and checks the user-facing contract.
- `web/src/styles.css`: styles the small login security notice.
- `docs/specs/api.md`: documents persistent, revocable, sliding web sessions.
- `docs/handbook/deployment.md`: adds the production persistent-session probe.

### Task 1: Persistent and revocable backend sessions

**Files:**
- Create: `server/test/persistent-session.test.js`
- Modify: `server/src/lib/auth.js`
- Modify: `server/src/services/invite-access.js`
- Modify: `server/src/index.js`

- [ ] **Step 1: Write the failing backend tests**

Create a dedicated test app/data directory. Test that login returns a `vh_session` cookie with `Max-Age=34560000`, `HttpOnly`, `SameSite=Lax`, and `Path=/`; the stored web token has `expires_at IS NULL`; a cookie-authenticated `/api/me` response renews the cookie; a Bearer-authenticated request does not set a cookie; a still-valid legacy web token with a fixed expiry is changed to `expires_at=NULL`; expired and revoked tokens remain unauthorized; logout clears and revokes the token; invite revocation invalidates it.

- [ ] **Step 2: Run the backend test and verify RED**

Run:

```bash
PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH node --test test/persistent-session.test.js
```

Expected: failures for missing long-lived cookie, fixed 12-hour token expiry, missing renewal, and missing legacy upgrade.

- [ ] **Step 3: Add the shared cookie policy and renewal**

In `server/src/lib/auth.js`, export:

```js
export const WEB_SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
export function webSessionCookieOptions() {
  return {
    path: '/', httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: WEB_SESSION_MAX_AGE_SECONDS,
  };
}
```

After token, CSRF, and role checks succeed in `authRequired`, when the credential source is Cookie and `tok.kind === 'web'`, clear a legacy non-null `expires_at` by token id and call `reply.setCookie('vh_session', raw, webSessionCookieOptions())`. Do not renew Bearer/Skill requests or invalid credentials.

- [ ] **Step 4: Issue new web tokens without fixed expiry and use shared cookie options**

Remove the 12-hour `expiresAt` assignment from `bindInvite`; both web and Skill tokens retain the `issueToken` default `null` expiry. Import `webSessionCookieOptions` in `server/src/index.js` and use it for the successful redeem cookie. Keep logout revocation and `Path=/` clearing unchanged.

- [ ] **Step 5: Run focused backend tests and verify GREEN**

Run:

```bash
PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH node --test test/persistent-session.test.js test/auth-security.test.js
```

Expected: all focused tests pass with zero skips/failures.

- [ ] **Step 6: Commit backend behavior**

```bash
git add server/src/lib/auth.js server/src/services/invite-access.js server/src/index.js server/test/persistent-session.test.js
git commit -m "feat: persist revocable web sessions"
```

### Task 2: Explain remembered identity on the login page

**Files:**
- Create: `web/src/persistent-login.test.tsx`
- Modify: `web/src/pages/LoginPage.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write the failing frontend test**

Render `LoginPage` inside a `QueryClientProvider` and `MemoryRouter`. Assert that the form contains “登录后会在这台设备上记住你” and “公用电脑” plus “退出登录”, and does not present a 30-day limit or duration selector.

- [ ] **Step 2: Run the frontend test and verify RED**

Run:

```bash
PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH npx vitest run src/persistent-login.test.tsx
```

Expected: the remembered-identity copy is absent.

- [ ] **Step 3: Add the login notice**

Add this form-adjacent notice without adding a checkbox or duration control:

```tsx
<p className="session-note">登录后会在这台设备上记住你。使用公用电脑时，请在使用后退出登录。</p>
```

Style `.session-note` as quiet supporting text with sufficient contrast and spacing.

- [ ] **Step 4: Run focused frontend tests and verify GREEN**

Run:

```bash
PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH npx vitest run src/persistent-login.test.tsx src/student-identity.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit the frontend behavior**

```bash
git add web/src/pages/LoginPage.tsx web/src/styles.css web/src/persistent-login.test.tsx
git commit -m "feat: explain persistent login on device"
```

### Task 3: Synchronize API and operations documentation

**Files:**
- Modify: `docs/specs/api.md`
- Modify: `docs/handbook/deployment.md`

- [ ] **Step 1: Replace the obsolete 12-hour contract**

Document that web sessions are revocable, have no fixed server expiry, use a browser-compatible long-lived Cookie, renew after successful Cookie authentication, and are invalidated by logout or invite revocation. State that Skill tokens are unchanged.

- [ ] **Step 2: Add a deployment probe**

Document a safe probe that checks `Set-Cookie` for `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure`, and positive long `Max-Age` without printing the cookie value. Include a follow-up authenticated request check for sliding renewal and logout invalidation.

- [ ] **Step 3: Verify documentation consistency and commit**

Run:

```bash
rg -n "12 小时|12小时|30 天|30天" docs/specs/api.md docs/handbook/deployment.md
git diff --check
```

Expected: no active 12-hour/30-day web-session contract remains; diff check passes.

```bash
git add docs/specs/api.md docs/handbook/deployment.md
git commit -m "docs: document persistent web sessions"
```

### Task 4: Full verification, review, integration, and production release

**Files:**
- Review all files changed by Tasks 1–3.

- [ ] **Step 1: Run complete verification with the project-compatible Node runtime**

Run server and web suites, TypeScript, production build, syntax checks, and `git diff --check`. Expected: zero test failures/skips, TypeScript/build exit 0, syntax checks exit 0.

- [ ] **Step 2: Perform code review**

Verify assumptions, security attributes, invalid/revoked-token behavior, logout behavior, no token leakage, no Skill behavior change, and documentation consistency. Fix any Critical/Important issue and rerun focused plus full verification.

- [ ] **Step 3: Integrate without overwriting unrelated main-worktree changes**

Fast-forward `main` to the feature branch only if the dirty files in the main worktree do not overlap this feature. Verify the unrelated Shanghai-camp changes remain byte-for-byte present and unstaged.

- [ ] **Step 4: Deploy atomically and verify production**

Follow `docs/handbook/deployment.md`: back up the production database, create a timestamped backend/frontend release, atomically switch release pointers, restart `vibehub`, and verify health. Use the Michael teacher invite only inside a no-echo probe; confirm persistent cookie attributes, authenticated renewal, logout invalidation, and unchanged roster counts, then remove all temporary cookie/probe files.

