import { z } from 'zod';
import { getUnifiedApiKey } from '../../db/index.js';
import { runEmbeddings, EmbeddingsError } from '../../services/embeddings.js';

// OpenAI-compatible embeddings endpoint, routed through the embeddings family
// catalog: `model: "auto"` (or omitted) → the configured default family; a
// family name or provider model id → that family's provider chain. Failover
// only happens WITHIN a family (same model on another provider) — never across
// models, since vectors from different models are incompatible.

const EmbeddingsBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
  // Optional output-dimension override forwarded to providers that support MRL
  // truncation (NVIDIA NeMo NIM, Google Gemini Embedding, OpenAI v3).
  dimensions: z.number().int().positive().optional(),
});

export async function embeddingsRoute(req: Request, _url: URL): Promise<Response> {
  // Auth: accept Bearer token or x-api-key header (same as /v1/chat/completions)
  const authHeader = req.headers.get('authorization');
  const apiKeyHeader = req.headers.get('x-api-key');
  const clientIP = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
  const isLocal = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1';

  const token = authHeader
    ? authHeader.replace(/^Bearer\s+/i, '')
    : apiKeyHeader ?? '';

  if (token && !isLocal) {
    const unifiedKey = getUnifiedApiKey();
    if (token !== unifiedKey) {
      return new Response(JSON.stringify({
        error: { message: 'Invalid API key', type: 'authentication_error' },
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Parse body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({
      error: { message: 'Invalid JSON', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = EmbeddingsBody.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({
      error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];

  try {
    const result = await runEmbeddings(parsed.data.model, inputs, parsed.data.dimensions);
    return new Response(JSON.stringify({
      object: 'list',
      data: result.vectors.map((values, i) => ({
        object: 'embedding',
        index: i,
        embedding: values,
      })),
      model: result.family,
      provider: result.platform,
      usage: { prompt_tokens: result.inputTokens, total_tokens: result.inputTokens },
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    const type = status === 400 ? 'invalid_request_error'
      : status === 429 ? 'rate_limit_error'
      : 'server_error';
    return new Response(JSON.stringify({
      error: { message: `embedding error: ${err?.message ?? 'unknown'}`, type },
    }), { status, headers: { 'Content-Type': 'application/json' } });
  }
}
