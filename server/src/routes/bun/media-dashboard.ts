import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { maskKey } from '../../lib/crypto.js';
import { deleteUnusedCustomEndpointKey } from '../../lib/custom-provider-cleanup.js';
import { resolveCustomEndpointKey } from '../../services/custom-endpoint.js';
import { registerCustomMediaModel } from '../../services/custom-media-register.js';
import { listAllMediaModels } from '../../services/media.js';

// Dashboard media management: list models, usage stats, CRUD for custom media
// models. All routes require dashboard session auth (handled in server.ts).

// GET /api/media — list media models
export function mediaListRoute(): Response {
  const db = getDb();
  const keyCounts = new Map(
    (db.prepare("SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform")
      .all() as { platform: string; n: number }[]).map(r => [r.platform, r.n]),
  );
  const customKeyIds = new Set(
    (db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND enabled = 1 AND status IN ('healthy', 'unknown')")
      .all() as { id: number }[]).map(r => r.id),
  );

  return new Response(JSON.stringify({
    models: listAllMediaModels().map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      modality: r.modality,
      enabled: r.enabled === 1,
      quotaLabel: r.quota_label,
      keyCount: r.platform === 'custom' && r.key_id != null ? (customKeyIds.has(r.key_id) ? 1 : 0) : keyCounts.get(r.platform) ?? 0,
      isCustom: r.platform === 'custom',
    })),
  }), { headers: { 'Content-Type': 'application/json' } });
}

// GET /api/media/usage?modality=image|audio
export function mediaUsageRoute(req: Request): Response {
  const url = new URL(req.url);
  const modality = url.searchParams.get('modality');
  if (modality !== 'image' && modality !== 'audio') {
    return new Response(JSON.stringify({ error: { message: 'modality must be image or audio' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT mm.id, mm.platform, mm.model_id, mm.display_name, mm.quota_label,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END), 0) AS requests_today,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of month') THEN 1 ELSE 0 END), 0) AS requests_month
    FROM media_models mm
    LEFT JOIN requests r
      ON r.request_type = ? AND r.status = 'success'
     AND r.platform = mm.platform AND r.model_id = mm.model_id
     AND r.created_at >= datetime('now', 'start of month')
    WHERE mm.modality = ? AND mm.enabled = 1
    GROUP BY mm.id ORDER BY mm.priority ASC
  `).all(modality, modality) as {
    id: number; platform: string; model_id: string; display_name: string;
    quota_label: string | null; requests_today: number; requests_month: number;
  }[];

  const models = rows.map(r => ({
    id: r.id, platform: r.platform, modelId: r.model_id,
    displayName: r.display_name, quotaLabel: r.quota_label,
    requestsToday: r.requests_today, requestsMonth: r.requests_month,
  }));

  return new Response(JSON.stringify({
    modality, models,
    totalRequestsToday: models.reduce((s, m) => s + m.requestsToday, 0),
    totalRequestsMonth: models.reduce((s, m) => s + m.requestsMonth, 0),
  }), { headers: { 'Content-Type': 'application/json' } });
}

const customMediaSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1),
  displayName: z.string().optional(),
  modality: z.enum(['image', 'audio']),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  quotaLabel: z.string().optional(),
});

// POST /api/media/custom
export async function mediaCustomRoute(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = customMediaSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const db = getDb();
  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const modelId = parsed.data.model.trim();
  if (!modelId) return new Response(JSON.stringify({ error: { message: 'model is required' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const displayName = parsed.data.displayName?.trim() || modelId;
  const label = parsed.data.label?.trim() || undefined;
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const quotaLabel = parsed.data.quotaLabel?.trim() || 'custom endpoint';

  const upsert = db.transaction(() => {
    const { keyId, storedKey: storedKeyForMask } = resolveCustomEndpointKey(db, baseUrl, providedKey, label);
    // The upsert itself is shared with the classified branch of POST
    // /api/keys/custom (#1051).
    const { modelDbId } = registerCustomMediaModel(db, keyId, {
      modelId,
      displayName,
      modality: parsed.data.modality,
      quotaLabel,
    });
    return { modelDbId, keyId, storedKeyForMask };
  });

  const result = upsert();
  return new Response(JSON.stringify({
    success: true, keyId: result.keyId, modelDbId: result.modelDbId,
    platform: 'custom', baseUrl, model: modelId, displayName, modality: parsed.data.modality,
    maskedKey: maskKey(result.storedKeyForMask),
  }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}

const updateSchema = z.object({ enabled: z.boolean() });

// PUT /api/media/:id
export async function mediaUpdateRoute(req: Request, idStr: string): Promise<Response> {
  const id = Number(idStr);
  if (!Number.isInteger(id)) return new Response(JSON.stringify({ error: { message: 'Invalid id' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return new Response(JSON.stringify({ error: { message: 'Invalid request body' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const info = getDb().prepare('UPDATE media_models SET enabled = ? WHERE id = ?').run(parsed.data.enabled ? 1 : 0, id);
  if (info.changes === 0) return new Response(JSON.stringify({ error: { message: `Unknown media model ${id}` } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

// DELETE /api/media/custom/:id
export function mediaDeleteRoute(idStr: string): Response {
  const id = Number(idStr);
  if (!Number.isInteger(id)) return new Response(JSON.stringify({ error: { message: 'Invalid id' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const db = getDb();
  const row = db.prepare("SELECT key_id FROM media_models WHERE id = ? AND platform = 'custom'").get(id) as { key_id: number | null } | undefined;
  if (!row) return new Response(JSON.stringify({ error: { message: `Unknown custom media model ${id}` } }), { status: 404, headers: { 'Content-Type': 'application/json' } });

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM media_models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}
