import type { Db } from '../db/types.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { getProvider } from '../providers/index.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { discoverProviderModels, type DiscoveredModel } from './model-discovery.js';
import { customModelSeed } from './custom-model-seed.js';
import { ensureModelInProfiles } from './profile-models.js';

// ── Live model discovery for a NATIVE platform key (#longcat) ────────────────
//
// Models for native platforms (google, groq, longcat, ...) normally come from
// the models.dev catalog: the seed and the periodic sync register them, and
// routing dispatches a `platform=X` row through the registered provider's own
// base_url. But a provider that the catalog doesn't cover (models.dev has zero
// longcat entries, and its model list — like any relay's — changes weekly) would
// then have a selectable key and NOTHING to route to.
//
// The catalog is not the only source of truth: the provider's OWN `/models`
// endpoint, queried with the key, lists exactly what that key can reach. The
// custom-endpoint path (#488) already does this by asking a user base_url; this
// does the same for a NAMED native platform whose registered provider knows its
// own URL. Discovered models register as `platform=<platform>` catalog rows with
// source 'user' (so catalog sync never prunes them) and endpoint_scope '' (the
// native shape, so routing uses the registered provider, not a per-endpoint one).

export interface NativeModelDiscoveryResult {
  platform: string;
  baseUrl: string;
  discovered: DiscoveredModel[];
  total: number;
  registered: number;
}

/**
 * Discover and register a native platform's live model list, driven by the
 * platform's REGISTERED provider and its `/models` endpoint.
 *
 * Only OpenAI-compatible providers are discoverable — a platform whose adapter
 * isn't an OpenAICompatProvider exposes no `fetchModelCatalog`, so it returns a
 * `null` result instead of throwing.
 *
 * Registration is best-effort and idempotent: a model already present for the
 * platform keeps its row (and its manually tuned ranks); a genuinely new id is
 * inserted (enabled) and wired into the fallback chain and every profile, the
 * same way a freshly registered custom or catalog model is.
 */
export async function discoverNativePlatformModels(
  db: Db,
  platform: Platform,
  apiKey: string,
): Promise<NativeModelDiscoveryResult | null> {
  const provider = getProvider(platform);
  if (!provider || !(provider instanceof OpenAICompatProvider)) {
    return null;
  }
  const baseUrl = provider.modelsUrl.replace(/\/models$/, '');

  const discovered = await discoverProviderModels(provider, apiKey);
  if (discovered.length === 0) {
    return { platform, baseUrl, discovered: [], total: 0, registered: 0 };
  }

  const seed = customModelSeed(db);
  const registered = db.transaction(() => {
    let count = 0;
    for (const model of discovered) {
      // Only the chat-style rows land in the models table. A discovery payload
      // whose ids are discernibly media/embedding models is not a chat catalog
      // — skip them here rather than register chat rows that 404 forever.
      if (model.kind !== undefined) continue;

      const existing = db.prepare(
        "SELECT id, enabled FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''",
      ).get(platform, model.id) as { id: number; enabled: number } | undefined;

      if (existing) {
        db.prepare(
          "UPDATE models SET enabled = 1 WHERE id = ?",
        ).run(existing.id);
        continue;
      }

      db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled,
           supports_vision, supports_tools, source, endpoint_scope)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', ?, 1,
           COALESCE(?, 0), 1, 'user', '')
      `).run(
        platform, model.id, model.id,
        seed.intelligenceRank, seed.speedRank, seed.sizeLabel,
        model.contextWindow ?? null,
        model.vision === true ? 1 : 0,
      );

      const modelRow = db.prepare(
        "SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''",
      ).get(platform, model.id) as { id: number } | undefined;
      if (modelRow) {
        const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
        if (!inChain) {
          const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
          db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelRow.id, max.m + 1);
        }
        ensureModelInProfiles(db, modelRow.id);
      }
      count++;
    }
    return count;
  })();

  return { platform, baseUrl, discovered, total: discovered.length, registered };
}