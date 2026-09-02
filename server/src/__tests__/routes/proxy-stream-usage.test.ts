import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* SSE */ }
  return { status: res.status, body: json, raw };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

function addModel(modelId: string): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision)
    VALUES (?, ?, ?, 5, 5, 'Large', 100, NULL, NULL, NULL, '~10M', 131072, 1, 0)
  `).run('groq', modelId, modelId);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
  return id;
}

function addKey(): void {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt('gsk_test_key');
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'usage-key', ?, ?, ?, 'healthy', 1)
  `).run(encrypted, iv, authTag);
}

/** SSE Response whose frames deliberately contain NO usage block. */
function sseResponseNoUsage(text = 'hi') {
  const encoder = new TextEncoder();
  const frames = [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const f of frames) controller.enqueue(encoder.encode(f)); controller.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** SSE Response whose final frame carries an upstream usage block. */
function sseResponseWithUsage() {
  const encoder = new TextEncoder();
  const frames = [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const f of frames) controller.enqueue(encoder.encode(f)); controller.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** SSE Response with usage emitted MID-STREAM (before the finish chunk). */
function sseResponseUsageMidStream() {
  const encoder = new TextEncoder();
  const frames = [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const f of frames) controller.enqueue(encoder.encode(f)); controller.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function usageFrames(raw: string) {
  return raw
    .split('\n\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((p) => p !== '[DONE]')
    .map((p) => JSON.parse(p))
    .filter((f) => f && f.usage);
}

describe('Streaming usage-frame fallback injection', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    // initDb seeds models.dev on first boot; short-circuit the network fetch
    // so the seed resolves in ms (wrapped in try/catch upstream) and the rest
    // of the suite starts from a fast, deterministic DB.
    const realFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('models.dev')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return realFetch(url as any);
    });
    initDb(':memory:');
    vi.restoreAllMocks();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id = 'tum-usage')").run();
    db.prepare("DELETE FROM models WHERE model_id = 'tum-usage'").run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    addModel('tum-usage');
    addKey();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects an estimated usage frame when the upstream never echoes one and include_usage is requested', async () => {
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com/openai/v1/chat/completions')) return sseResponseNoUsage() as any;
      return orig(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'tum-usage',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);
    const frames = usageFrames(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0].choices).toEqual([]);
    expect(frames[0].usage.prompt_tokens).toBeGreaterThan(0);
    expect(frames[0].usage.completion_tokens).toBeGreaterThan(0);
    expect(frames[0].usage.total_tokens).toBe(
      frames[0].usage.prompt_tokens + frames[0].usage.completion_tokens,
    );
    expect(frames[0].usage.estimated).toBe(true);
  });

  it('does NOT inject a usage frame when include_usage is not requested', async () => {
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com/openai/v1/chat/completions')) return sseResponseNoUsage() as any;
      return orig(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'tum-usage',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, authHeaders());

    expect(status).toBe(200);
    expect(usageFrames(raw)).toHaveLength(0);
  });

  it('passes through the upstream usage frame unchanged when one is present', async () => {
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com/openai/v1/chat/completions')) return sseResponseWithUsage() as any;
      return orig(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'tum-usage',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);
    const frames = usageFrames(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0].usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 2,
      total_tokens: 13,
    });
    expect(frames[0].usage).not.toHaveProperty('estimated');
  });

  it('does NOT inject an estimate when the upstream emits a usage frame mid-stream', async () => {
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com/openai/v1/chat/completions')) return sseResponseUsageMidStream() as any;
      return orig(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'tum-usage',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);
    // The upstream's real mid-stream frame must be the ONLY usage frame —
    // no estimate injected on top of it.
    const frames = usageFrames(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0].usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 2,
      total_tokens: 13,
    });
  });
});