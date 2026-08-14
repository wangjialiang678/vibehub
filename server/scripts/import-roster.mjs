#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { db } from '../src/lib/db.js';
import { IdentityError, importRosterEntries } from '../src/services/student-identity.js';

function parseArgs(args) {
  let campSlug = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--camp') campSlug = args[++i];
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  if (!campSlug) throw new Error('missing --camp');
  return campSlug;
}

try {
  const campSlug = parseArgs(process.argv.slice(2));
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(payload?.entries)) throw new Error('stdin must contain {"entries": [...]}');
  const camp = db.prepare('SELECT id FROM camps WHERE slug=?').get(campSlug);
  if (!camp) throw new Error('camp not found');
  const result = importRosterEntries({ campId: camp.id, entries: payload.entries, actorUserId: null });
  const linked = db.prepare(`SELECT COUNT(*) AS n FROM invites WHERE camp_id=? AND roster_entry_id IS NOT NULL`).get(camp.id).n;
  process.stdout.write(`${JSON.stringify({ ok: true, processed: result.items.length, created: result.created, linked })}\n`);
} catch (error) {
  const code = error instanceof IdentityError ? error.code : 'import_failed';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}
