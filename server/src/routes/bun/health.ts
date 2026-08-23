import { getDb } from '../../db/index.js';
import { checkKeyHealth, checkAllKeys } from '../../services/health.js';
import { hasProvider } from '../../providers/index.js';
import { getDegradationStatus } from '../../services/degradation.js';
import { jsonResponse } from '../../lib/json.js';

export async function healthRoute(req: Request, _url: URL): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/api/health' && req.method === 'GET') {
    const db = getDb();

    const platforms = db.prepare(`
      SELECT
        platform,
        COUNT(*) as total_keys,
        SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_keys,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_keys,
        SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid_keys,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_keys,
        SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown_keys,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_keys
      FROM api_keys
      GROUP BY platform
    `).all() as any[];

    const keys = db.prepare(`
      SELECT id, platform, label, status, enabled, created_at, last_checked_at
      FROM api_keys
      ORDER BY platform, created_at DESC
    `).all() as any[];

    return jsonResponse({
      degradation: getDegradationStatus(),
      platforms: platforms.map(p => ({
        platform: p.platform,
        hasProvider: hasProvider(p.platform),
        totalKeys: p.total_keys,
        healthyKeys: p.healthy_keys,
        rateLimitedKeys: p.rate_limited_keys,
        invalidKeys: p.invalid_keys,
        errorKeys: p.error_keys,
        unknownKeys: p.unknown_keys,
        enabledKeys: p.enabled_keys,
      })),
      keys: keys.map(k => ({
        id: k.id,
        platform: k.platform,
        label: k.label,
        status: k.status,
        enabled: k.enabled === 1,
        createdAt: k.created_at,
        lastCheckedAt: k.last_checked_at,
      })),
    });
  }

  if (path.startsWith('/api/health/check/') && req.method === 'POST') {
    const parts = path.split('/');
    const id = parseInt(parts[parts.length - 1]);
    if (isNaN(id)) return new Response('Invalid ID', { status: 400 });

    await checkKeyHealth(id);
    return jsonResponse({ success: true });
  }

  if (path === '/api/health/check-all' && req.method === 'POST') {
    await checkAllKeys();
    return jsonResponse({ success: true });
  }

  return new Response('Not Found', { status: 404 });
}
