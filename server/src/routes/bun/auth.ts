import { getDb } from '../../db/index.js';
import { jsonResponse, parseJson } from '../../lib/json.js';
import { authenticateRequest } from '../../lib/auth.js';
import crypto from 'crypto';

export async function authRoute(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  // GET /api/auth/status — check if setup is needed and if caller is authenticated
  if (path === '/api/auth/status' && req.method === 'GET') {
    const db = getDb();
    const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
    const needsSetup = userCount.cnt === 0;

    let authenticated = false;
    let email: string | null = null;

    const authHeader = req.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        const session = db.prepare(`
          SELECT u.username FROM sessions s
          JOIN users u ON s.user_id = u.id
          WHERE s.token = ? AND s.expires_at > datetime('now')
        `).get(token) as { username: string } | undefined;
        if (session) {
          authenticated = true;
          email = session.username;
        }
      }
    }

    return jsonResponse({ needsSetup, authenticated, email });
  }

  // POST /api/auth/login — accepts { email, password }, email maps to username
  if (path === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await parseJson(req);
      const { email, password } = body;

      if (!email || !password) {
        return jsonResponse({ error: { message: 'Email and password required' } }, 400);
      }

      const db = getDb();
      // Client sends "email" but the Bun fork uses "username" (default: "admin")
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(email) as any;

      if (!user) {
        return jsonResponse({ error: { message: 'Invalid email or password', type: 'authentication_error' } }, 401);
      }

      const derived = crypto.pbkdf2Sync(password, user.salt, 100000, 64, 'sha512').toString('hex');
      if (derived !== user.password_hash) {
        return jsonResponse({ error: { message: 'Invalid email or password', type: 'authentication_error' } }, 401);
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);

      return jsonResponse({
        token,
        email: user.username,
      });
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  // POST /api/auth/setup — first-run account creation
  if (path === '/api/auth/setup' && req.method === 'POST') {
    try {
      const db = getDb();
      const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
      if (userCount.cnt > 0) {
        return jsonResponse({ error: { message: 'Setup already completed. Use login instead.', type: 'setup_complete' } }, 409);
      }

      const body = await parseJson(req);
      const { email, password } = body;

      if (!email || !password) {
        return jsonResponse({ error: { message: 'Email and password required' } }, 400);
      }

      if (password.length < 8) {
        return jsonResponse({ error: { message: 'Password must be at least 8 characters' } }, 400);
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').run(email, hash, salt);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const userRow = db.prepare('SELECT id FROM users WHERE username = ?').get(email) as { id: number };
      db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(userRow.id, token, expiresAt);

      return jsonResponse({ token, email }, 201);
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  // GET /api/auth/me
  if (path === '/api/auth/me' && req.method === 'GET') {
    const auth = authenticateRequest(req);
    if (!auth.ok) return auth.response;
    return jsonResponse({ user: auth.user, email: auth.user.username });
  }

  // POST /api/auth/logout
  if (path === '/api/auth/logout' && req.method === 'POST') {
    const authHeader = req.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        const db = getDb();
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      }
    }
    return jsonResponse({ success: true });
  }

  // POST /api/auth/change-password
  if (path === '/api/auth/change-password' && req.method === 'POST') {
    const auth = authenticateRequest(req);
    if (!auth.ok) return auth.response;

    try {
      const body = await parseJson(req);
      const { currentPassword, newPassword } = body;

      if (!currentPassword || !newPassword) {
        return jsonResponse({ error: { message: 'Current password and new password required' } }, 400);
      }

      if (newPassword.length < 8) {
        return jsonResponse({ error: { message: 'New password must be at least 8 characters' } }, 400);
      }

      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id) as any;

      const derived = crypto.pbkdf2Sync(currentPassword, user.salt, 100000, 64, 'sha512').toString('hex');
      if (derived !== user.password_hash) {
        return jsonResponse({ error: { message: 'Current password is incorrect', type: 'invalid_password' } }, 403);
      }

      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = crypto.pbkdf2Sync(newPassword, newSalt, 100000, 64, 'sha512').toString('hex');
      db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(newHash, newSalt, auth.user.id);

      // Invalidate all other sessions
      const authHeader = req.headers.get('Authorization');
      const currentToken = authHeader!.slice(7).trim();
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(auth.user.id, currentToken);

      return jsonResponse({ success: true });
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  // POST /api/auth/forgot-password — generate reset code (stub)
  if (path === '/api/auth/forgot-password' && req.method === 'POST') {
    // The Bun fork uses auto-generated admin credentials; password reset
    // is via ADMIN_PASSWORD env var. Return success to avoid leaking info.
    return jsonResponse({ success: true });
  }

  // POST /api/auth/reset-password — reset with code (stub)
  if (path === '/api/auth/reset-password' && req.method === 'POST') {
    return jsonResponse({ error: { message: 'Password reset is not supported. Set ADMIN_PASSWORD env var and restart.' } }, 400);
  }

  // POST /api/auth/change-email — change email/username
  if (path === '/api/auth/change-email' && req.method === 'POST') {
    const auth = authenticateRequest(req);
    if (!auth.ok) return auth.response;

    try {
      const body = await parseJson(req);
      const { newEmail } = body;

      if (!newEmail) {
        return jsonResponse({ error: { message: 'New email required' } }, 400);
      }

      const db = getDb();
      // Check if email is already taken
      const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newEmail, auth.user.id);
      if (existing) {
        return jsonResponse({ error: { message: 'Email is already taken', type: 'email_taken' } }, 409);
      }

      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newEmail, auth.user.id);
      return jsonResponse({ success: true, email: newEmail });
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  return new Response('Not Found', { status: 404 });
}
