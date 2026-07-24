import { db } from '../lib/db.js';
import { worksUrl } from '../lib/config.js';

/**
 * 公开端返回体是**白名单构造**的，不是把内部对象删字段。
 * 永远不会出现：邀请码、未发布版本、诊断报告、审核记录、真实姓名（除非可见性=realname）。
 */
export default async function publicRoutes(app) {
  app.get('/api/public/camps/:slug', async (req, reply) => {
    const camp = db.prepare('SELECT * FROM camps WHERE slug=?').get(req.params.slug);
    if (!camp || !camp.collection_published) {
      return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个作品集合。' } });
    }

    const rows = db.prepare(`
      SELECT p.id,p.slug,p.title,p.tagline,p.category,p.cover_url,p.visibility,p.updated_at,
             u.username,u.display_name,u.real_name,u.avatar_url,
             v.label
      FROM projects p
      JOIN users u ON u.id=p.owner_user_id
      LEFT JOIN versions v ON v.id=p.live_version_id
      WHERE p.camp_id=? AND p.publish_status IN ('published','published_with_pending')
        AND p.live_version_id IS NOT NULL
      ORDER BY p.updated_at DESC`).all(camp.id);

    const items = rows
      .filter((r) => (r.visibility || camp.visibility_default) !== 'camp_only')
      .map((r) => {
        const vis = r.visibility || camp.visibility_default;
        const views = db.prepare('SELECT COALESCE(SUM(views),0) AS n FROM page_views WHERE project_id=?').get(r.id);
        return {
          slug: r.slug, title: r.title, tagline: r.tagline,
          category: r.category, cover_url: r.cover_url,
          // 决策 5：默认只展示昵称
          author: vis === 'realname' ? (r.real_name || r.display_name) : r.display_name,
          avatar_url: r.avatar_url,
          version: r.label, views: Number(views?.n || 0),
          url: worksUrl(r.username, r.slug),
          updated_at: r.updated_at,
        };
      });

    const members = db.prepare('SELECT COUNT(*) AS n FROM camp_members WHERE camp_id=?').get(camp.id);
    return {
      camp: { slug: camp.slug, name: camp.name, kind: camp.kind, theme: camp.theme, intro: camp.intro, cover_url: camp.cover_url },
      stats: {
        published: items.length,
        creators: Number(members?.n || 0),
        categories: [...new Set(items.map((i) => i.category).filter(Boolean))].length,
      },
      categories: [...new Set(items.map((i) => i.category).filter(Boolean))],
      items,
      updated_at: items[0]?.updated_at ?? null,
    };
  });
}
