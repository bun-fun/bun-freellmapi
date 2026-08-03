import { getDb } from '../../db/index.js';
import { jsonResponse } from '../../lib/json.js';

// Premium feature stubs. The Bun fork doesn't have a premium backend,
// but the dashboard expects these endpoints to respond.
export async function premiumRoute(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  // GET /api/premium — premium status
  if (path === '/api/premium' && req.method === 'GET') {
    return jsonResponse({
      isPremium: false,
      features: [],
      expiresAt: null,
    });
  }

  // POST/DELETE /api/premium/key — set/remove premium key (stub)
  if (path === '/api/premium/key') {
    return jsonResponse({ success: false, message: 'Premium not available in this build' });
  }

  // POST /api/premium/sync — sync premium features (stub)
  if (path === '/api/premium/sync' && req.method === 'POST') {
    return jsonResponse({ success: false, message: 'Premium not available in this build' });
  }

  // POST /api/premium/portal — billing portal URL (stub)
  if (path === '/api/premium/portal' && req.method === 'POST') {
    return jsonResponse({ url: '' });
  }

  return new Response('Not Found', { status: 404 });
}
