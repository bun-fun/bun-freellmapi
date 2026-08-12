import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { jsonResponse } from './json.js';

export interface AuthUser {
  id: number;
  username: string;
}

type AuthSuccess = { ok: true; user: AuthUser };
type AuthFailure = { ok: false; response: Response };
export type AuthResult = AuthSuccess | AuthFailure;

export function authenticateRequest(req: Request): AuthResult {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, response: jsonResponse({ error: { message: 'Authentication required' } }, 401) };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { ok: false, response: jsonResponse({ error: { message: 'Authentication required' } }, 401) };
  }

  const db = getDb();
  // sessions may have either the baseline columns (token / expires_at) or the
  // migration columns (token_hash / expires_at_ms) — query whichever exists.
  const colInfo = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  const hasTokenHash = colInfo.some(c => c.name === 'token_hash');
  if (hasTokenHash) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const session = db.prepare(`
      SELECT s.user_id, u.email AS username FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at_ms > ?
    `).get(hash, Date.now()) as { user_id: number; username: string } | undefined;
    if (!session) {
      return { ok: false, response: jsonResponse({ error: { message: 'Invalid or expired session' } }, 401) };
    }
    return { ok: true, user: { id: session.user_id, username: session.username } };
  }
  const session = db.prepare(`
    SELECT s.user_id, u.username FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token) as { user_id: number; username: string } | undefined;

  if (!session) {
    return { ok: false, response: jsonResponse({ error: { message: 'Invalid or expired session' } }, 401) };
  }

  return { ok: true, user: { id: session.user_id, username: session.username } };
}
