import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getSetting } from '../../db/index.js';

async function call(app: Express, method: string, path: string, body?: any, token?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// initDb always auto-provisions the admin account (its plaintext lives in the
// `admin_password` setting), so the dashboard boots straight into the login
// flow — /api/auth/setup only ever answers on a users table that bootstrap has
// already filled. The old Express-era lockout test expected a login rate
// limiter that the Bun route stack does not mount; brute-force protection is
// deferred until one exists.
describe('Dashboard auth (#35)', () => {
  let app: Express;
  let password = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.ADMIN_PASSWORD;
    // Must be awaited: everything after the models.dev seed fetch (catalog
    // seeds, unified key, the admin user itself) only runs once that resolves.
    await initDb(':memory:');
    password = getSetting('admin_password') ?? '';
    app = createApp();
  });

  it('reports setup complete once the auto-provisioned admin exists', async () => {
    const { body } = await call(app, 'GET', '/api/auth/status');
    expect(body).toMatchObject({ needsSetup: false, authenticated: false });
  });

  it('gates /api/* routes with 401 when unauthenticated', async () => {
    expect((await call(app, 'GET', '/api/keys')).status).toBe(401);
    expect((await call(app, 'GET', '/api/fallback')).status).toBe(401);
    expect((await call(app, 'GET', '/api/settings/api-key')).status).toBe(401);
    expect((await call(app, 'GET', '/api/update/status')).status).toBe(401);
  });

  it('leaves /api/ping and the /v1 proxy reachable without a dashboard session', async () => {
    expect((await call(app, 'GET', '/api/ping')).status).toBe(200);
    // /v1 has its own (unified-key) auth, so it is not gated by the dashboard
    // session: with a seeded unified key but zero provider keys the request
    // passes auth and fails at routing instead.
    const proxy = await call(app, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
    expect(proxy.body.error.type).toBe('routing_error');
  });

  it('refuses setup while an account already exists', async () => {
    const { status } = await call(app, 'POST', '/api/auth/setup', { email: 'a@b.com', password: 'supersecret' });
    expect(status).toBe(409);
  });

  let token = '';
  it('logs in with the console-printed credentials ("Username: admin")', async () => {
    expect(password).toBeTruthy();
    // Regression: the banner prints Username: admin but fresh installs store
    // the row as admin@example.com — the bare name must resolve to it.
    const ok = await call(app, 'POST', '/api/auth/login', { username: 'admin', password });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe('string');
    expect(ok.body.user).toMatchObject({ username: 'admin@example.com' });
    token = ok.body.token;
    expect((await call(app, 'GET', '/api/keys', undefined, token)).status).toBe(200);
  });

  it('accepts the dashboard payload shape ({ username }) with the full name', async () => {
    const ok = await call(app, 'POST', '/api/auth/login', { username: 'admin@example.com', password });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ username: 'admin@example.com' });
  });

  it('accepts the API-doc payload shape ({ email })', async () => {
    const ok = await call(app, 'POST', '/api/auth/login', { email: 'admin@example.com', password });
    expect(ok.status).toBe(200);
  });

  it('rejects wrong passwords', async () => {
    const bad = await call(app, 'POST', '/api/auth/login', { username: 'admin', password: 'wrongpassword' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.type).toBe('authentication_error');

    const missing = await call(app, 'POST', '/api/auth/login', { username: 'admin' });
    expect(missing.status).toBe(400);
  });

  it('reports authenticated status with a valid token', async () => {
    const { body } = await call(app, 'GET', '/api/auth/status', undefined, token);
    expect(body).toMatchObject({ needsSetup: false, authenticated: true, email: 'admin@example.com' });
  });

  it('invalidates the token on logout', async () => {
    const login = await call(app, 'POST', '/api/auth/login', { username: 'admin', password });
    const t = login.body.token;
    expect((await call(app, 'GET', '/api/keys', undefined, t)).status).toBe(200);
    await call(app, 'POST', '/api/auth/logout', {}, t);
    expect((await call(app, 'GET', '/api/keys', undefined, t)).status).toBe(401);
  });
});
