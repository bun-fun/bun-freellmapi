import { z } from 'zod';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import {
  routeRequest, recordRateLimitHit, recordSuccess,
  routingReserveTokens, type RouteResult,
} from '../../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { contentToString } from '../../lib/content.js';
import { routedViaValue } from '../../lib/header-value.js';
import { logRequest } from '../../lib/request-log.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import { applyTokenBudget, tokenBudgetMessage } from '../../lib/guardrails.js';

// Legacy OpenAI /v1/completions endpoint. Converts the prompt/suffix format to
// internal ChatMessage[] and routes through the same retry/fallback loop.

const MAX_RETRIES = 20;

const CompletionBody = z.object({
  model: z.string().optional(),
  prompt: z.string().default(''),
  suffix: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

function completionPromptToMessages(prompt: string, suffix?: string): ChatMessage[] {
  if (suffix) {
    return [{
      role: 'user',
      content: `${prompt}\n\nComplete the text before this suffix:\n${suffix}`,
    }];
  }
  return [{ role: 'user', content: prompt }];
}

function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error');
}

export async function completionsRoute(req: Request): Promise<Response> {
  const start = Date.now();

  // Auth
  const authHeader = req.headers.get('authorization');
  const clientIP = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
  const isLocal = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1';

  if (authHeader && !isLocal) {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const unifiedKey = getUnifiedApiKey();
    if (token !== unifiedKey) {
      return new Response(JSON.stringify({
        error: { message: 'Invalid API key', type: 'authentication_error' },
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({
      error: { message: 'Invalid JSON', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = CompletionBody.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({
      error: { message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`, type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { model: requestedModel, prompt, suffix, temperature, top_p, stream } = parsed.data;
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : 128;
  const messages = completionPromptToMessages(prompt, suffix);
  const estimatedInputTokens = messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
  const estimatedTotal = estimatedInputTokens + routingReserveTokens(max_tokens);

  const budgetCheck = applyTokenBudget(estimatedInputTokens, max_tokens);
  if (budgetCheck.rejection) {
    return new Response(JSON.stringify({
      error: { message: tokenBudgetMessage(budgetCheck.rejection), type: 'invalid_request_error', code: 'request_token_budget' },
    }), { status: 413, headers: { 'Content-Type': 'application/json' } });
  }

  // Determine model
  let preferredModel: number | undefined;
  const requestedModelLabel = requestedModel ?? 'auto';
  if (requestedModelLabel !== 'auto' && !requestedModelLabel.toLowerCase().startsWith('auto:')) {
    const row = getDb()
      .prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1')
      .get(requestedModelLabel) as { id: number } | undefined;
    if (row) preferredModel = row.id;
  }

  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel);
    } catch (err: any) {
      if (lastError) {
        return new Response(JSON.stringify({
          error: { message: `All models rate-limited. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`, type: 'rate_limit_error' },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      } else {
        return new Response(JSON.stringify({
          error: { message: sanitizeProviderErrorMessage(err.message), type: 'routing_error' },
        }), { status: err.status ?? 503, headers: { 'Content-Type': 'application/json' } });
      }
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        const gen = route.provider.streamChatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p },
        );

        const encoder = new TextEncoder();
        const streamBody = new ReadableStream({
          async pull(controller) {
            try {
              const { value, done } = await gen.next();
              if (done) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
                return;
              }
              const text = value.choices?.[0]?.delta?.content ?? '';
              const data = `data: ${JSON.stringify(value)}\n\n`;
              controller.enqueue(encoder.encode(data));
            } catch (err) {
              controller.error(err);
            }
          },
        });

        return new Response(streamBody, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Routed-Via': routedViaValue(route.platform, route.modelId),
            ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}),
          },
        });
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p },
        );

        const text = contentToString(result.choices[0]?.message?.content ?? '');
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);

        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? (promptTokens + completionTokens));
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null);

        // Convert to legacy completions format
        const completionResponse = {
          id: `cmpl_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          object: 'text_completion',
          created: Math.floor(Date.now() / 1000),
          model: route.modelId,
          choices: [{
            text,
            index: 0,
            logprobs: null,
            finish_reason: result.choices[0]?.finish_reason ?? 'stop',
          }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        };

        return new Response(JSON.stringify(completionResponse), {
          headers: {
            'Content-Type': 'application/json',
            'X-Routed-Via': routedViaValue(route.platform, route.modelId),
            ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}),
          },
        });
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, sanitizeProviderErrorMessage(err.message));

      if (isRetryableError(err)) {
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        setCooldown(route.platform, route.modelId, route.keyId, 120000);
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        continue;
      }

      return new Response(JSON.stringify({
        error: { message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`, type: 'provider_error' },
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify({
    error: { message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message ?? 'unknown'}`, type: 'rate_limit_error' },
  }), { status: 429, headers: { 'Content-Type': 'application/json' } });
}
