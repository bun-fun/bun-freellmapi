import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Native-platform live model discovery on key add (#longcat).
//
// A native platform whose models are absent from the models.dev catalog (longcat
// is a relay with zero catalog entries and a weekly-changing model list) shows a
// selectable key but nothing to route to. The fix: on the FIRST key add, query
// the registered provider's OWN /models endpoint with that key and register
// what it returns as platform='longcat' rows, so the Models page lists them and
// routing dispatches them through the registered provider.
//
// NOTE: this route test pulls `createApp` → the full route chain → the zod-based
// sampling-params module, which is baseline-blocked by the pre-existing
// `z.number is not a function` vitest/zod-transform defect that also blocks the
// routing/anthropic/custom-model-discovery suites. Kept as forward-readiness; the
// underlying service logic is verified directly under plain Bun.

const LONG_CATALOG = {
  object: 'list',
  data: [
    { id: 'gpt-4o', owned_by: 'openai' },
    { id: 'claude-sonnet-4-5', owned_by: 'anthropic' },
    { id: 'deepseek-chat', owned_by: 'deepseek' },
  ],
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubRelay(payload: unknown, status = 200) {
  const mock = vi.fn(async () => jsonResponse(payload, status));
  globalThis.fetch = mock as any;
  return mock;
}

describe('native platform model discovery on key add (#longcat)', () => {
  let app: Express;
  const realFetch = globalThis.fetch;
  let dashToken = '';

  async function request(app: Express, method: string, path: string, body?: unknown, auth = true) {
    const server = app.listen(0, '127.0.0.1');
    const addr = server.address() as any;
    const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: data as any };
  }

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('discovers and registers longcat models from the provider /models on first key add', async () => {
    const mock = stubRelay(LONG_CATALOG);

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'longcat',
      key: 'LONGCAT_test-secret',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('longcat');
    expect(body.modelsAvailable).toBe(3);
    expect(body.modelsRegistered).toBe(3);
    expect(body.notice).toMatch(/discovered and registered 3 longcat model/i);

    // Queried the registered longcat provider's /models with the key.
    expect(String(mock.mock.calls[0]![0])).toBe('https://api.longcat.chat/openai/v1/models');
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer LONGCAT_test-secret');

    // GET /api/models now surfaces the discovered longcat rows.
    const { status: listStatus, body: listBody } = await request(app, 'GET', '/api/models');
    expect(listStatus).toBe(200);
    const longcatRows = (listBody as any[]).filter((m: any) => m.platform === 'longcat');
    expect(longcatRows.map((m: any) => m.modelId).sort())
      .toEqual(['claude-sonnet-4-5', 'deepseek-chat', 'gpt-4o'].sort());
    for (const row of longcatRows) {
      expect(row.hasProvider).toBe(true);
      expect(row.keyCount).toBe(1);
      expect(row.enabled).toBe(true);
    }
  });

  it('keeps the key saved when discovery fails, with a notice', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as any;

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'longcat',
      key: 'LONGCAT_test-secret',
    });

    // The save must never fail because discovery did.
    expect(status).toBe(201);
    expect(body.platform).toBe('longcat');
    expect(body.modelsAvailable).toBe(0);
    expect(body.notice).toMatch(/could not be auto-discovered/i);
  });

  it('does not re-discover when the platform already has catalog models', async () => {
    // Pre-seed a longcat row so modelsAvailable > 0.
    getDb().prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled,
         supports_vision, supports_tools, source, endpoint_scope)
      VALUES ('longcat', 'gpt-4o', 'gpt-4o', 50, 50, 'Medium', NULL, NULL, NULL, NULL, '', NULL, 1, 0, 1, 'user', '')
    `).run();
    const mock = stubRelay(LONG_CATALOG);

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'longcat',
      key: 'LONGCAT_test-secret-2',
    });

    expect(status).toBe(201);
    // No upstream /models fetch when the catalog already has a row.
    expect(mock.mock.calls).toHaveLength(0);
    expect(body.notice).toBeUndefined();
  });
});