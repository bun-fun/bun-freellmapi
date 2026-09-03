import { getDb } from '../../db/index.js';
import {
  getAllPenalties,
  getRoutingScores,
  setRoutingStrategy,
  setCustomWeights,
  getKeySelectionStrategy,
  setKeySelectionStrategy,
  setPeakHoursConfig,
} from '../../services/router.js';
import type { RoutingStrategy, RoutingWeights, KeySelectionStrategy, PeakHoursConfig } from '../../services/scoring.js';
import { jsonResponse } from '../../lib/json.js';

export async function fallbackRoute(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  // Get fallback chain (with dynamic penalties)
  if (path === '/api/fallback' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT fc.model_db_id, fc.priority, fc.enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
             m.monthly_token_budget
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      ORDER BY fc.priority ASC
    `).all() as any[];

    // Count enabled keys per platform
    const keyCounts = db.prepare(`
      SELECT platform, COUNT(*) as count
      FROM api_keys WHERE enabled = 1
      GROUP BY platform
    `).all() as { platform: string; count: number }[];
    const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

    // Get current dynamic penalties
    const penalties = getAllPenalties();
    const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

    const result = rows.map(r => {
      const penalty = penaltyMap.get(r.model_db_id);
      return {
        modelDbId: r.model_db_id,
        priority: r.priority,
        effectivePriority: r.priority + (penalty?.penalty ?? 0),
        penalty: penalty?.penalty ?? 0,
        rateLimitHits: penalty?.count ?? 0,
        enabled: r.enabled === 1,
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        intelligenceRank: r.intelligence_rank,
        speedRank: r.speed_rank,
        sizeLabel: r.size_label,
        rpmLimit: r.rpm_limit,
        rpdLimit: r.rpd_limit,
        monthlyTokenBudget: r.monthly_token_budget,
        keyCount: keyCountMap.get(r.platform) ?? 0,
      };
    });

    return jsonResponse(result);
  }

  // Update fallback config (reorder, toggle)
  if (path === '/api/fallback' && req.method === 'PUT') {
    try {
      const body = await req.json() as Array<{ modelDbId: number; priority: number; enabled: boolean }>;
      const db = getDb();
      db.prepare('BEGIN TRANSACTION').run();
      try {
        for (const entry of body) {
          db.prepare(`
            UPDATE fallback_config SET priority = ?, enabled = ?
            WHERE model_db_id = ?
          `).run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
        }
        db.prepare('COMMIT').run();
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
      return jsonResponse({ success: true });
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  // Sort presets
  if (path.startsWith('/api/fallback/sort/') && req.method === 'POST') {
    const preset = path.split('/').pop();
    const db = getDb();
    const models = db.prepare(`
      SELECT fc.model_db_id, m.intelligence_rank, m.speed_rank, m.monthly_token_budget
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      ORDER BY fc.priority ASC
    `).all() as any[];

    let sorted: any[];
    switch (preset) {
      case 'intelligence':
        sorted = [...models].sort((a, b) => a.intelligence_rank - b.intelligence_rank);
        break;
      case 'speed':
        sorted = [...models].sort((a, b) => a.speed_rank - b.speed_rank);
        break;
      case 'budget':
        sorted = [...models].sort((a, b) => {
          const aBudget = parseFloat((a.monthly_token_budget || '0').replace(/[^0-9.]/g, '')) || 0;
          const bBudget = parseFloat((b.monthly_token_budget || '0').replace(/[^0-9.]/g, '')) || 0;
          return bBudget - aBudget;
        });
        break;
      default:
        return new Response('Invalid preset', { status: 400 });
    }

    db.prepare('BEGIN TRANSACTION').run();
    try {
      for (let i = 0; i < sorted.length; i++) {
        db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?')
          .run(i + 1, sorted[i].model_db_id);
      }
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }

    return jsonResponse({ success: true });
  }

  // Token usage
  if (path === '/api/fallback/token-usage' && req.method === 'GET') {
    const db = getDb();
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const usage = db.prepare(`
      SELECT
        m.display_name, m.platform, m.monthly_token_budget,
        COALESCE(SUM(r.input_tokens + r.output_tokens), 0) as used
      FROM models m
      LEFT JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1
      LEFT JOIN requests r ON r.model_id = m.model_id AND r.platform = m.platform
        AND r.created_at >= ?
      WHERE m.enabled = 1
      GROUP BY m.id
      ORDER BY m.intelligence_rank ASC
    `).all(firstOfMonth) as any[];

    const totalBudget = usage.reduce((sum, m) => {
      const budget = parseFloat((m.monthly_token_budget || '0').replace(/[^0-9.]/g, '')) || 0;
      return sum + budget * 1_000_000;
    }, 0);

    const totalUsed = usage.reduce((sum, m) => sum + (m.used ?? 0), 0);

    return jsonResponse({
      totalBudget,
      totalUsed,
      models: usage.map(m => ({
        displayName: m.display_name,
        platform: m.platform,
        budget: (parseFloat((m.monthly_token_budget || '0').replace(/[^0-9.]/g, '')) || 0) * 1_000_000,
      })),
    });
  }

  // Penalty inspector — returns current dynamic penalties for the dashboard
  if (path === '/api/fallback/penalty-inspector' && req.method === 'GET') {
    const penalties = getAllPenalties();
    return jsonResponse({
      penalties: penalties.map(p => ({
        modelDbId: p.modelDbId,
        penalty: p.penalty,
        count: p.count,
        expiresAt: (p as any).expiresAt ?? null,
      })),
    });
  }

  // Routing config — get/put routing strategy settings. GET returns the live
  // scoreboard the dashboard sorts by (per-axis breakdown + final score under
  // the active strategy's weights, matching getRoutingScores).
  if (path === '/api/fallback/routing' && req.method === 'GET') {
    return jsonResponse(getRoutingScores());
  }

  if (path === '/api/fallback/routing' && req.method === 'PUT') {
    try {
      const body = await req.json() as {
        strategy?: string;
        weights?: RoutingWeights;
        keySelectionStrategy?: KeySelectionStrategy;
        peakHours?: Partial<PeakHoursConfig>;
      };
      setRoutingStrategy((body.strategy ?? 'balanced') as RoutingStrategy);
      if (body.weights) setCustomWeights(body.weights);
      if (body.keySelectionStrategy !== undefined) setKeySelectionStrategy(body.keySelectionStrategy);
      if (body.peakHours) setPeakHoursConfig(body.peakHours);
      return jsonResponse(getRoutingScores());
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  return new Response('Not Found', { status: 404 });
}
