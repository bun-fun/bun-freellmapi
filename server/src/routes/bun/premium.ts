import { getDb } from '../../db/index.js';
import { jsonResponse } from '../../lib/json.js';

// Premium feature stubs. The Bun fork doesn't have a premium backend,
// but the dashboard expects these endpoints to respond.
export async function premiumRoute(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  // GET /api/premium — premium status
  if (path === '/api/premium' && req.method === 'GET') {
    const db = getDb();
    const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'premium_key'").get() as { value: string } | undefined;
    const maskedKey = keyRow ? '••••••' + keyRow.value.slice(-4) : null;

    return jsonResponse({
      hasKey: Boolean(keyRow),
      maskedKey,
      license: null,
      catalog: {
        baseUrl: '',
        appliedVersion: null,
        appliedTier: null,
        lastSyncMs: null,
        lastError: null,
      },
      siteUrl: '',
    });
  }

  // POST /api/premium/key — set premium key
  if (path === '/api/premium/key' && req.method === 'POST') {
    const body = await req.json().catch(() => ({})) as { key?: string };
    if (!body.key) return jsonResponse({ success: false, message: 'Key required' }, 400);
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('premium_key', ?)").run(body.key);
    return jsonResponse({ success: true });
  }

  // DELETE /api/premium/key — remove premium key
  if (path === '/api/premium/key' && req.method === 'DELETE') {
    getDb().prepare("DELETE FROM settings WHERE key = 'premium_key'").run();
    return jsonResponse({ success: true });
  }

  // POST /api/premium/sync — sync premium features (stub)
  if (path === '/api/premium/sync' && req.method === 'POST') {
    return jsonResponse({ success: false, message: 'Premium sync not available in this build' });
  }

  // POST /api/premium/portal — billing portal URL (stub)
  if (path === '/api/premium/portal' && req.method === 'POST') {
    return jsonResponse({ url: '' });
  }

  return new Response('Not Found', { status: 404 });
}
