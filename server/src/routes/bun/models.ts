import { getDb } from '../../db/index.js';
import { hasProvider } from '../../providers/index.js';
import { jsonResponse } from '../../lib/json.js';

export async function modelsRoute(req: Request, _url: URL): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/api/models' && req.method === 'GET') {
    const db = getDb();
    const models = db.prepare(`
      SELECT m.*, fc.priority, fc.enabled as fallback_enabled
      FROM models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
    `).all() as any[];

    // Count keys per platform
    const keyCounts = db.prepare(`
      SELECT platform, COUNT(*) as count
      FROM api_keys
      WHERE enabled = 1
      GROUP BY platform
    `).all() as { platform: string; count: number }[];

    const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

    const result = models.map(m => ({
      id: m.id,
      platform: m.platform,
      modelId: m.model_id,
      displayName: m.display_name,
      intelligenceRank: m.intelligence_rank,
      speedRank: m.speed_rank,
      sizeLabel: m.size_label,
      rpmLimit: m.rpm_limit,
      rpdLimit: m.rpd_limit,
      tpmLimit: m.tpm_limit,
      tpdLimit: m.tpd_limit,
      monthlyTokenBudget: m.monthly_token_budget,
      contextWindow: m.context_window,
      enabled: m.enabled === 1,
      fallbackEnabled: m.fallback_enabled === 1,
      hasProvider: hasProvider(m.platform),
      keyCount: keyCountMap.get(m.platform) ?? 0,
    }));

    return jsonResponse(result);
  }

  if (path.startsWith('/api/models/') && path.endsWith('/toggle') && req.method === 'POST') {
    const parts = path.split('/');
    const id = parseInt(parts[parts.length - 2]);
    if (isNaN(id)) return new Response('Invalid ID', { status: 400 });

    const db = getDb();
    const model = db.prepare('SELECT enabled FROM models WHERE id = ?').get(id) as { enabled: number } | undefined;
    if (!model) return new Response('Not Found', { status: 404 });

    const newEnabled = model.enabled === 1 ? 0 : 1;
    db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(newEnabled, id);

    return jsonResponse({ success: true, enabled: newEnabled === 1 });
  }

  if (path === '/api/models/sync/models-dev' && req.method === 'POST') {
    const { runModelsDevSync } = await import('../../services/models-dev-sync.js');
    const result = await runModelsDevSync(getDb());
    if (result === null) {
      return jsonResponse({ success: false, error: 'models.dev fetch failed; last-good state kept' }, 502);
    }
    return jsonResponse({ success: true, ...result });
  }

  return new Response('Not Found', { status: 404 });
}
