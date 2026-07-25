import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as presentation from './lib/presentation';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('视觉对齐回归', () => {
  it('keeps the student operations panel as three metrics without invented data', () => {
    const source = readSource('./pages/StudentPage.tsx');

    expect(source).toContain('className="stats-metrics"');
    expect(source).toContain('今日浏览');
    expect(source).toContain('独立访客');
    expect(source).toContain('近 7 天');
    expect(source).toContain('>—<');
  });

  it('keeps every diagnosis item and gives it a dimension icon', () => {
    const source = readSource('./pages/StudentPage.tsx');

    expect(source).toContain('<DiagnosisIcon');
    expect(source).toContain('className="diagnosis-icon"');
    expect(source).not.toContain('diagnosis.items.slice');
  });

  it('uses status words as the teacher summary primary line while retaining score evidence', () => {
    const getReviewSummary = Reflect.get(presentation, 'getReviewSummary') as undefined | ((item: unknown, dimension: 'frontend' | 'backend') => { value: string; detail?: string });

    expect(getReviewSummary).toEqual(expect.any(Function));
    expect(getReviewSummary?.({ earned_points: 20, max_points: 20, evidence_level: 'verified' }, 'frontend')).toEqual({ value: '已完成', detail: '20/20 分 · ✓已验证' });
    expect(getReviewSummary?.({ earned_points: 10, max_points: 20, evidence_level: 'verified' }, 'backend')).toEqual({ value: '已连接', detail: '10/20 分 · ✓已验证' });
    expect(getReviewSummary?.({ applicability: 'not_applicable', earned_points: 0, max_points: 20 }, 'backend')).toEqual({ value: '不适用' });
  });

  it('renders sidebar navigation with local linear SVG icons', () => {
    const source = readSource('./components/Shell.tsx');
    const styles = readSource('./styles.css');

    expect(source).toContain('<SidebarIcon');
    expect(source).toContain('fill="none"');
    expect(source).toContain('stroke="currentColor"');
    expect(styles).toContain('.side-nav-icon { width: 20px; height: 20px; flex: 0 0 20px; display: grid; place-items: center; color: var(--ink-soft); }');
    expect(styles).not.toContain('.side-nav-item.is-active .side-nav-icon { color: var(--coral); }');
  });
});
