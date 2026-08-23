import type { ChatMessage } from '@freellmapi/shared/types.js';
import {
  routeRequest, recordRateLimitHit, recordSuccess,
  type RouteResult
} from '../../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { truncateMessagesForGithub } from '../../lib/content.js';
import { isUpstreamClassificationOutput } from '../../lib/error-classify.js';
import { z } from 'zod';

// Sticky sessions
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000;

function getSessionKey(messages: ChatMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '';
  return `${firstUser.content.slice(0, 100)}:${messages.length > 2 ? 'multi' : 'single'}`;
}

function getStickyModel(messages: ChatMessage[]): number | undefined {
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;
  const key = getSessionKey(messages);
  if (!key) return undefined;
  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(messages: ChatMessage[], modelDbId: number) {
  const key = getSessionKey(messages);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

// Validation schemas
const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.string(),
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).refine((msg) => {
  const hasContent = typeof msg.content === 'string' && msg.content.length > 0;
  const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
  return hasContent || hasToolCalls;
}, { message: 'assistant messages must include non-empty content or tool_calls' });

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.string(),
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1) }),
  }),
]);

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema, userMessageSchema, assistantMessageSchema, toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

const MAX_RETRIES = 20;

function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error');
}

function logRequest(
  platform: string, modelId: string, status: string,
  inputTokens: number, outputTokens: number, latencyMs: number, error: string | null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, error);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}

export async function proxyRoute(req: Request, _url: URL): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const start = Date.now();

  // OpenAI-compatible /models endpoint
  if (path === '/v1/models' && req.method === 'GET') {
    const db = getDb();
    const models = db.prepare(
      'SELECT platform, model_id, display_name, context_window FROM models WHERE enabled = 1 ORDER BY intelligence_rank'
    ).all() as any[];
    return new Response(JSON.stringify({
      object: 'list',
      data: models.map(m => ({
        id: m.model_id,
        object: 'model',
        created: 0,
        owned_by: m.platform,
        name: m.display_name,
        context_window: m.context_window,
      })),
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Chat completions
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    // Authenticate
    const authHeader = req.headers.get('authorization');
    const clientIP = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
    const isLocal = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1';
    if (authHeader && !isLocal) {
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const unifiedKey = getUnifiedApiKey();
      if (token !== unifiedKey) {
        return new Response(JSON.stringify({
          error: { message: 'Invalid API key', type: 'authentication_error' }
        }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Parse and validate body
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({
        error: { message: 'Invalid JSON', type: 'invalid_request_error' }
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const parsed = chatCompletionSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({
        error: {
          message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
          type: 'invalid_request_error',
        }
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const {
      model: requestedModel, temperature, max_tokens, top_p, stream,
      tools, tool_choice, parallel_tool_calls, messages: rawMessages
    } = parsed.data;

    const messages: ChatMessage[] = rawMessages.map((m: any): ChatMessage => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.content ?? null,
          ...(m.name ? { name: m.name } : {}),
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        };
      }
      if (m.role === 'tool') {
        return {
          role: 'tool',
          content: m.content,
          tool_call_id: m.tool_call_id,
          ...(m.name ? { name: m.name } : {}),
        };
      }
      return {
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      };
    });

    const estimatedInputTokens = messages.reduce((sum, m) => {
      if (typeof m.content !== 'string') return sum;
      return sum + Math.ceil(m.content.length / 4);
    }, 0);
    const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

    // Determine model
    let preferredModel: number | undefined;
    if (requestedModel) {
      const row = getDb()
        .prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1')
        .get(requestedModel) as { id: number } | undefined;
      if (row) preferredModel = row.id;
    }
    if (preferredModel === undefined) {
      preferredModel = getStickyModel(messages);
    }

    // Retry loop
    const skipKeys = new Set<string>();
    let lastError: any = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let route: RouteResult;
      try {
        route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel);
      } catch (err: any) {
        if (lastError) {
          return new Response(JSON.stringify({
            error: {
              message: `All models rate-limited. Last error: ${lastError.message}`,
              type: 'rate_limit_error',
            }
          }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        } else {
          return new Response(JSON.stringify({
            error: { message: err.message, type: 'routing_error' }
          }), { status: err.status ?? 503, headers: { 'Content-Type': 'application/json' } });
        }
      }

      recordRequest(route.platform, route.modelId, route.keyId);

      // Same GitHub input ceiling as upstream: trim the dispatched copy so a
      // long legacy prompt doesn't 413 the github hop.
      const dispatchMessages = route.platform === 'github'
        ? truncateMessagesForGithub(messages)
        : messages;

      try {
        if (stream) {
          // Streaming
          const gen = route.provider.streamChatCompletion(
            route.apiKey, dispatchMessages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
          );

          let totalOutputTokens = 0;
          const stream = new ReadableStream({
            async pull(controller) {
              try {
                const { value, done } = await gen.next();
                if (done) {
                  const doneChunk = new TextEncoder().encode('data: [DONE]\n\n');
                  controller.enqueue(doneChunk);
                  controller.close();
                  recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
                  recordSuccess(route.modelDbId);
                  setStickyModel(messages, route.modelDbId);
                  logRequest(
                    route.platform, route.modelId, 'success',
                    estimatedInputTokens, totalOutputTokens, Date.now() - start, null
                  );
                  return;
                }
                const chunk = value;
                const text = chunk.choices?.[0]?.delta?.content ?? '';
                totalOutputTokens += Math.ceil(text.length / 4);
                const data = `data: ${JSON.stringify(chunk)}\n\n`;
                controller.enqueue(new TextEncoder().encode(data));
              } catch (err) {
                controller.error(err);
              }
            },
          });

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Routed-Via': `${route.platform}/${route.modelId}`,
              ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}),
            },
          });
        } else {
          // Non-streaming
          const result = await route.provider.chatCompletion(
            route.apiKey, dispatchMessages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
          );
          // #809: a bare "safe"/"unsafe" classification word from a relay is
          // an upstream filter, not the requested model — fail over like an
          // empty completion.
          {
            const only = contentToString(result.choices?.[0]?.message?.content ?? '');
            if (isUpstreamClassificationOutput(only, route.platform)
              && (result.choices?.[0]?.message?.tool_calls ?? []).length === 0) {
              throw new Error(`empty completion from ${route.displayName} (upstream classification output)`);
            }
          }
          const totalTokens = result.usage?.total_tokens ?? 0;
          recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId);

          logRequest(
            route.platform, route.modelId, 'success',
            result.usage?.prompt_tokens ?? 0,
            result.usage?.completion_tokens ?? 0,
            Date.now() - start, null
          );

          return new Response(JSON.stringify(result), {
            headers: {
              'Content-Type': 'application/json',
              'X-Routed-Via': `${route.platform}/${route.modelId}`,
              ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}),
            },
          });
        }
      } catch (err: any) {
        const latency = Date.now() - start;
        logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, err.message);

        if (isRetryableError(err)) {
          const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
          skipKeys.add(skipId);
          setCooldown(route.platform, route.modelId, route.keyId, 120000);
          recordRateLimitHit(route.modelDbId);
          lastError = err;
          console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
          continue;
        }

        // Non-retryable error
        return new Response(JSON.stringify({
          error: {
            message: `Provider error (${route.displayName}): ${err.message}`,
            type: 'provider_error',
          }
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Exhausted all retries
    return new Response(JSON.stringify({
      error: {
        message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
        type: 'rate_limit_error',
      }
    }), { status: 429, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Not Found', { status: 404 });
}
