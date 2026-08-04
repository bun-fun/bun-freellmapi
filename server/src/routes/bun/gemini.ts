import { z } from 'zod';
import type {
  ChatMessage, ChatToolCall, ChatToolDefinition, ChatToolChoice,
} from '@freellmapi/shared/types.js';
import {
  routeRequest, recordRateLimitHit, recordSuccess,
  routingReserveTokens, type RouteResult,
} from '../../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { contentToString } from '../../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../../lib/tool-args.js';
import { routedViaValue } from '../../lib/header-value.js';
import { logRequest } from '../../lib/request-log.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import {
  geminiContentsToMessages, geminiToolsToChatTools, geminiToolChoice,
  geminiResponseFormat, geminiFinishReason, geminiPartsFromResult,
  estimateGeminiTokens, effortFromGeminiThinking,
  type GeminiInboundRequest,
} from '../../lib/gemini-wire.js';
import { resolveGeminiModel } from '../../services/gemini-map.js';
import { buildModelListing } from '../../services/model-listing.js';

// Native Gemini wire surface for Gemini CLI and Gemini-lineage agents.
// POST /v1beta/models/{model}:generateContent
// POST /v1beta/models/{model}:streamGenerateContent
// GET  /v1beta/models
// GET  /v1beta/models/{model}
// POST /v1beta/models/{model}:countTokens

const MAX_RETRIES = 20;

function authenticate(req: Request): boolean {
  const url = new URL(req.url);
  const queryKey = url.searchParams.get('key')?.trim() ?? '';
  const authHeader = req.headers.get('authorization');
  const apiKeyHeader = req.headers.get('x-goog-api-key');
  const clientIP = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
  const isLocal = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1';

  const token = (authHeader ? authHeader.replace(/^Bearer\s+/i, '')
    : apiKeyHeader ?? queryKey) || '';

  if (token && !isLocal) {
    const unifiedKey = getUnifiedApiKey();
    return token === unifiedKey;
  }
  return true;
}

function sendError(status: number, message: string, code = 'INVALID_ARGUMENT'): Response {
  return new Response(JSON.stringify({
    error: { code: status, message, status: code.toUpperCase() },
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

function modelShape(model: ReturnType<typeof buildModelListing>['models'][number] | null, autoContextWindow: number | null, id = 'auto') {
  const context = model?.contextWindow ?? autoContextWindow ?? 128_000;
  return {
    name: `models/${model?.id ?? id}`,
    displayName: model?.name ?? 'Auto (router picks the best available model)',
    description: model
      ? `FreeLLMAPI catalog model served by ${model.ownedBy}`
      : 'FreeLLMAPI automatically selects the best available model',
    inputTokenLimit: context,
    outputTokenLimit: Math.min(8192, context),
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    version: model?.id ?? id,
  };
}

// GET /v1beta/models — list models
export function geminiModelsRoute(req: Request): Response {
  if (!authenticate(req)) return sendError(401, 'Invalid API key', 'UNAUTHENTICATED');
  const url = new URL(req.url);
  const { models, autoContextWindow } = buildModelListing();
  const availableOnly = (url.searchParams.get('available') ?? '').toLowerCase();
  const listed = ['1', 'true', 'yes'].includes(availableOnly)
    ? models.filter(m => m.available === 1)
    : models;
  return new Response(JSON.stringify({
    models: [
      modelShape(null, autoContextWindow),
      ...listed.map(m => modelShape(m, autoContextWindow)),
    ],
  }), { headers: { 'Content-Type': 'application/json' } });
}

// GET /v1beta/models/{model} — get model info
export function geminiModelRoute(req: Request, modelId: string): Response {
  if (!authenticate(req)) return sendError(401, 'Invalid API key', 'UNAUTHENTICATED');
  const { models, autoContextWindow } = buildModelListing();
  if (modelId === 'auto' || modelId === 'models/auto') {
    return new Response(JSON.stringify(modelShape(null, autoContextWindow)), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const id = modelId.replace(/^models\//, '');
  const model = models.find(m => m.id === id);
  if (!model) return sendError(404, `Model '${id}' was not found`, 'NOT_FOUND');
  return new Response(JSON.stringify(modelShape(model, autoContextWindow)), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const partSchema = z.object({}).passthrough();
const contentSchema = z.object({
  role: z.enum(['user', 'model']).optional(),
  parts: z.array(partSchema).optional(),
}).passthrough();
const generateSchema = z.object({
  contents: z.array(contentSchema).min(1),
  systemInstruction: z.object({ parts: z.array(partSchema).optional() }).passthrough().optional(),
  tools: z.array(z.object({}).passthrough()).optional(),
  toolConfig: z.object({}).passthrough().optional(),
  generationConfig: z.object({}).passthrough().optional(),
}).passthrough();

function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error');
}

// POST /v1beta/models/{model}:generateContent
// POST /v1beta/models/{model}:streamGenerateContent
export async function geminiGenerateRoute(req: Request, model: string, stream: boolean): Promise<Response> {
  if (!authenticate(req)) return sendError(401, 'Invalid API key', 'UNAUTHENTICATED');

  let body: any;
  try { body = await req.json(); } catch {
    return sendError(400, 'Invalid JSON');
  }

  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.errors.slice(0, 5)
      .map(e => `${e.path.join('.') || 'body'}: ${e.message}`).join(', ');
    return sendError(400, `Invalid Gemini request: ${detail}`);
  }

  const reqData = parsed.data as GeminiInboundRequest;
  const generation = reqData.generationConfig;
  const resolvedModel = resolveGeminiModel(model);
  const messages = geminiContentsToMessages(reqData);
  const tools = geminiToolsToChatTools(reqData.tools);
  const toolSchemas = toolSchemaMap(tools);
  const toolChoice = tools ? geminiToolChoice(reqData.toolConfig) : undefined;
  const responseFormat = geminiResponseFormat(generation);
  const reasoningEffort = effortFromGeminiThinking(generation);
  const maxTokens = generation?.maxOutputTokens ?? 8192;
  const temperature = generation?.temperature;
  const topP = generation?.topP;
  const topK = generation?.topK;
  const stop = generation?.stopSequences;

  const estimatedInputTokens = messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
  const estimatedTotal = estimatedInputTokens + routingReserveTokens(maxTokens);

  // Resolve model to DB id for routing preference
  let preferredModel: number | undefined;
  if (resolvedModel !== 'auto' && !resolvedModel.toLowerCase().startsWith('auto:')) {
    const row = getDb().prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(resolvedModel) as { id: number } | undefined;
    if (row) preferredModel = row.id;
  }

  const skipKeys = new Set<string>();
  let lastError: any = null;
  const start = Date.now();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(
        estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel, false, (tools?.length ?? 0) > 0,
      );
    } catch (err: any) {
      if (lastError) {
        return sendError(503, `All models rate-limited. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`, 'UNAVAILABLE');
      } else {
        return sendError(503, sanitizeProviderErrorMessage(err.message), 'UNAVAILABLE');
      }
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        const gen = route.provider.streamChatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens: maxTokens, top_p: topP, top_k: topK, stop, tools, tool_choice: toolChoice, response_format: responseFormat, reasoning_effort: reasoningEffort },
        );

        const encoder = new TextEncoder();
        const chunks: Uint8Array[] = [];
        let firstChunk = true;
        const altSse = (new URL(req.url).searchParams.get('alt') ?? '').toLowerCase() === 'sse';

        const write = (payload: Record<string, unknown>) => {
          const serialized = JSON.stringify(payload);
          if (altSse) {
            chunks.push(encoder.encode(`data: ${serialized}\n\n`));
          } else {
            chunks.push(encoder.encode(`${firstChunk ? '' : ','}\n${serialized}`));
            firstChunk = false;
          }
        };

        let outputTokens = 0;
        let finishReason: string | null = null;
        const toolAcc = new Map<number, { id?: string; name: string; args: string }>();

        for await (const chunk of gen) {
          const anyChunk = chunk as Record<string, any>;
          if (anyChunk.error && !anyChunk.choices) {
            throw new Error(anyChunk.error.message ?? `in-band provider error from ${route.displayName}`);
          }
          const choice = anyChunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const text = choice.delta?.content ?? '';
          if (text) {
            outputTokens += Math.ceil(text.length / 4);
            write({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] });
          }

          const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
          if (typeof reasoning === 'string' && reasoning) {
            write({ candidates: [{ content: { role: 'model', parts: [{ text: reasoning, thought: true }] }, index: 0 }] });
          }

          for (const tc of choice.delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const acc = toolAcc.get(idx) ?? { name: '', args: '' };
            if (tc.id && !acc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAcc.set(idx, acc);
          }
        }

        // Assemble tool calls
        const completedCalls: ChatToolCall[] = [...toolAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .filter(([, acc]) => acc.name)
          .map(([, acc], i) => ({
            id: acc.id || `call_${Date.now()}_${i}`,
            type: 'function' as const,
            function: { name: acc.name, arguments: repairToolArguments(acc.args || '{}', toolSchemas.get(acc.name)) },
          }));

        if (completedCalls.length > 0) {
          write({
            candidates: [{
              content: { role: 'model', parts: geminiPartsFromResult({ text: '', reasoning: '', toolCalls: completedCalls }) },
              index: 0,
            }],
          });
          outputTokens += Math.ceil(completedCalls.reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0) / 4);
        }

        // Empty completion — fail over
        if (outputTokens === 0 && completedCalls.length === 0) {
          throw new Error(`empty completion from ${route.displayName}`);
        }

        // Final chunk with finish reason and usage
        write({
          candidates: [{
            content: { role: 'model', parts: [] },
            finishReason: geminiFinishReason(finishReason, completedCalls.length > 0),
            index: 0,
          }],
          usageMetadata: {
            promptTokenCount: estimatedInputTokens,
            candidatesTokenCount: outputTokens,
            totalTokenCount: estimatedInputTokens + outputTokens,
          },
          modelVersion: route.modelId,
        });

        if (!altSse) chunks.push(encoder.encode('\n]'));

        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + outputTokens);
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, outputTokens, Date.now() - start, null);

        const streamBody = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });

        return new Response(streamBody, {
          headers: {
            'Content-Type': altSse ? 'text/event-stream' : 'application/json',
            'Cache-Control': 'no-cache',
            'X-Routed-Via': routedViaValue(route.platform, route.modelId),
            ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}),
          },
        });
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens: maxTokens, top_p: topP, top_k: topK, stop, tools, tool_choice: toolChoice, response_format: responseFormat, reasoning_effort: reasoningEffort },
        );

        const msg = result.choices?.[0]?.message;
        const text = contentToString(msg?.content ?? '');
        const reasoning = msg?.reasoning_content ?? '';
        let toolCalls = msg?.tool_calls ?? [];

        if (!text && !reasoning && toolCalls.length === 0) {
          throw new Error(`empty completion from ${route.displayName}`);
        }

        for (const tc of toolCalls) {
          tc.function.arguments = repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name));
        }

        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil((text.length + reasoning.length) / 4);

        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? (promptTokens + completionTokens));
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null);

        const responseObj: Record<string, unknown> = {
          candidates: [{
            content: { role: 'model', parts: geminiPartsFromResult({ text, reasoning, toolCalls }) },
            finishReason: geminiFinishReason(result.choices?.[0]?.finish_reason ?? null, toolCalls.length > 0),
            index: 0,
          }],
          usageMetadata: {
            promptTokenCount: promptTokens,
            candidatesTokenCount: completionTokens,
            totalTokenCount: promptTokens + completionTokens,
          },
          modelVersion: route.modelId,
        };

        return new Response(JSON.stringify(responseObj), {
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

      return sendError(502, `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`, 'UNAVAILABLE');
    }
  }

  return sendError(503, `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message ? sanitizeProviderErrorMessage(lastError.message) : 'unknown'}`, 'UNAVAILABLE');
}

// POST /v1beta/models/{model}:countTokens
export async function geminiCountTokensRoute(req: Request): Promise<Response> {
  if (!authenticate(req)) return sendError(401, 'Invalid API key', 'UNAUTHENTICATED');

  let body: any;
  try { body = await req.json(); } catch {
    return sendError(400, 'Invalid JSON');
  }

  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    return sendError(400, 'Invalid Gemini request');
  }

  return new Response(JSON.stringify({
    totalTokens: estimateGeminiTokens(parsed.data as GeminiInboundRequest),
  }), { headers: { 'Content-Type': 'application/json' } });
}
