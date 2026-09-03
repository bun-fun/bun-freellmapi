import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  runModelsDevSync,
  modelsDevSyncIntervalMs,
  startModelsDevSync,
} from '../../services/models-dev-sync.js';
import type { ModelsDevModel } from '../../services/modelsDev.js';
import type { Scheduler } from '../../lib/scheduler.js';

const ORIGINAL_INTERVAL = process.env.MODELS_DEV_SYNC_INTERVAL_MS;

/** Build a models.dev payload with the given free ids. Native provider ids
 *  (e.g. `google/...`) stay on their platform; `:free` ids route to openrouter. */
function feed(ids: string[], extra: Partial<ModelsDevModel> = {}): ModelsDevModel[] {
  return ids.map((id) => ({
    id,
    name: id,
    context_length: 128000,
    pricing: { prompt: '0', completion: '0' },
    ...extra,
  }));
}

function modelRow(modelId: string, platform = 'google'): { id: number; enabled: number; dev_managed: number } | undefined {
  return getDb().prepare(
    'SELECT id, enabled, dev_managed FROM models WHERE platform = ? AND model_id = ?',
  ).get(platform, modelId) as { id: number; enabled: number; dev_managed: number } | undefined;
}

function fallbackEnabled(id: number): number | undefined {
  const row = getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(id) as { enabled: number } | undefined;
  return row?.enabled;
}

describe('models-dev-sync', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    // Ditch whatever the empty seed produced so each test owns the rows.
    getDb().exec('DELETE FROM fallback_config; DELETE FROM profile_models; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    // Give the backfill a deterministic target profile (initDb may not have an
    // awaited one under the async-seed race).
    getDb().prepare(`INSERT INTO profiles (name, type) VALUES ('test', 'custom')`).run();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_INTERVAL === undefined) {
      delete process.env.MODELS_DEV_SYNC_INTERVAL_MS;
    } else {
      process.env.MODELS_DEV_SYNC_INTERVAL_MS = ORIGINAL_INTERVAL;
    }
  });

  it('adds brand-new free models with fallback and profile rows', async () => {
    const result = await runModelsDevSync(getDb(), async () =>
      feed(['google/gemini-2.0-flash', 'groq/llama-3.3-70b-versatile']));

    const gemini = modelRow('gemini-2.0-flash', 'google');
    const llama = modelRow('llama-3.3-70b-versatile', 'groq');
    expect(gemini).toBeDefined();
    expect(llama).toBeDefined();
    expect(gemini!.dev_managed).toBe(1);
    expect(llama!.dev_managed).toBe(1);
    expect(result!.added).toBe(2);
    expect(fallbackEnabled(gemini!.id)).toBe(1);
    // Profile rows backfilled.
    const pm = getDb().prepare('SELECT 1 FROM profile_models WHERE model_db_id = ?').get(gemini!.id);
    expect(pm).toBeDefined();
    expect(gemini!.enabled).toBe(1);
  });

  it('retires a dev_managed model that left the free feed (disables, does not delete)', async () => {
    await runModelsDevSync(getDb(), async () =>
      feed(['google/gemini-2.0-flash', 'groq/llama-3.3-70b-versatile']));
    const llama = modelRow('llama-3.3-70b-versatile', 'groq')!;
    expect(llama.enabled).toBe(1);

    // Next fetch: llama dropped out.
    const result = await runModelsDevSync(getDb(), async () =>
      feed(['google/gemini-2.0-flash']));

    const after = modelRow('llama-3.3-70b-versatile', 'groq')!;
    expect(after).toBeDefined();            // not deleted
    expect(after.enabled).toBe(0);          // disabled
    expect(fallbackEnabled(after.id)).toBe(0);
    const pm = getDb().prepare('SELECT enabled FROM profile_models WHERE model_db_id = ?').get(after.id) as { enabled: number };
    expect(pm.enabled).toBe(0);
    expect(result!.retired).toBe(1);
  });

  it('does not auto-re-enable a retired model when it returns; that is the operator\'s call', async () => {
    await runModelsDevSync(getDb(), async () =>
      feed(['google/gemini-2.0-flash', 'groq/llama-3.3-70b-versatile']));
    await runModelsDevSync(getDb(), async () =>
      feed(['google/gemini-2.0-flash']));
    const llama = modelRow('llama-3.3-70b-versatile', 'groq')!;
    expect(llama.enabled).toBe(0);

    // Back in the feed — but the sync is purely additive on enable state.
    await runModelsDevSync(getDb(), async () =>
      feed(['google/gemini-2.0-flash', 'groq/llama-3.3-70b-versatile']));

    const after = modelRow('llama-3.3-70b-versatile', 'groq')!;
    expect(after.enabled).toBe(0);          // stays disabled until operator flips it
    expect(after).toBeDefined();            // row preserved for them to flip
  });

  it('honours an operator disable instead of force re-enabling', async () => {
    await runModelsDevSync(getDb(), async () => feed(['google/gemini-2.0-flash']));
    const gemini = modelRow('gemini-2.0-flash', 'google')!;
    // Operator flips it off in the dashboard.
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(gemini.id);
    getDb().prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(gemini.id);

    const result = await runModelsDevSync(getDb(), async () => feed(['google/gemini-2.0-flash']));

    const after = modelRow('gemini-2.0-flash', 'google')!;
    expect(after.enabled).toBe(0);          // still off
    expect(result!.skipped).toBe(1);        // recorded as honored skip
  });

  it('never touches rows this feed does not own (user / catalog-seed)', async () => {
    // A user-sourced row present now, absent from the feed.
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                          size_label, context_window, enabled, source, dev_managed)
      VALUES ('openrouter', 'user/my-model', 'User Model', 5, 5, 'Large', 1000, 1, 'user', 0)
    `).run();

    const result = await runModelsDevSync(getDb(), async () => feed(['google/gemini-2.0-flash']));

    const keep = modelRow('user/my-model', 'openrouter')!;
    expect(keep).toBeDefined();
    expect(keep.enabled).toBe(1);           // not disabled
    expect(result!.retired).toBe(0);
  });

  it('refreshes metadata (display name / context window) in place', async () => {
    await runModelsDevSync(getDb(), async () => feed(['google/gemini-2.0-flash']));
    const gemini = modelRow('gemini-2.0-flash', 'google')!;

    const result = await runModelsDevSync(getDb(), async () =>
      feed(['google/gemini-2.0-flash'], { name: 'gemini-2.0-flash', context_length: 1000000 }));

    const after = getDb().prepare('SELECT display_name, context_window FROM models WHERE id = ?').get(gemini.id) as {
      display_name: string; context_window: number;
    };
    expect(after.display_name).toBe('gemini-2.0-flash');
    expect(after.context_window).toBe(1000000);
    expect(result!.updated).toBeGreaterThan(0);
  });

  it('tolerates a fetch failure, returning null and leaving state intact', async () => {
    await runModelsDevSync(getDb(), async () => feed(['google/gemini-2.0-flash']));
    const gemini = modelRow('gemini-2.0-flash', 'google')!;

    const result = await runModelsDevSync(getDb(), async () => { throw new Error('network down'); });

    expect(result).toBeNull();
    expect(modelRow('gemini-2.0-flash', 'google')!.enabled).toBe(1);
    expect(gemini).toBeDefined();
  });

  it('interval helpers: default, env override, and 0 disables', () => {
    delete process.env.MODELS_DEV_SYNC_INTERVAL_MS;
    expect(modelsDevSyncIntervalMs()).toBe(12 * 60 * 60 * 1000);
    process.env.MODELS_DEV_SYNC_INTERVAL_MS = '60000';
    expect(modelsDevSyncIntervalMs()).toBe(60000);
    process.env.MODELS_DEV_SYNC_INTERVAL_MS = '0';
    expect(modelsDevSyncIntervalMs()).toBe(0);
  });

  it('startModelsDevSync registers a job, and none when interval is 0', () => {
    const every: { ms: number; fn: () => void }[] = [];
    const scheduler: Scheduler = {
      every(ms, fn) { every.push({ ms, fn } as any); return () => {}; },
      after() { return () => {}; },
    };

    process.env.MODELS_DEV_SYNC_INTERVAL_MS = '60000';
    startModelsDevSync(getDb(), scheduler);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(60000);

    process.env.MODELS_DEV_SYNC_INTERVAL_MS = '0';
    const noJob = startModelsDevSync(getDb(), scheduler);
    expect(noJob).toBeNull();
    expect(every).toHaveLength(1);
  });

  it('MODELS_DEV_SYNC_DISABLED=1 registers nothing', () => {
    process.env.MODELS_DEV_SYNC_DISABLED = '1';
    const every: { ms: number; fn: () => void }[] = [];
    const scheduler: Scheduler = {
      every(ms, fn) { every.push({ ms, fn } as any); return () => {}; },
      after() { return () => {}; },
    };
    expect(startModelsDevSync(getDb(), scheduler)).toBeNull();
    expect(every).toHaveLength(0);
    delete process.env.MODELS_DEV_SYNC_DISABLED;
  });
});