import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import { fetchModelsDev, filterFreeModels, buildModelsDevEntries, type ModelsDevModel } from './modelsDev.js';
import { ensureModelInProfiles, ensureAllModelsInProfiles } from './profile-models.js';

// ── models.dev periodic refresh ───────────────────────────────────────────────
// models.dev is the free-model feed used to *seed* a fresh install
// (seedModelsFromModelsDev in db/index.ts), but seeding happens once, on an
// empty DB, so the local catalog never moves afterwards. A provider retires a
// model, a new free model ships, or a `:free` route goes paid — this install
// keeps routing to whatever models.dev said on day one. This pass makes that
// directory a live feed instead of a one-shot snapshot.
//
// On every scheduled run it reconciles the local `models` table against the
// current free list from models.dev, mirroring catalog-sync's very semantics
// but scoped to the rows *this* feed owns:
//   - ADD: brand-new free models are inserted (with fallback_config + profile
//     rows), so newly-available models appear without operator action.
//   - UPDATE: display name / context window / ranks track the feed for rows
//     the seed placed.
//   - RETIRE: a model that dropped out of the free feed (retired, or turned
//     paid) is DISABLED, not deleted — honoring the user's explicit ask to
//     "停用不可用模型" and keeping historical rows around in the dashboard.
//
// Safety rails that keep this from clobbering operator intent:
//   - Ownership is decided by the dev_managed provenance column: ONLY rows the
//     feed itself placed (dev_managed=1) are ever updated or disabled. Rows
//     with source='user' (declarative config, admin adds, custom endpoints)
//     and rows the signed catalog / bundled catalog-seed placed are never
//     touched, so a coexisting catalog can't be clobbered.
//   - A model the operator disabled stays disabled: this pass honors an
//     existing `enabled=0` instead of force re-enabling. It is purely
//     additive on the enable side — the operator is the sole authority for
//     turning a row back on, so a model that returns to the feed simply stays
//     put until they flip it.
//   - One failed fetch is logged and skipped; the schedule survives, and the
//     last good state is never destroyed by a failed poll.

/** Default: twice a day. Empty-DB seeding already covers day one; once a day
 *  tracks providers' daily availability drift without hammering models.dev. */
const DEFAULT_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Interval in ms from `MODELS_DEV_SYNC_INTERVAL_MS`; 0 disables the pass,
 *  anything unset or malformed falls back to the 12h default. */
export function modelsDevSyncIntervalMs(): number {
  const raw = process.env.MODELS_DEV_SYNC_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SYNC_INTERVAL_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SYNC_INTERVAL_MS;
}

export interface ModelsDevSyncResult {
  fetched: number;
  added: number;
  updated: number;
  /** Models disabled because they left the free feed (retired or now paid). */
  retired: number;
  /** Models the operator disabled that we honoured losing to their choice. */
  skipped: number;
  error?: string;
}

/** One reconcile pass. Exported so tests (and an admin handler) can run it
 *  directly without waiting for the timer. `fetchFeed` defaults to the real
 *  models.dev fetch and is injectable for tests. Returns null on fetch failure
 *  so the caller knows the last-good state was left untouched. */
export async function runModelsDevSync(
  db: Db,
  fetchFeed: () => Promise<ModelsDevModel[]> = fetchModelsDev,
): Promise<ModelsDevSyncResult | null> {
  let freeModels;
  try {
    const allModels = await fetchFeed();
    freeModels = filterFreeModels(allModels);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(`[models-dev-sync] fetch failed, keeping last-good state: ${message}`);
    return null;
  }

  const entries = buildModelsDevEntries(freeModels);
  const result: ModelsDevSyncResult = {
    fetched: freeModels.length, added: 0, updated: 0, retired: 0, skipped: 0,
  };

  const feedKeys = new Set(entries.map((e) => `${e.platform}:${e.modelId}`));

  // ── Upsert feed rows ──
  // Keyed on (platform, model_id) because a model could plausibly move between
  // providers in the feed (a native model gains a :free alias, or vice-versa).
  const selectRow = db.prepare(
    'SELECT id, enabled FROM models WHERE platform = ? AND model_id = ?',
  );
  const insertModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                        size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
                        monthly_token_budget, context_window, enabled, source, dev_managed)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', ?, 1, 'catalog', 1)
  `);
  const updateModel = db.prepare(`
    UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?,
                      size_label = ?, context_window = ? WHERE id = ?
  `);

  db.transaction(() => {
    for (const e of entries) {
      const row = selectRow.get(e.platform, e.modelId) as { id: number; enabled: number } | undefined;
      if (!row) {
        insertModel.run(
          e.platform, e.modelId, e.displayName, e.intelligenceRank, e.speedRank,
          e.sizeLabel, e.contextWindow,
        );
        result.added++;
        const inserted = selectRow.get(e.platform, e.modelId) as { id: number };
        // New model joins the fallback chain (tail) and every profile.
        const maxPrio = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
        db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
          .run(inserted.id, maxPrio + 1);
        ensureModelInProfiles(db, inserted.id);
      } else {
        // Honor an operator disable: refresh metadata but never flip enabled
        // back on a model the operator switched off themselves.
        if (row.enabled === 0) result.skipped++;
        updateModel.run(e.displayName, e.intelligenceRank, e.speedRank, e.sizeLabel, e.contextWindow, row.id);
        result.updated++;
      }
    }
    ensureAllModelsInProfiles(db);

    // ── Retire feed-owned rows the feed no longer lists free ──
    // Scope: dev_managed=1 only, so a signed-catalog / bundled-seed / user row
    // on the same platform is never touched. We DISABLE rather than delete
    // (keeps historical rows visible in the dashboard). Re-enabling is left to
    // the operator: the feed only ever turns models OFF, never ON.
    const owned = db.prepare(`
      SELECT id, platform, model_id FROM models
       WHERE platform != 'custom' AND key_id IS NULL AND dev_managed = 1
    `).all() as { id: number; platform: string; model_id: string }[];

    const disableFb = db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?');
    const disableProfile = db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?');
    const disableModel = db.prepare('UPDATE models SET enabled = 0 WHERE id = ? AND enabled = 1');

    for (const c of owned) {
      if (feedKeys.has(`${c.platform}:${c.model_id}`)) continue;
      const current = db.prepare('SELECT enabled FROM models WHERE id = ?').get(c.id) as { enabled: number };
      if (current.enabled !== 1) continue; // already off (operator or us before) 
      disableModel.run(c.id);
      disableFb.run(c.id);
      disableProfile.run(c.id);
      result.retired++;
    }
  })();

  console.log(
    `[models-dev-sync] ${entries.length} free models: +${result.added} added, ` +
    `${result.updated} updated, ${result.retired} retired`,
  );
  return result;
}

/** Register the periodic pass on the server's scheduler. Returns null when the
 *  interval is configured to 0 (disabled) or MODELS_DEV_SYNC_DISABLED=1. */
export function startModelsDevSync(db: Db, scheduler: Scheduler): (() => void) | null {
  if (process.env.MODELS_DEV_SYNC_DISABLED === '1') {
    console.log('[models-dev-sync] disabled via MODELS_DEV_SYNC_DISABLED=1');
    return null;
  }
  const intervalMs = modelsDevSyncIntervalMs();
  if (intervalMs <= 0) {
    console.log('[models-dev-sync] disabled via MODELS_DEV_SYNC_INTERVAL_MS=0');
    return null;
  }
  return scheduler.every(intervalMs, () => { void runModelsDevSync(db); }, { name: 'models-dev-sync' });
}