const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SWEEP_INTERVAL_MS = 60 * 1000;

export function createSubmissionGuard({ clock = Date.now } = {}) {
  const active = new Set();
  const attempts = new Map();
  let lastSweepAt = null;

  function recentAttempts(projectId, at) {
    const recent = (attempts.get(projectId) || []).filter((time) => at - time < WINDOW_MS);
    if (recent.length) attempts.set(projectId, recent);
    else attempts.delete(projectId);
    return recent;
  }

  function sweepExpiredAttempts(at) {
    if (lastSweepAt !== null && at - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = at;
    for (const projectId of attempts.keys()) recentAttempts(projectId, at);
  }

  return {
    acquire(projectId) {
      const at = clock();
      sweepExpiredAttempts(at);
      const recent = recentAttempts(projectId, at);
      if (active.has(projectId)) {
        return {
          ok: false,
          code: 'submission_in_progress',
          status: 409,
          message: '这个项目正在提交，请等待当前检查完成。',
        };
      }
      if (recent.length >= MAX_ATTEMPTS) {
        return {
          ok: false,
          code: 'submission_rate_limited',
          status: 429,
          message: '10 分钟内最多提交 5 次，请稍后再试。',
          retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (at - recent[0])) / 1000)),
        };
      }

      active.add(projectId);
      let released = false;
      let recorded = false;
      return {
        ok: true,
        recordAttempt() {
          if (recorded) return;
          recorded = true;
          const recordedAt = clock();
          attempts.set(projectId, [...recentAttempts(projectId, recordedAt), recordedAt]);
        },
        release() {
          if (released) return;
          released = true;
          active.delete(projectId);
        },
      };
    },
    snapshot() {
      return { activeProjects: active.size, trackedProjects: attempts.size };
    },
  };
}

export const browserSubmissionGuard = createSubmissionGuard();
