import { db } from '../lib/db.js';
import { worksUrl } from '../lib/config.js';
import { resolveToken } from '../lib/auth.js';

function hasCampSession(req, campId) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = resolveToken(bearer || req.cookies?.vh_session);
  return token?.camp_id === campId;
}

/**
 * 公开端返回体是**白名单构造**的，不是把内部对象删字段。
 * 永远不会出现：邀请码、未发布版本、诊断报告、审核记录、真实姓名（除非可见性=realname）。
 */
export default async function publicRoutes(app) {
  app.get('/api/public/camps/:slug', async (req, reply) => {
    const camp = db.prepare('SELECT * FROM camps WHERE slug=?').get(req.params.slug);
    // camp_only 必须有课程内会话；公开接口不接受会话时一律 404，避免泄露集合存在。
    if (!camp || !camp.collection_published || (camp.visibility_default === 'camp_only' && !hasCampSession(req, camp.id))) {
      return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个作品集合。' } });
    }

    const rows = db.prepare(`
      SELECT p.id,p.slug,p.title,p.tagline,p.category,p.cover_url,p.visibility,p.updated_at,
             p.collection_order,p.collection_recommended,
             u.username,u.display_name,u.real_name,u.avatar_url,
             v.label
      FROM projects p
      JOIN users u ON u.id=p.owner_user_id
      LEFT JOIN versions v ON v.id=p.live_version_id
      WHERE p.camp_id=? AND p.publish_status IN ('published','published_with_pending')
        AND p.live_version_id IS NOT NULL
      ORDER BY p.collection_recommended DESC,p.collection_order ASC,p.updated_at DESC`).all(camp.id);

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

  app.get('/api/public/projects/:slug', async (req, reply) => {
    const row = db.prepare(`
      SELECT p.id,p.slug,p.title,p.tagline,p.category,p.cover_url,p.visibility,p.updated_at,
             u.username,u.display_name,u.real_name,u.avatar_url,
             c.id AS camp_id,c.slug AS camp_slug,c.name AS camp_name,c.visibility_default,
             v.label
      FROM projects p
      JOIN users u ON u.id=p.owner_user_id
      JOIN camps c ON c.id=p.camp_id
      JOIN versions v ON v.id=p.live_version_id
      WHERE p.slug=? AND p.publish_status IN ('published','published_with_pending')
        AND p.live_version_id IS NOT NULL
      ORDER BY p.updated_at DESC LIMIT 1`).get(req.params.slug);
    const visibility = row?.visibility || row?.visibility_default;
    if (!row || ((visibility === 'camp_only' || row.visibility_default === 'camp_only') && !hasCampSession(req, row.camp_id))) {
      return reply.code(404).send({ error: { code: 'not_found', message: '找不到这个作品。' } });
    }
    const views = db.prepare('SELECT COALESCE(SUM(views),0) AS n FROM page_views WHERE project_id=?').get(row.id);
    return {
      project: {
        slug: row.slug, title: row.title, tagline: row.tagline, category: row.category, cover_url: row.cover_url,
        author: visibility === 'realname' ? (row.real_name || row.display_name) : row.display_name,
        avatar_url: row.avatar_url, version: row.label, views: Number(views?.n || 0),
        url: worksUrl(row.username, row.slug), updated_at: row.updated_at,
      },
      camp: { slug: row.camp_slug, name: row.camp_name },
    };
  });
}
