import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../../db/index.js';
import { maskKey } from '../../lib/crypto.js';
import { deleteUnusedCustomEndpointKey } from '../../lib/custom-provider-cleanup.js';
import { resolveCustomEndpointKey, customEndpointKeyIds } from '../../services/custom-endpoint.js';
import { listEmbeddingModels, probeEmbeddingDimensions, EmbeddingsError } from '../../services/embeddings.js';

// Dashboard embeddings management: list provider families, month-to-date usage,
// reorder/enable providers, CRUD for custom embedding endpoints. All routes
// require dashboard session auth (handled in server.ts).

function familyOf(row: { family: string | null; model_id: string }): string {
  return row.family?.trim() ? row.family : (row.model_id.trim().split('/').pop() ?? row.model_id).toLowerCase();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// GET /api/embeddings — list provider families
export function embeddingsListRoute(): Response {
  const db = getDb();
  const keyCounts = new Map(
    (db.prepare("SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform")
      .all() as { platform: string; n: number }[]).map(r => [r.platform, r.n]),
  );
  const customKeyIds = new Set(
    (db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND enabled = 1 AND status IN ('healthy', 'unknown')")
      .all() as { id: number }[]).map(r => r.id),
  );
  const defaultFamily = getSetting('embeddings_default_family') ?? 'gemini-embedding-001';

  const byFamily = new Map<string, {
    family: string;
    dimensions: number;
    maxInputTokens: number | null;
    isDefault: boolean;
    providers: {
      id: number; platform: string; modelId: string; displayName: string;
      priority: number; enabled: boolean; quotaLabel: string; keyCount: number; isCustom: boolean;
    }[];
  }>();

  for (const r of listEmbeddingModels()) {
    const family = familyOf(r);
    let fam = byFamily.get(family);
    if (!fam) {
      fam = {
        family,
        dimensions: r.dimensions,
        maxInputTokens: r.max_input_tokens,
        isDefault: family === defaultFamily,
        providers: [],
      };
      byFamily.set(family, fam);
    }
    fam.providers.push({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      priority: r.priority,
      enabled: r.enabled === 1,
      quotaLabel: r.quota_label,
      keyCount: r.platform === 'custom' && r.key_id != null ? (customKeyIds.has(r.key_id) ? 1 : 0) : keyCounts.get(r.platform) ?? 0,
      isCustom: r.platform === 'custom',
    });
  }

  return jsonResponse({ defaultFamily, families: [...byFamily.values()] });
}

// GET /api/embeddings/usage — month-to-date usage per family + totals
export function embeddingsUsageRoute(): Response {
  const db = getDb();
  const rows = db.prepare(`
    SELECT em.family, em.platform, em.model_id, em.quota_label, em.enabled, em.priority,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END), 0) AS requests_today,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of month') THEN r.input_tokens ELSE 0 END), 0) AS tokens_month
      FROM embedding_models em
      LEFT JOIN requests r
        ON r.request_type = 'embedding' AND r.status = 'success'
       AND r.platform = em.platform AND r.model_id = em.model_id
       AND r.created_at >= datetime('now', 'start of month')
     GROUP BY em.id
  `).all() as {
    family: string | null; platform: string; model_id: string; quota_label: string | null;
    enabled: number; priority: number; requests_today: number; tokens_month: number;
  }[];

  const order = new Map<string, number>();
  const byFamily = new Map<string, {
    family: string;
    requestsToday: number;
    tokensMonth: number;
    legendPlatform: string | null;
    legendQuotaLabel: string | null;
    legendPriority: number | null;
  }>();

  for (const r of rows) {
    const family = familyOf(r);
    let acc = byFamily.get(family);
    if (!acc) {
      acc = { family, requestsToday: 0, tokensMonth: 0, legendPlatform: null, legendQuotaLabel: null, legendPriority: null };
      byFamily.set(family, acc);
      order.set(family, order.size);
    }
    acc.requestsToday += r.requests_today;
    acc.tokensMonth += r.tokens_month;
    if (r.enabled === 1 && (acc.legendPriority === null || r.priority < acc.legendPriority)) {
      acc.legendPlatform = r.platform;
      acc.legendQuotaLabel = r.quota_label;
      acc.legendPriority = r.priority;
    }
  }

  const families = [...byFamily.values()]
    .sort((a, b) => order.get(a.family)! - order.get(b.family)!)
    .map(f => ({
      family: f.family,
      requestsToday: f.requestsToday,
      tokensMonth: f.tokensMonth,
      platform: f.legendPlatform,
      quotaLabel: f.legendQuotaLabel,
    }));

  return jsonResponse({
    families,
    totalTokensMonth: families.reduce((s, f) => s + f.tokensMonth, 0),
    totalRequestsToday: families.reduce((s, f) => s + f.requestsToday, 0),
  });
}

const embeddingsUpdateSchema = z.object({
  defaultFamily: z.string().optional(),
  providers: z.array(z.object({
    id: z.number().int().positive(),
    priority: z.number().int().nonnegative(),
    enabled: z.boolean(),
  })).optional(),
});

// PUT /api/embeddings — change default family and/or provider priorities/enabled
export async function embeddingsUpdateRoute(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch {
    return jsonResponse({ error: { message: 'Invalid JSON' } }, 400);
  }

  const parsed = embeddingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: { message: 'Invalid request body' } }, 400);
  }

  const db = getDb();
  const apply = db.transaction(() => {
    if (parsed.data.defaultFamily !== undefined) {
      setSetting('embeddings_default_family', parsed.data.defaultFamily);
    }
    if (parsed.data.providers) {
      const stmt = db.prepare('UPDATE embedding_models SET priority = ?, enabled = ? WHERE id = ?');
      for (const p of parsed.data.providers) {
        stmt.run(p.priority, p.enabled ? 1 : 0, p.id);
      }
    }
  });
  apply();
  return jsonResponse({ success: true });
}

const customEmbeddingSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1),
  family: z.string().min(1),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  quotaLabel: z.string().optional(),
});

// POST /api/embeddings/custom — register a custom OpenAI-compatible endpoint
// after probing its vector dimensions. Family dimensions are immutable once
// set: registering a second provider with different dimensions is rejected.
export async function embeddingsCustomRoute(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch {
    return jsonResponse({ error: { message: 'Invalid JSON' } }, 400);
  }

  const parsed = customEmbeddingSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }, 400);
  }

  const db = getDb();
  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const modelId = parsed.data.model.trim();
  if (!modelId) return jsonResponse({ error: { message: 'model is required' } }, 400);
  const family = parsed.data.family.trim();
  if (!family) return jsonResponse({ error: { message: 'family is required' } }, 400);
  const displayName = parsed.data.displayName?.trim() || modelId;
  const label = parsed.data.label?.trim() || undefined;
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const quotaLabel = parsed.data.quotaLabel?.trim() || 'custom endpoint';

  let keyId: number;
  let storedKeyForMask: string;
  try {
    const resolved = resolveCustomEndpointKey(db, baseUrl, providedKey, label);
    keyId = resolved.keyId;
    storedKeyForMask = resolved.storedKey;
  } catch {
    return jsonResponse({ error: { message: 'Failed to register custom endpoint key' } }, 400);
  }

  let dimensions: number;
  try {
    dimensions = await probeEmbeddingDimensions(baseUrl, storedKeyForMask, modelId);
  } catch (err: any) {
    const e = err instanceof EmbeddingsError ? err : new EmbeddingsError(String(err?.message ?? err), 502);
    return jsonResponse({ error: { message: e.message.slice(0, 300) } }, e.status >= 400 && e.status < 600 ? e.status : 502);
  }

  const existing = db.prepare("SELECT DISTINCT dimensions FROM embedding_models WHERE family = ?").all(family) as { dimensions: number }[];
  if (existing.some(r => r.dimensions !== dimensions)) {
    return jsonResponse({
      error: { message: `Use a new family name — family '${family}' is pinned to ${existing[0]?.dimensions} dimensions, this provider reports ${dimensions}.` },
    }, 400);
  }

  const upsert = db.transaction(() => {
    const endpointKeyIds = customEndpointKeyIds(db, keyId);

    const existingModel = db.prepare("SELECT id, key_id FROM embedding_models WHERE platform = 'custom' AND model_id = ? LIMIT 1")
      .get(modelId) as { id: number; key_id: number | null } | undefined;

    const bindKeyId = existingModel?.key_id != null && endpointKeyIds.has(existingModel.key_id) ? existingModel.key_id : keyId;
    const priority = existingModel
      ? (db.prepare('SELECT priority FROM embedding_models WHERE id = ?').get(existingModel.id) as { priority: number }).priority
      : (db.prepare('SELECT COALESCE(MAX(priority), 0) AS maxPriority FROM embedding_models WHERE family = ?').get(family) as { maxPriority: number }).maxPriority + 1;

    if (existingModel) {
      db.prepare("UPDATE embedding_models SET family = ?, display_name = ?, dimensions = ?, priority = ?, enabled = 1, quota_label = ?, key_id = ? WHERE id = ?")
        .run(family, displayName, dimensions, priority, quotaLabel, bindKeyId, existingModel.id);
      return { modelDbId: existingModel.id };
    }

    const model = db.prepare("INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id) VALUES (?, 'custom', ?, ?, ?, NULL, ?, 1, ?, ?)")
      .run(family, modelId, displayName, dimensions, priority, quotaLabel, bindKeyId);
    return { modelDbId: Number(model.lastInsertRowid) };
  });

  const result = upsert();
  return jsonResponse({
    success: true, keyId, modelDbId: result.modelDbId,
    platform: 'custom', baseUrl, model: modelId, family, displayName, dimensions,
    maskedKey: maskKey(storedKeyForMask),
  }, 201);
}

// DELETE /api/embeddings/custom/:id
export function embeddingsDeleteRoute(idStr: string): Response {
  const id = Number(idStr);
  if (!Number.isInteger(id)) return jsonResponse({ error: { message: 'Invalid id' } }, 400);

  const db = getDb();
  const row = db.prepare("SELECT key_id FROM embedding_models WHERE id = ? AND platform = 'custom'").get(id) as { key_id: number | null } | undefined;
  if (!row) return jsonResponse({ error: { message: `Unknown custom embedding provider ${id}` } }, 404);

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM embedding_models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();
  return jsonResponse({ success: true });
}
