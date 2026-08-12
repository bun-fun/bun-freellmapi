// ── Local catalog seed for catalog-managed platforms ───────────────────────
//
// In the upstream, models for newer providers (agnes, reka, siliconflow, etc.)
// are distributed via the catalog-sync service (api.freellmapi.co), NOT via
// bundled migrations. A fresh install has zero rows for these platforms — the
// catalog sync fetches them at runtime.
//
// This Bun fork does not have the catalog-sync service, so we seed the known
// models locally. Model information is sourced from:
//   - server/src/providers/index.ts live-probe comments
//   - server/src/db/model-pricing.ts pricing entries
//   - provider /v1/models endpoints (where publicly accessible)
//
// The seed is idempotent (INSERT OR IGNORE) and safe to re-run on every boot.
// Existing user edits (enabled flag, limits) are never overwritten.

import type { DatabaseType } from '../db/index.js';

interface CatalogModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
}

interface CatalogMediaModel {
  platform: string;
  modelId: string;
  displayName: string;
  mediaType: string; // 'image' | 'audio'
}

// ── Chat models ────────────────────────────────────────────────────────────

const CATALOG_MODELS: CatalogModel[] = [
  // Agnes AI (Sapiens AI) — OpenAI-compatible, backed by LiteLLM + vLLM.
  // $0/token promotional free tier; free key from platform.agnes-ai.com (no card).
  // agnes-2.0-flash reasons before answering (live-probed 20s TTFB).
  {
    platform: 'agnes',
    modelId: 'agnes-2.0-flash',
    displayName: 'Agnes 2.0 Flash',
    intelligenceRank: 8,
    speedRank: 8,
    sizeLabel: 'Medium',
    rpmLimit: 30,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: 'free (promo)',
    contextWindow: 131072,
    supportsTools: true,
  },
  {
    platform: 'agnes',
    modelId: 'agnes-2.5-flash',
    displayName: 'Agnes 2.5 Flash',
    intelligenceRank: 6,
    speedRank: 7,
    sizeLabel: 'Medium',
    rpmLimit: 30,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: 'free (promo)',
    contextWindow: 131072,
    supportsTools: true,
  },

  // Reka — OpenAI-compatible (api.reka.ai/v1). Free via recurring monthly
  // credit grant (no card; key from platform.reka.ai).
  // reka-flash-3: text reasoning. reka-edge-2603: natively multimodal (image/video).
  {
    platform: 'reka',
    modelId: 'reka-flash-3',
    displayName: 'Reka Flash 3',
    intelligenceRank: 7,
    speedRank: 5,
    sizeLabel: 'Large',
    rpmLimit: null,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: 'credits-based',
    contextWindow: 128000,
    supportsTools: true,
  },
  {
    platform: 'reka',
    modelId: 'reka-edge-2603',
    displayName: 'Reka Edge 2603',
    intelligenceRank: 10,
    speedRank: 4,
    sizeLabel: 'Medium',
    rpmLimit: null,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: 'credits-based',
    contextWindow: 64000,
    supportsVision: true,
    supportsTools: true,
  },

  // NaraRouter — OpenAI-compatible aggregator (router.bynara.id/v1).
  // Live probed 2026-07-09: mistral-large, mistral-medium-3-5, and tencent-hy3
  // answered 200 with a zero-balance account.
  {
    platform: 'nara',
    modelId: 'mistral-large',
    displayName: 'Mistral Large (NaraRouter)',
    intelligenceRank: 5,
    speedRank: 8,
    sizeLabel: 'Large',
    rpmLimit: 20,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: 'free (daily reset)',
    contextWindow: 131072,
    supportsTools: true,
  },
  {
    platform: 'nara',
    modelId: 'mistral-medium-3-5',
    displayName: 'Mistral Medium 3.5 (NaraRouter)',
    intelligenceRank: 8,
    speedRank: 6,
    sizeLabel: 'Medium',
    rpmLimit: 20,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: 'free (daily reset)',
    contextWindow: 131072,
    supportsTools: true,
  },
  {
    platform: 'nara',
    modelId: 'tencent-hy3',
    displayName: 'Tencent HY3 (NaraRouter)',
    intelligenceRank: 9,
    speedRank: 7,
    sizeLabel: 'Medium',
    rpmLimit: 20,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: 'free (daily reset)',
    contextWindow: 32768,
    supportsTools: true,
  },

  // BazaarLink — OpenAI-compatible aggregator (bazaarlink.ai/api/v1).
  // The 'auto:free' route picks a currently-available zero-cost model.
  {
    platform: 'bazaarlink',
    modelId: 'auto:free',
    displayName: 'Auto Free (BazaarLink)',
    intelligenceRank: 10,
    speedRank: 8,
    sizeLabel: 'Medium',
    rpmLimit: 5,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: 'free (auto-route)',
    contextWindow: 131072,
    supportsTools: true,
  },
];

// ── Media models (generative-media platforms) ──────────────────────────────

const CATALOG_MEDIA_MODELS: CatalogMediaModel[] = [
  // SiliconFlow — FREE generative-media models (no card; key from siliconflow.com).
  // FLUX.1-schnell: image generation. CosyVoice2: TTS.
  {
    platform: 'siliconflow',
    modelId: 'black-forest-labs/FLUX.1-schnell',
    displayName: 'FLUX.1 Schnell (SiliconFlow)',
    mediaType: 'image',
  },
  {
    platform: 'siliconflow',
    modelId: 'FunAudioLLM/CosyVoice2-0.5B',
    displayName: 'CosyVoice2 0.5B (SiliconFlow)',
    mediaType: 'audio',
  },
];

/**
 * Seed catalog-managed platform models that are not in models.dev and would
 * normally come from the catalog-sync service. Idempotent: uses INSERT OR IGNORE
 * and only runs for platforms with zero rows, so user edits are never overwritten.
 */
export function seedCatalogModels(db: DatabaseType): void {
  let inserted = 0;

  // ── Chat models ──────────────────────────────────────────────────────────
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
      monthly_token_budget, context_window, enabled,
      supports_vision, supports_tools, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'catalog')
  `);

  // Only seed models for platforms that have zero catalog rows — this respects
  // any user-added models and avoids duplicate work.
  const platformCounts = new Map<string, number>();
  for (const m of CATALOG_MODELS) {
    if (!platformCounts.has(m.platform)) {
      const row = db.prepare(
        'SELECT COUNT(*) AS c FROM models WHERE platform = ?',
      ).get(m.platform) as { c: number };
      platformCounts.set(m.platform, row.c);
    }
  }

  const tx = db.transaction(() => {
    for (const m of CATALOG_MODELS) {
      // Skip if the platform already has models (user or prior seed added them)
      if ((platformCounts.get(m.platform) ?? 0) > 0) continue;

      const result = insertModel.run(
        m.platform,
        m.modelId,
        m.displayName,
        m.intelligenceRank,
        m.speedRank,
        m.sizeLabel,
        m.rpmLimit,
        m.rpdLimit,
        m.tpmLimit,
        m.tpdLimit,
        m.monthlyTokenBudget,
        m.contextWindow,
        m.supportsVision ? 1 : 0,
        m.supportsTools ? 1 : 0,
      );
      if (result.changes > 0) {
        inserted++;
        // Add a fallback_config entry for the new model
        const modelRow = db.prepare(
          'SELECT id FROM models WHERE platform = ? AND model_id = ?',
        ).get(m.platform, m.modelId) as { id: number } | undefined;
        if (modelRow) {
          const maxPriority = (db.prepare(
            'SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config',
          ).get() as { mx: number }).mx;
          db.prepare(
            'INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
          ).run(modelRow.id, maxPriority + 1);
        }
      }
    }
  });
  tx();

  // ── Media models ─────────────────────────────────────────────────────────
  const insertMedia = db.prepare(`
    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, enabled)
    VALUES (?, ?, ?, ?, 1)
  `);

  const mediaTx = db.transaction(() => {
    for (const m of CATALOG_MEDIA_MODELS) {
      insertMedia.run(m.platform, m.modelId, m.displayName, m.mediaType);
    }
  });
  mediaTx();

  if (inserted > 0) {
    console.log(`[DB] Seeded ${inserted} catalog-managed models (agnes, reka, nara, bazaarlink)`);
  }
}
