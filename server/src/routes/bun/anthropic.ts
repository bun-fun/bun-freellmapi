import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  ChatContentBlock,
} from '@freellmapi/shared/types.js';
import {
  routeRequest,
  routingReserveTokens,
  type RouteResult,
} from '../../services/router.js';
import { getUnifiedApiKey } from '../../db/index.js';
import { contentToString } from '../../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../../lib/tool-args.js';
import { routedViaValue } from '../../lib/header-value.js';
import { logRequest } from '../../lib/request-log.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import { resolveAnthropicModel } from '../../services/anthropic-map.js';
import { z } from 'zod';
import type { ReasoningEffort } from '../../lib/sampling-params.js';
import {
  runFallbackLoop,
  newFallbackState,
  type FallbackHooks,
  type DispatchOutcome,
  type AttemptRecord,
} from '../../lib/fallback-loop.js';
import { recordRequest, recordTokens, setCooldown } from '../../services/ratelimit.js';
import { recordSuccess } from '../../services/router.js';

// ─────────────────────────────────────────────────────────────────────────
// Anthropic-compatible Messages API (POST /v1/messages).
//
// This is a thin translation layer over the SAME routing/fallback machinery
// the OpenAI /v1/chat/completions route uses — it converts the Anthropic wire
// format to our internal (OpenAI-shaped) ChatMessage form on the way in, runs
// the normal routing loop, and converts the result back to Anthropic shape on
// the way out.
//
// The point is Claude Code (and anything else that speaks the Anthropic SDK):
// point ANTHROPIC_BASE_URL at this server, set the API key to the unified key,
// and every claude-* request transparently routes to whatever free model the
// chain picks.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 1024;
const IMAGE_TOKEN_ESTIMATE = 1000;

function newMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

// ── Request schema ──────────────────────────────────────────────────────────
const contentBlockSchema = z.object({ type: z.string() }).passthrough();

const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
}).passthrough();

const anthropicToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const anthropicToolChoiceSchema = z.object({
  type: z.enum(['auto', 'any', 'tool', 'none']),
  name: z.string().optional(),
}).passthrough();

const messagesSchema = z.object({
  model: z.string().optional(),
  max_tokens: z.number().int().optional(),
  messages: z.array(anthropicMessageSchema).min(1),
  system: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(1).nullable().optional(),
  stream: z.boolean().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: anthropicToolChoiceSchema.optional(),
  thinking: z.object({
    type: z.string().optional(),
    budget_tokens: z.number().int().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

type AnthropicRequest = z.infer<typeof messagesSchema>;

// ── Response shape ──────────────────────────────────────────────────────────
type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown; thought_signature?: string }
interface AnthropicThinkingBlock { type: 'thinking'; thinking: string; signature: string }
type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock;

// ── Request translation: Anthropic → internal (OpenAI-shaped) ───────────────
function flattenSystem(system: AnthropicRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .map(block => (typeof (block as any).text === 'string' ? (block as any).text : ''))
    .filter(Boolean)
    .join('\n');
}

function flattenToolResult(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && typeof (block as any).text === 'string') return (block as any).text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function imageBlockToUrl(block: any): string | null {
  const src = block?.source;
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'base64' && src.media_type && src.data) {
    return `data:${src.media_type};base64,${src.data}`;
  }
  if (src.type === 'url' && typeof src.url === 'string') return src.url;
  return null;
}

function convertToolChoice(choice: AnthropicRequest['tool_choice']): ChatToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto': return 'auto';
    case 'none': return 'none';
    case 'any': return 'required';
    case 'tool': return choice.name ? { type: 'function', function: { name: choice.name } } : 'required';
    default: return undefined;
  }
}

interface ConvertedRequest {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  hasImage: boolean;
  wantsTools: boolean;
}

function convertRequest(input: AnthropicRequest): ConvertedRequest {
  const messages: ChatMessage[] = [];
  let hasImage = false;

  const system = flattenSystem(input.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const message of input.messages) {
    if (message.role === 'system') {
      const sysText = typeof message.content === 'string'
        ? message.content
        : message.content.map(b => (typeof (b as any).text === 'string' ? (b as any).text : '')).filter(Boolean).join('\n');
      if (sysText) messages.push({ role: 'system', content: sysText });
      continue;
    }

    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    const textParts: string[] = [];
    const imageBlocks: ChatContentBlock[] = [];
    const toolCalls: ChatToolCall[] = [];
    const toolResults: ChatMessage[] = [];

    for (const block of message.content) {
      const type = (block as any).type;
      if (type === 'text') {
        if (typeof (block as any).text === 'string' && (block as any).text.length > 0) {
          textParts.push((block as any).text);
        }
      } else if (type === 'image') {
        const url = imageBlockToUrl(block);
        if (url) { imageBlocks.push({ type: 'image_url', image_url: { url } } as ChatContentBlock); hasImage = true; }
      } else if (type === 'tool_use') {
        const thoughtSignature = (block as any).thought_signature ?? (block as any).thoughtSignature;
        toolCalls.push({
          id: String((block as any).id ?? ''),
          type: 'function',
          function: { name: String((block as any).name ?? ''), arguments: JSON.stringify((block as any).input ?? {}) },
          ...(typeof thoughtSignature === 'string' && thoughtSignature.length > 0 ? { thought_signature: thoughtSignature } : {}),
        });
      } else if (type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: String((block as any).tool_use_id ?? ''),
          content: flattenToolResult((block as any).content),
        });
      }
    }

    const text = textParts.join('\n');

    if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      messages.push(...toolResults);
      if (imageBlocks.length > 0) {
        const blocks: ChatContentBlock[] = [];
        if (text.length > 0) blocks.push({ type: 'text', text });
        blocks.push(...imageBlocks);
        messages.push({ role: 'user', content: blocks });
      } else if (text.length > 0) {
        messages.push({ role: 'user', content: text });
      }
    }
  }

  const tools: ChatToolDefinition[] | undefined = input.tools?.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object', properties: {} } },
  }));

  return {
    messages,
    tools,
    tool_choice: convertToolChoice(input.tool_choice),
    hasImage,
    wantsTools: (tools?.length ?? 0) > 0,
  };
}

function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
}

// ── Response translation: internal → Anthropic ──────────────────────────────
function mapStopReason(finishReason: string | null | undefined, hadToolCalls: boolean): AnthropicStopReason {
  if (hadToolCalls || finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

function parseToolInput(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}

function toAnthropicContent(message: ChatMessage | undefined): AnthropicResponseBlock[] {
  const blocks: AnthropicResponseBlock[] = [];
  const reasoning = message?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    blocks.push({ type: 'thinking', thinking: reasoning, signature: '' });
  }
  const text = contentToString(message?.content ?? '');
  if (text.length > 0) blocks.push({ type: 'text', text });
  for (const call of message?.tool_calls ?? []) {
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolInput(call.function.arguments),
    };
    if (call.thought_signature) block.thought_signature = call.thought_signature;
    blocks.push(block);
  }
  return blocks;
}

// ── Anthropic thinking → internal reasoning_effort ──────────────────────────
/**
 * Map an Anthropic `thinking` knob onto our internal `reasoning_effort` scale.
 * `adaptive`/`auto`/`default` → undefined (model-managed, don't forward a
 * knob). `disabled`/`off` → `'none'`. `enabled` without budget → `'medium'`.
 * `enabled` with budget → bucketed to the nearest effort tier.
 */
export function effortFromAnthropicThinking(thinking: AnthropicRequest['thinking']): ReasoningEffort | undefined {
  if (!thinking || typeof thinking !== 'object') return undefined;
  const type = (thinking as any).type;
  if (type === 'disabled' || type === 'off') return 'none';
  // 'adaptive'/'auto'/'default' → let the provider decide (undefined).
  if (type === 'adaptive' || type === 'auto' || type === 'default') {
    // But an explicit budget still wins.
    if (typeof (thinking as any).budget_tokens === 'number') {
      return effortFromBudgetTokens((thinking as any).budget_tokens);
    }
    return undefined;
  }
  // 'enabled' or any other value: use budget if present, else medium.
  if (typeof (thinking as any).budget_tokens === 'number') {
    return effortFromBudgetTokens((thinking as any).budget_tokens);
  }
  return 'medium';
}

function effortFromBudgetTokens(budget: number): ReasoningEffort {
  if (budget <= 2048) return 'low';
  if (budget <= 16_000) return 'medium';
  return 'high';
}

// ── Route handler ────────────────────────────────────────────────────────────
export async function anthropicRoute(req: Request, _url: URL): Promise<Response> {
  const start = Date.now();

  // Auth: accept Bearer token or x-api-key header (Anthropic's native header)
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
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid API key' },
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Parse body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid JSON' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = messagesSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5).join(', ');
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: `Invalid request: ${detail}` },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const reqData = parsed.data;
  const requestedModel = reqData.model ?? 'auto';
  const routedModel = reqData.model?.startsWith('claude/')
    ? reqData.model.slice('claude/'.length)
    : reqData.model;
  const clientMaxTokens = reqData.max_tokens != null && reqData.max_tokens > 0 ? reqData.max_tokens : undefined;
  const { temperature, top_p, stream } = reqData;

  const converted = convertRequest(reqData);
  const { messages, tools, tool_choice, hasImage, wantsTools } = converted;
  const toolSchemas = toolSchemaMap(tools);

  const estimatedInputTokens = estimateTokens(messages);
  const imageCount = messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter(b => (b as any)?.type === 'image_url').length : 0), 0);

  const max_tokens = clientMaxTokens ?? DEFAULT_MAX_TOKENS;

  // Build completion options including the thinking → reasoning_effort mapping
  const completionOpts = {
    temperature, max_tokens, top_p, top_k: reqData.top_k ?? undefined,
    tools, tool_choice,
    reasoning_effort: effortFromAnthropicThinking(reqData.thinking),
  };

  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + routingReserveTokens(max_tokens);

  // Resolve the model through the operator's Claude-family map
  const resolved = resolveAnthropicModel(routedModel);
  let preferredModel = resolved.preferredModelDbId;
  if (preferredModel == null) preferredModel = undefined;

  // ── Shared fallback loop hooks ──────────────────────────────────────────
  const state = newFallbackState();
  let finalResponse: Response | null = null;
  const attemptLog: AttemptRecord[] = [];

  const hooks: FallbackHooks = {
    state,
    attemptLog,

    route() {
      return routeRequest(
        estimatedTotal,
        state.skipKeys.size > 0 ? state.skipKeys : undefined,
        preferredModel,
        hasImage,
        wantsTools,
        undefined, // skipModels — managed by the loop via state.skipModels
      );
    },

    async dispatch(route, attempt) {
      if (stream) {
        return dispatchStreaming(route, attempt, start, reqData, completionOpts,
          toolSchemas, estimatedInputTokens, messages, newMessageId,
          requestedModel);
      }
      return dispatchNonStreaming(route, attempt, start, reqData, completionOpts,
        toolSchemas, estimatedInputTokens, messages, newMessageId,
        requestedModel);
    },

    logFailure(route, err, attempt) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, route.keyId, 'error',
        estimatedInputTokens, 0, latency, sanitizeProviderErrorMessage(err.message));
      console.log(`[Anthropic] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1})`);
    },

    onFatal(route, err, attempt) {
      const resp = new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`,
        },
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      if (attempt > 0) resp.headers.set('X-Fallback-Attempts', String(attempt));
      finalResponse = resp;
    },

    onRoutingExhausted(lastError, routeErr, exhaustion, info) {
      const status = exhaustion.status;
      const isAfterFirstAttempt = info.attempts.length > 0 || lastError != null;
      const resp = new Response(JSON.stringify({
        type: 'error',
        error: {
          type: anthropicExhaustionType(exhaustion.kind),
          message: isAfterFirstAttempt
            ? `All models rate-limited. Last error: ${sanitizeProviderErrorMessage(lastError?.message ?? '')}`
            : sanitizeProviderErrorMessage(routeErr?.message ?? exhaustion.message),
          ...(exhaustion.code ? { code: exhaustion.code } : {}),
          ...(exhaustion.retryAtMs != null ? { retry_at: new Date(exhaustion.retryAtMs).toISOString() } : {}),
        },
      }), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...(exhaustion.retryAtMs != null ? { 'Retry-After': String(Math.max(0, Math.ceil((exhaustion.retryAtMs - Date.now()) / 1000))) } : {}),
        },
      });
      stampFallbackHeaders(resp, info.attempts.length, attemptLog);
      finalResponse = resp;
    },

    onExhausted(exhaustion, info) {
      const resp = new Response(JSON.stringify({
        type: 'error',
        error: {
          type: anthropicExhaustionType(exhaustion.kind),
          message: exhaustion.message,
          ...(exhaustion.code ? { code: exhaustion.code } : {}),
          ...(exhaustion.retryAtMs != null ? { retry_at: new Date(exhaustion.retryAtMs).toISOString() } : {}),
        },
      }), {
        status: exhaustion.status,
        headers: {
          'Content-Type': 'application/json',
          ...(exhaustion.retryAtMs != null ? { 'Retry-After': String(Math.max(0, Math.ceil((exhaustion.retryAtMs - Date.now()) / 1000))) } : {}),
        },
      });
      stampFallbackHeaders(resp, info.attempts.length, attemptLog);
      finalResponse = resp;
    },
  };

  await runFallbackLoop(hooks);

  return finalResponse ?? new Response('Internal error', { status: 500 });
}

/** Map the shared exhaustion kind onto an Anthropic-shaped error type. */
function anthropicExhaustionType(kind: string): string {
  switch (kind) {
    case 'auth': return 'api_error';
    case 'bad_request': return 'invalid_request_error';
    case 'rate_limit': return 'rate_limit_error';
    case 'unavailable': return 'overloaded_error';
    case 'context_too_large': return 'request_too_large';
    case 'model_not_found': return 'not_found_error';
    default: return 'api_error';
  }
}

// ── Streaming dispatch ─────────────────────────────────────────────────────
async function dispatchStreaming(
  route: RouteResult,
  attempt: number,
  start: number,
  reqData: z.infer<typeof messagesSchema>,
  completionOpts: Record<string, unknown>,
  toolSchemas: Map<string, unknown>,
  estimatedInputTokens: number,
  messages: ChatMessage[],
  newMessageId: () => string,
  requestedModel: string,
): Promise<DispatchOutcome> {
  const gen = route.provider.streamChatCompletion(
    route.apiKey, messages, route.modelId,
    completionOpts as any,
  );

  let outputChars = 0;
  let messageStarted = false;
  let textBlockOpen = false;
  let textBlockIndex = -1;
  let nextIndex = 0;
  let upstreamFinish: string | null = null;
  const toolAcc = new Map<number, { id?: string; name: string; args: string; thought_signature?: string }>();

  const sseChunks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  const writeSse = (event: string, data: unknown) => {
    sseChunks.push(encoder.encode(`event: ${event}\n`));
    sseChunks.push(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  const ensureMessageStart = () => {
    if (messageStarted) return;
    writeSse('message_start', {
      type: 'message_start',
      message: {
        id: newMessageId(), type: 'message', role: 'assistant', model: requestedModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
      },
    });
    messageStarted = true;
  };

  const emitText = (text: string) => {
    ensureMessageStart();
    if (!textBlockOpen) {
      textBlockIndex = nextIndex++;
      writeSse('content_block_start', {
        type: 'content_block_start', index: textBlockIndex,
        content_block: { type: 'text', text: '' },
      });
      textBlockOpen = true;
    }
    writeSse('content_block_delta', {
      type: 'content_block_delta', index: textBlockIndex,
      delta: { type: 'text_delta', text },
    });
    outputChars += text.length;
  };

  for await (const chunk of gen) {
    const anyChunk = chunk as Record<string, any>;
    if (anyChunk.error && !anyChunk.choices) {
      throw new Error(`in-band provider error from ${route.displayName}: ${anyChunk.error.message ?? 'provider error'}`);
    }

    const choice = anyChunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) upstreamFinish = choice.finish_reason;

    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = (tc as any).index ?? 0;
      if (!toolAcc.has(idx)) toolAcc.set(idx, { id: undefined, name: '', args: '' });
      const acc = toolAcc.get(idx)!;
      if (tc.id && !acc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name += tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      const thoughtSignature = (tc as any).thought_signature ?? (tc as any).thoughtSignature;
      if (typeof thoughtSignature === 'string' && thoughtSignature.length > 0 && !acc.thought_signature) {
        acc.thought_signature = thoughtSignature;
      }
    }

    const text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';
    if (text.length === 0) continue;
    emitText(text);
  }

  // Assemble buffered tool calls
  let synthetic = 0;
  const completedCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({
      id: acc.id && acc.id.length > 0 ? acc.id : `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}_${++synthetic}`,
      name: acc.name,
      arguments: repairToolArguments(acc.args || '{}', toolSchemas.get(acc.name) as any),
      ...(acc.thought_signature ? { thought_signature: acc.thought_signature } : {}),
    }))
    .filter(c => { try { JSON.parse(c.arguments); return c.name.length > 0; } catch { return false; } });

  // Empty completion → fail over
  if (!messageStarted && completedCalls.length === 0) {
    throw new Error(`empty completion from ${route.displayName} (stream produced no content and no tool calls)`);
  }

  ensureMessageStart();
  if (textBlockOpen) {
    writeSse('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
  }

  for (const call of completedCalls) {
    const idx = nextIndex++;
    writeSse('content_block_start', {
      type: 'content_block_start', index: idx,
      content_block: {
        type: 'tool_use', id: call.id, name: call.name, input: {},
        ...(call.thought_signature ? { thought_signature: call.thought_signature } : {}),
      },
    });
    writeSse('content_block_delta', {
      type: 'content_block_delta', index: idx,
      delta: { type: 'input_json_delta', partial_json: call.arguments },
    });
    writeSse('content_block_stop', { type: 'content_block_stop', index: idx });
    outputChars += call.arguments.length;
  }

  const stopReason = mapStopReason(upstreamFinish, completedCalls.length > 0);
  const outputTokens = Math.ceil(outputChars / 4);
  writeSse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  writeSse('message_stop', { type: 'message_stop' });

  // Success accounting — required by the fallback loop contract
  recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + outputTokens);
  recordSuccess(route.modelDbId);
  logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, outputTokens, Date.now() - start, null);

  const streamBody = new ReadableStream({
    start(controller) {
      for (const chunk of sseChunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const resp = new Response(streamBody, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Routed-Via': routedViaValue(route.platform, route.modelId),
    },
  });
  // Stamp fallback headers after the response is built (loop handles the count).
  return 'done';
}

// ── Non-streaming dispatch ─────────────────────────────────────────────────
async function dispatchNonStreaming(
  route: RouteResult,
  attempt: number,
  start: number,
  reqData: z.infer<typeof messagesSchema>,
  completionOpts: Record<string, unknown>,
  toolSchemas: Map<string, unknown>,
  estimatedInputTokens: number,
  messages: ChatMessage[],
  newMessageId: () => string,
  requestedModel: string,
): Promise<DispatchOutcome> {
  const result = await route.provider.chatCompletion(
    route.apiKey, messages, route.modelId,
    completionOpts as any,
  );

  const respMsg = result.choices?.[0]?.message;
  const respText = contentToString(respMsg?.content ?? '');
  let respToolCalls = respMsg?.tool_calls ?? [];

  // Empty completion → fail over
  if (!respText && respToolCalls.length === 0) {
    throw new Error(`empty completion from ${route.displayName}`);
  }

  // Repair double-encoded tool arguments
  if (respToolCalls.length) {
    for (const tc of respToolCalls) {
      if (tc?.function?.arguments != null) {
        tc.function.arguments = repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name) as any);
      }
    }
  }

  const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
  const completionTokens = result.usage?.completion_tokens
    ?? Math.ceil((respText.length + respToolCalls.reduce((n, c) => n + c.function.arguments.length, 0)) / 4);

  // Success accounting — required by the fallback loop contract
  recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? (promptTokens + completionTokens));
  recordSuccess(route.modelDbId);
  logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null);

  const anthropicResponse = {
    id: newMessageId(),
    type: 'message' as const,
    role: 'assistant' as const,
    model: requestedModel,
    content: toAnthropicContent(respMsg),
    stop_reason: mapStopReason(result.choices?.[0]?.finish_reason ?? null, respToolCalls.length > 0),
    stop_sequence: null,
    usage: { input_tokens: promptTokens, output_tokens: completionTokens },
  };

  const resp = new Response(JSON.stringify(anthropicResponse), {
    headers: {
      'Content-Type': 'application/json',
      'X-Routed-Via': routedViaValue(route.platform, route.modelId),
    },
  });
  return 'done';
}

/** Stamp X-Fallback-Attempts on a Response's headers (Response uses .headers.set, not .setHeader). */
function stampFallbackHeaders(resp: Response, failedAttempts: number, trail: AttemptRecord[] | undefined): void {
  if (failedAttempts > 0) resp.headers.set('X-Fallback-Attempts', String(failedAttempts));
}

// Anthropic token-counting endpoint. Claude Code calls this to size context
// windows; we return a heuristic estimate (the proxy doesn't run a tokenizer).
export async function anthropicCountTokensRoute(req: Request, _url: URL): Promise<Response> {
  // Auth
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
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid API key' },
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid JSON' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = messagesSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid request' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { messages } = convertRequest(parsed.data);
  return new Response(JSON.stringify({
    input_tokens: estimateTokens(messages),
  }), { headers: { 'Content-Type': 'application/json' } });
}
