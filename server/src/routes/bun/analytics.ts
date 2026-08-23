import { getDb } from '../../db/index.js';
import { jsonResponse } from '../../lib/json.js';
import { providerIdFor, providerDisplayName } from '../../lib/provider-identity.js';

// The endpoint identity of a request, in SQL: the serving key's base_url, ''
// when the key is gone or carries none (every catalog key). Mirrors
// lib/endpoint-scope.normalizeBaseUrl so the SQL side agrees with the ids
// providerIdFor() builds. Requires LEFT JOIN api_keys as `k`.
const ENDPOINT_ID_SQL = "COALESCE(rtrim(trim(k.base_url), '/'), '')";

function getTimeFilter(range: string): string {
  switch (range) {
    case '24h': return "datetime('now', '-1 day')";
    case '7d': return "datetime('now', '-7 days')";
    case '30d': return "datetime('now', '-30 days')";
    default: return "datetime('now', '-7 days')";
  }
}

export async function analyticsRoute(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const range = url.searchParams.get('range') ?? '7d';
  const since = getTimeFilter(range);

  // Summary stats
  if (path === '/api/analytics/summary' && req.method === 'GET') {
    const db = getDb();
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        AVG(latency_ms) as avg_latency_ms
      FROM requests
      WHERE created_at >= ${since}
    `).get() as any;

    const totalRequests = stats.total_requests ?? 0;
    const successRate = totalRequests > 0 ? (stats.success_count / totalRequests) * 100 : 0;
    const totalTokens = (stats.total_input_tokens ?? 0) + (stats.total_output_tokens ?? 0);

    // Estimate cost savings: average ~$3/M input + $15/M output tokens (GPT-4o pricing)
    const inputCost = ((stats.total_input_tokens ?? 0) / 1_000_000) * 3;
    const outputCost = ((stats.total_output_tokens ?? 0) / 1_000_000) * 15;
    const estimatedSavings = inputCost + outputCost;

    return jsonResponse({
      totalRequests,
      successRate: Math.round(successRate * 10) / 10,
      avgLatencyMs: Math.round(stats.avg_latency_ms ?? 0),
      totalTokens,
      estimatedSavings: Math.round(estimatedSavings * 100) / 100,
    });
  }

  // Requests over time
  if (path === '/api/analytics/requests-over-time' && req.method === 'GET') {
    const db = getDb();

    let groupBy: string;
    let dateFormat: string;
    switch (range) {
      case '24h':
        groupBy = "strftime('%Y-%m-%d %H:00', created_at)";
        dateFormat = '%Y-%m-%d %H:00';
        break;
      case '30d':
        groupBy = "date(created_at)";
        dateFormat = '%Y-%m-%d';
        break;
      default: // 7d
        groupBy = "date(created_at)";
        dateFormat = '%Y-%m-%d';
    }

    const rows = db.prepare(`
      SELECT
        strftime('${dateFormat}', created_at) as period,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success
      FROM requests
      WHERE created_at >= ${since}
      GROUP BY ${groupBy}
      ORDER BY period ASC
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      period: r.period,
      total: r.total,
      success: r.success,
    })));
  }

  // Platform stats
  if (path === '/api/analytics/platforms' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        platform,
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        AVG(latency_ms) as avg_latency_ms,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output
      FROM requests
      WHERE created_at >= ${since}
      GROUP BY platform
      ORDER BY total_requests DESC
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      platform: r.platform,
      totalRequests: r.total_requests,
      successRate: r.total_requests > 0
        ? Math.round((r.success_count / r.total_requests) * 1000) / 10
        : 0,
      avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
      totalTokens: (r.total_input ?? 0) + (r.total_output ?? 0),
    })));
  }

  // Model stats
  if (path === '/api/analytics/models' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        platform,
        model_id,
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        AVG(latency_ms) as avg_latency_ms
      FROM requests
      WHERE created_at >= ${since}
      GROUP BY platform, model_id
      ORDER BY total_requests DESC
      LIMIT 20
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      platform: r.platform,
      modelId: r.model_id,
      totalRequests: r.total_requests,
      successRate: r.total_requests > 0
        ? Math.round((r.success_count / r.total_requests) * 1000) / 10
        : 0,
      avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
    })));
  }

  // Recent requests
  if (path === '/api/analytics/recent' && req.method === 'GET') {
    const db = getDb();
    const limit = parseInt(url.searchParams.get('limit') ?? '50');
    const rows = db.prepare(`
      SELECT *
      FROM requests
      WHERE created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return jsonResponse(rows.map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      status: r.status,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      latencyMs: r.latency_ms,
      error: r.error,
      createdAt: r.created_at,
    })));
  }

  // By platform (new format matching upstream). Grouping key is
  // (platform, endpoint): every custom relay shares platform 'custom', so
  // grouping by platform alone collapses them into one row (#889).
  if (path === '/api/analytics/by-platform' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        r.platform,
        ${ENDPOINT_ID_SQL} as base_url,
        COUNT(*) as requests,
        SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
        AVG(r.latency_ms) as avg_latency_ms,
        SUM(r.input_tokens) as total_input_tokens,
        SUM(r.output_tokens) as total_output_tokens
      FROM requests r
      LEFT JOIN api_keys k ON k.id = r.key_id
      WHERE r.created_at >= ${since}
      GROUP BY r.platform, ${ENDPOINT_ID_SQL}
      ORDER BY requests DESC
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      platform: r.platform,
      providerId: providerIdFor(r.platform, r.base_url || null),
      endpoint: providerDisplayName(r.platform, r.base_url || null),
      requests: r.requests,
      successRate: r.requests > 0 ? Math.round((r.success_count / r.requests) * 1000) / 10 : 0,
      avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
      p95LatencyMs: null,
      avgTtfbMs: null,
      errorCount: r.requests - r.success_count,
      avgTokensPerSecond: null,
      totalInputTokens: r.total_input_tokens ?? 0,
      totalOutputTokens: r.total_output_tokens ?? 0,
    })));
  }

  // By client agent
  if (path === '/api/analytics/by-client' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        COALESCE(client_agent, 'unknown') as client_agent,
        COUNT(*) as requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        AVG(latency_ms) as avg_latency_ms,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        MAX(created_at) as last_seen_at
      FROM requests
      WHERE created_at >= ${since}
      GROUP BY client_agent
      ORDER BY requests DESC
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      clientAgent: r.client_agent,
      requests: r.requests,
      successRate: r.requests > 0 ? Math.round((r.success_count / r.requests) * 1000) / 10 : 0,
      avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
      totalInputTokens: r.total_input_tokens ?? 0,
      totalOutputTokens: r.total_output_tokens ?? 0,
      lastSeenAt: r.last_seen_at,
    })));
  }

  // Timeline (hourly buckets)
  if (path === '/api/analytics/timeline' && req.method === 'GET') {
    const db = getDb();
    const groupBy = range === '24h'
      ? "strftime('%Y-%m-%dT%H:00:00', created_at)"
      : "strftime('%Y-%m-%dT00:00:00', created_at)";

    const rows = db.prepare(`
      SELECT
        ${groupBy} as timestamp,
        COUNT(*) as requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failure_count,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens
      FROM requests
      WHERE created_at >= ${since}
      GROUP BY ${groupBy}
      ORDER BY timestamp ASC
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      timestamp: r.timestamp,
      requests: r.requests,
      successCount: r.success_count,
      failureCount: r.failure_count,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
    })));
  }

  // By model. Grouping key is (platform, endpoint, model_id) — the same model
  // id served by two different custom relays is two different things (#889).
  // The models join is endpoint-scoped: models is unique on
  // (platform, model_id, endpoint_scope), so joining without endpoint_scope
  // would multiply request rows by every relay that registered the model.
  if (path === '/api/analytics/by-model' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        r.platform,
        ${ENDPOINT_ID_SQL} as base_url,
        r.model_id,
        COALESCE(m.display_name, r.model_id) as display_name,
        COUNT(*) as requests,
        SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
        AVG(r.latency_ms) as avg_latency_ms,
        SUM(r.input_tokens) as total_input_tokens,
        SUM(r.output_tokens) as total_output_tokens
      FROM requests r
      LEFT JOIN api_keys k ON k.id = r.key_id
      LEFT JOIN models m
        ON m.platform = r.platform AND m.model_id = r.model_id
       AND m.endpoint_scope = ${ENDPOINT_ID_SQL}
      WHERE r.created_at >= ${since}
      GROUP BY r.platform, ${ENDPOINT_ID_SQL}, r.model_id
      ORDER BY requests DESC
      LIMIT 50
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      platform: r.platform,
      providerId: providerIdFor(r.platform, r.base_url || null),
      endpoint: providerDisplayName(r.platform, r.base_url || null),
      modelId: r.model_id,
      displayName: r.display_name,
      requests: r.requests,
      successRate: r.requests > 0 ? Math.round((r.success_count / r.requests) * 1000) / 10 : 0,
      avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
      totalInputTokens: r.total_input_tokens ?? 0,
      totalOutputTokens: r.total_output_tokens ?? 0,
      pinnedRequests: 0,
      estimatedCost: 0,
    })));
  }

  // By key
  if (path === '/api/analytics/by-key' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        r.key_id,
        k.label,
        k.platform,
        COUNT(*) as requests,
        SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
        AVG(r.latency_ms) as avg_latency_ms,
        SUM(r.input_tokens) as total_input_tokens,
        SUM(r.output_tokens) as total_output_tokens
      FROM requests r
      LEFT JOIN api_keys k ON k.id = r.key_id
      WHERE r.created_at >= ${since}
      GROUP BY r.key_id
      ORDER BY requests DESC
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      keyId: r.key_id,
      label: r.label,
      platform: r.platform,
      requests: r.requests,
      successRate: r.requests > 0 ? Math.round((r.success_count / r.requests) * 1000) / 10 : 0,
      avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
      totalInputTokens: r.total_input_tokens ?? 0,
      totalOutputTokens: r.total_output_tokens ?? 0,
    })));
  }

  // Recent errors
  if (path === '/api/analytics/errors' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, platform, model_id, error, latency_ms, created_at
      FROM requests
      WHERE status != 'success' AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as any[];

    return jsonResponse(rows.map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      error: r.error ?? '',
      latencyMs: r.latency_ms ?? 0,
      createdAt: r.created_at,
    })));
  }

  // Error distribution
  if (path === '/api/analytics/error-distribution' && req.method === 'GET') {
    const db = getDb();
    const byPlatform = db.prepare(`
      SELECT platform, COUNT(*) as count
      FROM requests
      WHERE status != 'success' AND created_at >= ${since}
      GROUP BY platform
      ORDER BY count DESC
    `).all() as any[];

    const detailed = db.prepare(`
      SELECT platform, model_id,
        CASE
          WHEN error LIKE '%rate%' OR error LIKE '%429%' THEN 'rate_limit'
          WHEN error LIKE '%timeout%' THEN 'timeout'
          WHEN error LIKE '%auth%' OR error LIKE '%401%' OR error LIKE '%403%' THEN 'auth'
          WHEN error LIKE '%5xx%' OR error LIKE '%500%' OR error LIKE '%502%' OR error LIKE '%503%' THEN 'server_error'
          ELSE 'other'
        END as error_category,
        COUNT(*) as count
      FROM requests
      WHERE status != 'success' AND created_at >= ${since}
      GROUP BY platform, model_id, error_category
      ORDER BY count DESC
    `).all() as any[];

    const categoryMap = new Map<string, number>();
    for (const d of detailed) {
      categoryMap.set(d.error_category, (categoryMap.get(d.error_category) ?? 0) + d.count);
    }

    return jsonResponse({
      byCategory: [...categoryMap.entries()].map(([category, count]) => ({ category, count })),
      byPlatform: byPlatform.map(p => ({ platform: p.platform, count: p.count })),
      detailed,
    });
  }

  // Recent calls list with filters
  if (path === '/api/analytics/requests' && req.method === 'GET') {
    const db = getDb();
    const limit = parseInt(url.searchParams.get('limit') ?? '100');
    const status = url.searchParams.get('status');
    const platform = url.searchParams.get('platform');

    let query = `SELECT * FROM requests WHERE created_at >= ${since}`;
    const params: any[] = [];
    if (status === 'success') query += ` AND status = 'success'`;
    if (status === 'error') query += ` AND status != 'success'`;
    if (platform && platform !== 'all') { query += ` AND platform = ?`; params.push(platform); }
    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(query).all(...params) as any[];
    const total = rows.length;

    return jsonResponse({
      total,
      rows: rows.map(r => ({
        id: r.id,
        platform: r.platform,
        modelId: r.model_id,
        requestedModel: r.requested_model ?? null,
        requestType: r.request_type ?? 'chat',
        status: r.status,
        inputTokens: r.input_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        latencyMs: r.latency_ms ?? 0,
        error: r.error ?? null,
        clientIp: r.client_ip ?? null,
        clientUserAgent: r.client_user_agent ?? null,
        createdAt: r.created_at,
        attemptCount: 0,
      })),
    });
  }

  // Request detail with attempts
  const reqMatch = path.match(/^\/api\/analytics\/requests\/(\d+)$/);
  if (reqMatch && req.method === 'GET') {
    const db = getDb();
    const requestId = parseInt(reqMatch[1]);
    const row = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(requestId) as any;
    if (!row) return new Response('Not Found', { status: 404 });

    const attempts = db.prepare(`
      SELECT ordinal, platform, model_id, key_ordinal, outcome, start_offset_ms, duration_ms, error_summary
      FROM request_attempts WHERE request_id = ? ORDER BY ordinal ASC
    `).all(requestId) as any[];

    return jsonResponse({
      id: row.id,
      platform: row.platform,
      modelId: row.model_id,
      requestedModel: row.requested_model ?? null,
      requestType: row.request_type ?? 'chat',
      status: row.status,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      latencyMs: row.latency_ms ?? 0,
      error: row.error ?? null,
      clientIp: row.client_ip ?? null,
      clientUserAgent: row.client_user_agent ?? null,
      createdAt: row.created_at,
      ttfbMs: row.ttfb_ms ?? null,
      attempts: attempts.map(a => ({
        ordinal: a.ordinal,
        platform: a.platform,
        modelId: a.model_id,
        keyOrdinal: a.key_ordinal,
        outcome: a.outcome,
        startOffsetMs: a.start_offset_ms,
        durationMs: a.duration_ms,
        errorSummary: a.error_summary ?? null,
      })),
    });
  }

  return new Response('Not Found', { status: 404 });
}
