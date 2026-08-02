import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewFrame, WorkThumbnail } from './Ui';

describe('作品 iframe', () => {
  it('未授权的裸预览地址不会直接写进 iframe', () => {
    const preview = renderToStaticMarkup(<PreviewFrame url="https://works.example/vibehub/_preview/p1/" title="审核预览" />);
    expect(preview).not.toContain('src="https://works.example/vibehub/_preview/p1/"');
    expect(preview).toContain('正在准备安全预览');
  });

  it('正式作品保持公开 iframe，并继续限制脚本以外的能力', () => {
    const preview = renderToStaticMarkup(<PreviewFrame url="https://works.example/vibehub/learner/work/" title="审核预览" />);
    const thumbnail = renderToStaticMarkup(<WorkThumbnail url="https://works.example/vibehub/learner/work/" title="缩略图" />);

    for (const markup of [preview, thumbnail]) {
      expect(markup).toContain('sandbox="allow-scripts allow-forms allow-popups allow-same-origin"');
    }
  });
});
