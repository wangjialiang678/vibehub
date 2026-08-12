const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function createSubmissionGuard({ clock = Date.now } = {}) {
  const active = new Set();
  const attempts = new Map();

  function recentAttempts(projectId, at) {
    const recent = (attempts.get(projectId) || []).filter((time) => at - time < WINDOW_MS);
    if (recent.length) attempts.set(projectId, recent);
    else attempts.delete(projectId);
    return recent;
  }

  return {
    acquire(projectId) {
      const at = clock();
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
  };
}

export const browserSubmissionGuard = createSubmissionGuard();
