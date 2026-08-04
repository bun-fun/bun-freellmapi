import type { Platform } from '@freellmapi/shared/types.js';
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { isEncryptionKeyInitialized } from '../../lib/crypto.js';
import { getProvider } from '../../providers/index.js';
import { getSoonestCooldownExpiry } from '../../services/ratelimit.js';
import { getQuotaStateForKeys } from '../../services/provider-quota.js';

// Machine-readable operational endpoints for meta-gateways / orchestrators.
// /livez and /readyz are unauthenticated so a load balancer can probe them;
// /v1/providers sits behind the same unified API key as the rest of /v1.

function isDbReachable(): boolean {
  try {
    getDb().prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

function extractApiToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth) return auth.replace(/^Bearer\s+/i, '');
  const apiKey = req.headers.get('x-api-key');
  if (apiKey) return apiKey;
  return null;
}

function timingSafeStringEqual(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < provided.length; i++) {
    result |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

// GET /livez — liveness
export function livezRoute(req: Request): Response {
  const db = isDbReachable();
  const encryptionKey = isEncryptionKeyInitialized();
  const uptime_s = Math.floor(process.uptime());

  if (!db || !encryptionKey) {
    return new Response(JSON.stringify({
      status: 'unavailable',
      uptime_s,
      checks: { db, encryption_key: encryptionKey },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ status: 'ok', uptime_s }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /readyz — readiness
export function readyzRoute(req: Request): Response {
  if (!isDbReachable()) {
    return new Response(JSON.stringify({ status: 'unavailable', reason: 'db_unreachable' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

  const db = getDb();
  const agg = db.prepare(`
    SELECT
      COUNT(*) AS enabled_keys,
      COUNT(DISTINCT CASE WHEN status IN ('healthy', 'unknown') THEN platform END) AS ready_upstreams
    FROM api_keys
    WHERE enabled = 1
  `).get() as { enabled_keys: number; ready_upstreams: number };

  const readyUpstreams = agg.ready_upstreams ?? 0;
  if (readyUpstreams > 0) {
    return new Response(JSON.stringify({ status: 'ok', ready_upstreams: readyUpstreams }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let reason: string;
  if ((agg.enabled_keys ?? 0) === 0) {
    reason = 'no_upstreams_configured';
  } else if (getSoonestCooldownExpiry() != null) {
    reason = 'all_upstreams_rate_limited';
  } else {
    reason = 'all_upstreams_unhealthy';
  }

  return new Response(JSON.stringify({ status: 'unavailable', reason }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  });
}

// GET /v1/providers — aggregate per-upstream state
export function providersRoute(req: Request): Response {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    return new Response(JSON.stringify({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const db = getDb();

  const platformRows = db.prepare(`
    SELECT
      platform,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_keys,
      SUM(CASE WHEN enabled = 1 AND status = 'healthy' THEN 1 ELSE 0 END) AS healthy_keys,
      SUM(CASE WHEN enabled = 1 AND status = 'unknown' THEN 1 ELSE 0 END) AS unknown_keys,
      SUM(CASE WHEN enabled = 1 AND status = 'invalid' THEN 1 ELSE 0 END) AS invalid_keys,
      SUM(CASE WHEN enabled = 1 AND status = 'error' THEN 1 ELSE 0 END) AS error_keys
    FROM api_keys
    GROUP BY platform
  `).all() as Array<{
    platform: string; enabled_keys: number; healthy_keys: number;
    unknown_keys: number; invalid_keys: number; error_keys: number;
  }>;

  const now = Date.now();
  const cooldownRows = db.prepare(`
    SELECT platform, MIN(expires_at_ms) AS resume_ms
    FROM rate_limit_cooldowns
    WHERE expires_at_ms > ?
    GROUP BY platform
  `).all(now) as Array<{ platform: string; resume_ms: number }>;
  const resumeByPlatform = new Map(cooldownRows.map(r => [r.platform, r.resume_ms]));

  const errorRows = db.prepare(`
    SELECT platform, last_health_error
    FROM api_keys
    WHERE enabled = 1 AND last_health_error IS NOT NULL
    ORDER BY last_checked_at DESC
  `).all() as Array<{ platform: string; last_health_error: string }>;
  const lastErrorByPlatform = new Map<string, string>();
  for (const row of errorRows) {
    if (!lastErrorByPlatform.has(row.platform)) {
      lastErrorByPlatform.set(row.platform, row.last_health_error);
    }
  }

  const requestsRemainingByPlatform = new Map<string, number>();
  for (const q of getQuotaStateForKeys()) {
    if (q.metric !== 'requests' || typeof q.limit !== 'number' || q.limit <= 0) continue;
    if (typeof q.remaining !== 'number') continue;
    const pct = Math.max(0, Math.min(100, Math.round((q.remaining / q.limit) * 100)));
    const prev = requestsRemainingByPlatform.get(q.platform);
    if (prev === undefined || pct < prev) requestsRemainingByPlatform.set(q.platform, pct);
  }

  const counts = { healthy: 0, rate_limited: 0, invalid: 0, unknown: 0 };

  const providers = platformRows
    .filter(p => p.enabled_keys > 0)
    .map(p => {
      const onCooldown = resumeByPlatform.has(p.platform);
      let status: 'healthy' | 'rate_limited' | 'invalid' | 'unknown';
      if (p.healthy_keys > 0 && !onCooldown) {
        status = 'healthy';
      } else if (onCooldown) {
        status = 'rate_limited';
      } else if (p.unknown_keys > 0) {
        status = 'unknown';
      } else if (p.invalid_keys > 0 || p.error_keys > 0) {
        status = 'invalid';
      } else {
        status = 'unknown';
      }
      counts[status] += 1;

      const provider = getProvider(p.platform as Platform);
      const entry: Record<string, unknown> = {
        platform: p.platform,
        name: provider?.name ?? p.platform,
        status,
        keys: p.enabled_keys,
      };
      if (status === 'rate_limited') {
        const resumeMs = resumeByPlatform.get(p.platform);
        if (resumeMs != null) entry.resume_at = new Date(resumeMs).toISOString();
      }
      if (status === 'invalid') {
        const lastError = lastErrorByPlatform.get(p.platform);
        if (lastError) entry.last_error = lastError;
      }
      const requestsRemaining = requestsRemainingByPlatform.get(p.platform);
      if (requestsRemaining != null) entry.requests_remaining_pct = requestsRemaining;
      return entry;
    });

  return new Response(JSON.stringify({ providers, counts }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
