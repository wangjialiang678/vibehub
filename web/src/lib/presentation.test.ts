import { describe, expect, it } from 'vitest';
import * as presentation from './presentation';
import { diagnosisCompleteness, diagnosisEvidenceLabel, evidenceLabel, formatDateTime, formatDiagnosisPercentage, formatNumber, getDiagnosisState, getProjectStatus, postLoginPath } from './presentation';

describe('presentation helpers', () => {
  it('shows a friendly zero value instead of an empty statistic', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('uses a readable fallback when the API omits a timestamp', () => {
    expect(formatDateTime(null)).toBe('暂未记录');
  });

  it('shows both diagnosis percentages only after the checker has a result', () => {
    expect(formatDiagnosisPercentage(null)).toBe('—');
    expect(diagnosisCompleteness({ status: 'needs_work', completeness: 64, score: 99 })).toBe(64);
    expect(diagnosisCompleteness({ status: 'healthy', score: 82 })).toBe(82);
    expect(diagnosisCompleteness({ status: 'running', score: 82 })).toBeNull();
    expect(diagnosisCompleteness({ status: 'failed', score: 82 })).toBeNull();
  });

  it('renders non-applicable diagnosis items as not applicable rather than zero points', () => {
    expect(getDiagnosisState({ applicability: 'not_applicable', earned_points: 0, max_points: 20 })).toEqual({
      label: '不适用',
      muted: true,
      ratio: null,
    });
  });

  it('makes an undeclared core flow visibly pending human confirmation', () => {
    expect(diagnosisEvidenceLabel({
      check_key: 'core_flows', result: 'unknown', evidence_level: 'human_required',
      evidence: { declaration_status: 'undeclared' },
    })).toBe('未声明·待人工确认');
    expect(diagnosisEvidenceLabel({
      check_key: 'core_flows', result: 'unknown', evidence_level: 'human_required',
      evidence: { declaration_status: 'declared' },
    })).toBe('⚠需人工确认');
  });

  it('gives a project without a live version an explicit unpublished state', () => {
    expect(getProjectStatus({ publish_status: 'unpublished', pending_version: null })).toEqual({
      label: '还没有正式上线',
      tone: 'muted',
    });
  });

  it('uses the specified compact evidence labels', () => {
    expect(evidenceLabel('verified')).toBe('✓已验证');
    expect(evidenceLabel('human_required')).toBe('⚠需人工确认');
  });

  it('routes teacher sessions to the review desk', () => {
    expect(postLoginPath('teacher')).toBe('/admin');
    expect(postLoginPath('admin')).toBe('/admin');
    expect(postLoginPath('student')).toBe('/app');
  });

  it('gives every persisted review state a student-facing label', () => {
    const getVersionReviewStatus = Reflect.get(presentation, 'getVersionReviewStatus') as undefined | ((status?: string | null) => { label: string; tone: string });

    expect(getVersionReviewStatus).toEqual(expect.any(Function));
    expect(getVersionReviewStatus?.('pending')).toEqual({ label: '待审核', tone: 'warning' });
    expect(getVersionReviewStatus?.('approved')).toEqual({ label: '已通过', tone: 'success' });
    expect(getVersionReviewStatus?.('rejected')).toEqual({ label: '已退回', tone: 'danger' });
    expect(getVersionReviewStatus?.('superseded')).toEqual({ label: '已被后续提交替代', tone: 'muted' });
    expect(getVersionReviewStatus?.(null)).toEqual({ label: '尚未进入审核', tone: 'blue' });
  });

  it('只在有版本真正等待审核（pending）时轮询提交记录', () => {
    const getVersionHistoryPollInterval = Reflect.get(presentation, 'getVersionHistoryPollInterval') as undefined | ((input: { visible: boolean; reviewStatuses: Array<string | null | undefined> }) => number | false);

    expect(getVersionHistoryPollInterval).toEqual(expect.any(Function));
    expect(getVersionHistoryPollInterval?.({ visible: true, reviewStatuses: ['pending'] })).toBe(3000);
    expect(getVersionHistoryPollInterval?.({ visible: true, reviewStatuses: [null, 'approved'] })).toBe(false);
    // 空 status = blocker 版本没有 review（终态），不能永久轮询，否则学员停留即持续请求
    expect(getVersionHistoryPollInterval?.({ visible: true, reviewStatuses: [null] })).toBe(false);
    expect(getVersionHistoryPollInterval?.({ visible: false, reviewStatuses: ['pending'] })).toBe(false);
    expect(getVersionHistoryPollInterval?.({ visible: true, reviewStatuses: ['approved', 'rejected', 'superseded'] })).toBe(false);
  });
});
