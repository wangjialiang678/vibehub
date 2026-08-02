import { db, now } from '../lib/db.js';
import { isTeacher } from '../lib/auth.js';
import { previewUrl } from '../lib/config.js';
import { issuePreviewClaim, verifyPreviewClaim } from '../lib/preview-claims.js';

function activePreview(previewId) {
  return db.prepare(`
    SELECT v.id AS version_id,v.project_id,v.preview_id,v.artifact_pruned,
           p.camp_id,p.owner_user_id,p.pending_version_id,
           (SELECT r.status FROM reviews r WHERE r.version_id=v.id ORDER BY r.created_at DESC LIMIT 1) AS review_status
    FROM versions v JOIN projects p ON p.id=v.project_id
    WHERE v.preview_id=?`).get(previewId);
}

function isActive(row) {
  return row && !row.artifact_pruned && row.pending_version_id === row.version_id &&
    (row.review_status === null || row.review_status === 'pending');
}

function identityCanPreview(row, identity) {
  if (!row || !identity || identity.camp_id !== row.camp_id) return false;
  const membership = db.prepare('SELECT role FROM camp_members WHERE camp_id=? AND user_id=?')
    .get(row.camp_id, identity.user_id);
  if (!membership || membership.role !== identity.role) return false;
  const owner = identity.user_id === row.owner_user_id && identity.project_id === row.project_id;
  if (owner) return true;
  if (!isTeacher(identity.role)) return false;
  return isTeacher(membership?.role);
}

export function createPreviewGrant(previewId, identity) {
  const row = activePreview(previewId);
  if (!identity?.id || !isActive(row) || !identityCanPreview(row, identity)) return null;
  const issued = issuePreviewClaim({ previewId, versionId: row.version_id, projectId: row.project_id, identity });
  const url = new URL(previewUrl(previewId));
  url.searchParams.set('claim', issued.claim);
  return { preview_url: url.toString(), expires_at: issued.expiresAt };
}

export function authorizePreviewRequest(previewId, claim) {
  const payload = verifyPreviewClaim(claim, previewId);
  if (!payload) return null;
  const issuer = db.prepare(`SELECT * FROM tokens WHERE id=? AND revoked_at IS NULL
                             AND (expires_at IS NULL OR expires_at>=?)`).get(payload.issuer_token_id, now());
  if (!issuer || issuer.user_id !== payload.sub || issuer.camp_id !== payload.camp_id ||
      (issuer.project_id || null) !== (payload.scope_project_id || null) || issuer.role !== payload.role) return null;
  const row = activePreview(previewId);
  const identity = {
    id: issuer.id,
    user_id: issuer.user_id,
    camp_id: issuer.camp_id,
    project_id: issuer.project_id,
    role: issuer.role,
  };
  if (!isActive(row) || row.version_id !== payload.vid || row.project_id !== payload.project_id ||
      !identityCanPreview(row, identity)) return null;
  return { ...row, expiresAt: new Date(payload.exp * 1000).toISOString(), maxAge: Math.max(1, payload.exp - Math.floor(Date.now() / 1000)) };
}

export const previewCookieName = (previewId) => `vh_preview_${previewId}`;
