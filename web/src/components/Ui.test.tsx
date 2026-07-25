import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewFrame, WorkThumbnail } from './Ui';

describe('作品 iframe', () => {
  it('保留作品真实 origin，同时继续限制脚本以外的能力', () => {
    const preview = renderToStaticMarkup(<PreviewFrame url="https://works.example/vibehub/_preview/p1/" title="审核预览" />);
    const thumbnail = renderToStaticMarkup(<WorkThumbnail url="https://works.example/vibehub/learner/work/" title="缩略图" />);

    for (const markup of [preview, thumbnail]) {
      expect(markup).toContain('sandbox="allow-scripts allow-forms allow-popups allow-same-origin"');
    }
  });
});
