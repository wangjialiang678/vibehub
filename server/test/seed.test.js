import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDirs = [];

after(() => dataDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test('种子数据包含有分类且可访问的已发布集合作品', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'vh-seed-'));
  dataDirs.push(dataDir);
  const env = { ...process.env, VIBEHUB_DATA_DIR: dataDir };
  execFileSync(process.execPath, ['src/seed.js'], { cwd: process.cwd(), env, stdio: 'ignore' });
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { db } from './src/lib/db.js';
    import { paths } from './src/lib/config.js';
    const item = db.prepare(\"SELECT p.category,p.publish_status,p.live_version_id,v.preview_id FROM projects p JOIN versions v ON v.id=p.live_version_id WHERE p.slug='city-notes'\").get();
    console.log(JSON.stringify({ ...item, exists: existsSync(join(paths.sites, 'city-walker', 'city-notes', 'index.html')) }));
  `], { cwd: process.cwd(), env, encoding: 'utf8' });
  const item = JSON.parse(output);

  assert.equal(item.category, '城市与生活');
  assert.equal(item.publish_status, 'published');
  assert.match(item.preview_id, /^[a-z0-9]{16}$/);
  assert.equal(item.exists, true);
});
