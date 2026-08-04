import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
} from '@freellmapi/shared/types.js';
import {
  routeRequest, recordRateLimitHit, recordSuccess,
  routingReserveTokens, hasEnabledToolsModel,
  type RouteResult,
} from '../../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { contentToString } from '../../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../../lib/tool-args.js';
import { routedViaValue } from '../../lib/header-value.js';
import { logRequest } from '../../lib/request-log.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// OpenAI Responses API shim (POST /v1/responses).
//
// Codex only speaks the Responses API, so the existing /v1/chat/completions
// endpoint isn't reachable from it. This endpoint accepts a Responses-shaped
// request, translates it to the internal chat-message format, runs it through
// the SAME routing/fallback machinery, and translates the result back into the
// Responses object / SSE event stream Codex expects.
// ─────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 20;
const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  return lower === AUTO_MODEL_ID || lower.startsWith(`${AUTO_MODEL_ID}:`);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 36)}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Request schema ──────────────────────────────────────────────────────────
const contentPartSchema = z.object({ type: z.string() }).passthrough();

const messageItemSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

const functionCallItemSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  id: z.string().optional(),
});

const functionCallOutputItemSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.union([z.string(), z.array(contentPartSchema), z.record(z.string(), z.unknown())]),
});

const inputItemSchema = z.union([
  functionCallItemSchema,
  functionCallOutputItemSchema,
  messageItemSchema,
]);

const responsesToolSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
  strict: z.boolean().nullable().optional(),
}).passthrough();

const responsesRequestSchema = z.object({
  model: z.string().optional(),
  instructions: z.string().nullable().optional(),
  input: z.union([z.string(), z.array(inputItemSchema)]),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  tools: z.array(responsesToolSchema).optional(),
  tool_choice: z.union([
    z.enum(['none', 'auto', 'required']),
    z.object({ type: z.literal('function'), name: z.string() }).passthrough(),
  ]).optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  text: z.object({
    format: z.object({
      type: z.enum(['text', 'json_object', 'json_schema']),
      name: z.string().optional(),
      strict: z.boolean().nullable().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
    }).passthrough().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

// ── Translation helpers ─────────────────────────────────────────────────────
function partsToString(content: string | Array<{ type: string; text?: unknown }>): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
}

function toChatMessages(req: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions });
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input });
    return messages;
  }

  for (const item of req.input) {
    if ('type' in item && item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        }],
      });
    } else if ('type' in item && item.type === 'function_call_output') {
      const output = typeof item.output === 'string'
        ? item.output
        : Array.isArray(item.output)
          ? partsToString(item.output as any)
          : JSON.stringify(item.output);
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
    } else {
      const m = item as z.infer<typeof messageItemSchema>;
      const role = m.role === 'developer' ? 'system' : m.role;
      messages.push({ role, content: partsToString(m.content) });
    }
  }

  return messages;
}

function toChatTools(tools?: ResponsesRequest['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  const fns = tools.filter((t): t is typeof t & { name: string } =>
    t.type === 'function' && typeof t.name === 'string');
  if (!fns.length) return undefined;
  return fns.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { parameters: t.parameters } : {}),
      ...(t.strict != null ? { strict: t.strict } : {}),
    },
  }));
}

function toChatToolChoice(tc?: ResponsesRequest['tool_choice']): ChatToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  return { type: 'function', function: { name: tc.name } };
}

function requestDeclaresToolUse(req: ResponsesRequest): boolean {
  return (req.tools?.length ?? 0) > 0 && req.tool_choice !== 'none';
}

// ── Build the final (non-stream) Responses object ──────────────────────────
function buildResponseObject(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: ChatToolCall[];
  promptTokens: number;
  completionTokens: number;
}) {
  const output: any[] = [];
  if (opts.text.length > 0) {
    output.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: opts.text, annotations: [] }],
    });
  }
  for (const tc of opts.toolCalls) {
    output.push({
      type: 'function_call',
      id: newId('fc'),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: 'completed',
    });
  }

  return {
    id: opts.id,
    object: 'response',
    created_at: nowUnix(),
    status: 'completed',
    model: opts.model,
    output,
    output_text: opts.text,
    usage: {
      input_tokens: opts.promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: opts.completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: opts.promptTokens + opts.completionTokens,
    },
  };
}

// ── Retryable error check ──────────────────────────────────────────────────
function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error');
}

// ── Route handler ────────────────────────────────────────────────────────────
export async function responsesRoute(req: Request, _url: URL): Promise<Response> {
  const start = Date.now();

  // Auth: accept Bearer token or x-api-key header
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

  const parsed = responsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({
      error: {
        message: `Invalid request: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        type: 'invalid_request_error',
      },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const reqData = parsed.data;
  const stream = reqData.stream ?? false;
  const messages = toChatMessages(reqData);
  const tools = toChatTools(reqData.tools);
  const toolSchemas = toolSchemaMap(tools);
  const tool_choice = tools?.length ? toChatToolChoice(reqData.tool_choice) : undefined;
  const requestedModelLabel = reqData.model ?? 'auto';

  const completionOpts = {
    temperature: reqData.temperature ?? undefined,
    max_tokens: reqData.max_output_tokens ?? undefined,
    top_p: reqData.top_p ?? undefined,
    tools,
    tool_choice,
    parallel_tool_calls: reqData.parallel_tool_calls ?? undefined,
  };

  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    0,
  );
  const estimatedTotal = estimatedInputTokens + routingReserveTokens(reqData.max_output_tokens);

  // Tool-bearing requests must stay on models that emit structured tool_calls
  const wantsTools = requestDeclaresToolUse(reqData);
  if (wantsTools && !hasEnabledToolsModel()) {
    return new Response(JSON.stringify({
      error: {
        message: 'This request includes tools, but no tool-capable model is enabled. Enable a tool-calling model in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_tools_model',
      },
    }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  // Determine model
  let preferredModel: number | undefined;

  if (isAutoModel(requestedModelLabel)) {
    preferredModel = undefined; // auto-route
  } else {
    const row = getDb()
      .prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1')
      .get(requestedModelLabel) as { id: number } | undefined;
    if (row) {
      preferredModel = row.id;
    } else {
      return new Response(JSON.stringify({
        error: {
          message: `Model '${requestedModelLabel}' is not in the catalog or is disabled. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const responseId = newId('resp');

  // Retry loop (mirrors the proxy.ts pattern)
  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(
        estimatedTotal,
        skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel,
        false,
        wantsTools,
      );
    } catch (err: any) {
      if (lastError) {
        return new Response(JSON.stringify({
          error: {
            message: `All models rate-limited. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`,
            type: 'rate_limit_error',
          },
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
        // ── Streaming ───────────────────────────────────────────────────────
        const gen = route.provider.streamChatCompletion(
          route.apiKey, messages, route.modelId,
          { ...completionOpts },
        );

        let totalOutputTokens = 0;
        let msgText = '';
        let msgItemId: string | null = null;
        let outputIndex = 0;
        let streamStarted = false;
        let seq = 0;
        const toolAcc = new Map<number, { outputIndex: number; itemId: string; callId: string; name: string; args: string }>();

        const sseChunks: Uint8Array[] = [];
        const encoder = new TextEncoder();

        const sse = (event: string, payload: Record<string, unknown>) => {
          sseChunks.push(encoder.encode(`event: ${event}\n`));
          sseChunks.push(encoder.encode(`data: ${JSON.stringify({ type: event, sequence_number: seq++, ...payload })}\n\n`));
        };

        const commit = () => {
          if (streamStarted) return;
          const skeleton = {
            id: responseId, object: 'response', created_at: nowUnix(),
            status: 'in_progress', model: route.modelId, output: [], output_text: '',
          };
          sse('response.created', { response: skeleton });
          sse('response.in_progress', { response: skeleton });
          streamStarted = true;
        };

        const openTextItem = (text: string) => {
          commit();
          msgItemId = newId('msg');
          sse('response.output_item.added', {
            output_index: outputIndex,
            item: { id: msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          });
          sse('response.content_part.added', {
            item_id: msgItemId, output_index: outputIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          if (text) {
            sse('response.output_text.delta', { item_id: msgItemId, output_index: outputIndex, content_index: 0, delta: text });
            msgText += text;
          }
        };

        for await (const chunk of gen) {
          const anyChunk = chunk as Record<string, any>;
          if (anyChunk.error && !anyChunk.choices) {
            throw new Error(`in-band provider error from ${route.displayName}: ${anyChunk.error.message ?? 'provider error'}`);
          }

          const choice0 = chunk.choices?.[0];
          const delta = choice0?.delta;
          if (!delta) continue;

          const text = delta.content ?? '';
          if (text) {
            totalOutputTokens += Math.ceil(text.length / 4);
            if (msgItemId === null) {
              openTextItem('');
            }
            sse('response.output_text.delta', {
              item_id: msgItemId, output_index: 0, content_index: 0, delta: text,
            });
            msgText += text;
          }

          for (const tc of delta.tool_calls ?? []) {
            const idx = (tc as any).index ?? 0;
            let acc = toolAcc.get(idx);
            if (!acc) {
              commit();
              if (msgItemId !== null && msgText.length > 0) {
                sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
                sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
                sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
                msgItemId = null;
              }
              outputIndex = toolAcc.size + (msgText.length > 0 ? 1 : 0);
              acc = { outputIndex, itemId: newId('fc'), callId: tc.id || newId('call'), name: tc.function?.name ?? '', args: '' };
              toolAcc.set(idx, acc);
              sse('response.output_item.added', {
                output_index: acc.outputIndex,
                item: { id: acc.itemId, type: 'function_call', status: 'in_progress', call_id: acc.callId, name: acc.name, arguments: '' },
              });
            }
            const argFrag = tc.function?.arguments ?? '';
            if (tc.function?.name && !acc.name) acc.name = tc.function.name;
            if (argFrag) {
              acc.args += argFrag;
              sse('response.function_call_arguments.delta', { item_id: acc.itemId, output_index: acc.outputIndex, delta: argFrag });
            }
          }
        }

        // Empty completion — fail over
        if (msgText.length === 0 && toolAcc.size === 0) {
          throw new Error(`empty completion from ${route.displayName}`);
        }

        // Finalize text item
        if (msgItemId !== null) {
          sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
          sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
          sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
        }

        // Finalize tool-call items
        const finalToolCalls: ChatToolCall[] = [];
        for (const acc of toolAcc.values()) {
          const repairedArgs = repairToolArguments(acc.args, toolSchemas.get(acc.name));
          sse('response.function_call_arguments.done', { item_id: acc.itemId, output_index: acc.outputIndex, arguments: repairedArgs });
          sse('response.output_item.done', { output_index: acc.outputIndex, item: { id: acc.itemId, type: 'function_call', status: 'completed', call_id: acc.callId, name: acc.name, arguments: repairedArgs } });
          finalToolCalls.push({ id: acc.callId, type: 'function', function: { name: acc.name, arguments: repairedArgs } });
        }

        const finalResponse = buildResponseObject({
          id: responseId, model: route.modelId, text: msgText,
          toolCalls: finalToolCalls, promptTokens: estimatedInputTokens, completionTokens: totalOutputTokens,
        });
        sse('response.completed', { response: finalResponse });

        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);

        // Build the SSE stream from buffered chunks
        const streamBody = new ReadableStream({
          start(controller) {
            for (const chunk of sseChunks) {
              controller.enqueue(chunk);
            }
            controller.close();
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
        // ── Non-streaming ───────────────────────────────────────────────────
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { ...completionOpts },
        );

        const msg = result.choices[0]?.message;
        const text = contentToString(msg?.content ?? '');
        const toolCalls = (msg?.tool_calls ?? []).map((tc) => ({
          ...tc,
          function: {
            ...tc.function,
            arguments: repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name)),
          },
        }));

        // Empty completion → fail over
        if (!text && toolCalls.length === 0) {
          throw new Error(`empty completion from ${route.displayName}`);
        }

        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);

        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? (promptTokens + completionTokens));
        recordSuccess(route.modelDbId);

        logRequest(
          route.platform, route.modelId, route.keyId, 'success',
          promptTokens, completionTokens, Date.now() - start, null,
        );

        const responseObject = buildResponseObject({
          id: responseId, model: route.modelId, text, toolCalls,
          promptTokens, completionTokens,
        });

        return new Response(JSON.stringify(responseObject), {
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
        console.log(`[Responses] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      return new Response(JSON.stringify({
        error: {
          message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`,
          type: 'provider_error',
        },
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Exhausted all retries
  return new Response(JSON.stringify({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message ? sanitizeProviderErrorMessage(lastError.message) : 'unknown'}`,
      type: 'rate_limit_error',
    },
  }), { status: 429, headers: { 'Content-Type': 'application/json' } });
}
