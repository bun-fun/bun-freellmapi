import { z } from 'zod';
import type {
  ChatMessage, ChatToolCall, ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import {
  routeRequest, recordRateLimitHit, recordSuccess,
  routingReserveTokens, type RouteResult,
} from '../../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../../services/ratelimit.js';
import { getDb, getSetting, getUnifiedApiKey } from '../../db/index.js';
import { contentToString } from '../../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../../lib/tool-args.js';
import { routedViaValue } from '../../lib/header-value.js';
import { logRequest } from '../../lib/request-log.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import { isUpstreamClassificationOutput } from '../../lib/error-classify.js';
import { buildModelListing } from '../../services/model-listing.js';
import { runEmbeddings, EmbeddingsError } from '../../services/embeddings.js';

// Ollama-compatible API emulation.
// GET  /api/tags         — list models
// GET  /api/version      — version
// POST /api/show         — model info
// POST /api/chat         — chat completion
// POST /api/generate     — text completion
// POST /api/embed        — embeddings (new)
// POST /api/embeddings   — embeddings (legacy)

const MAX_RETRIES = 20;

export type OllamaEmulationMode = 'off' | 'open-loopback' | 'key-required';

export function getOllamaEmulationMode(): OllamaEmulationMode {
  const stored = getSetting('ollama_emulation');
  return stored === 'open-loopback' || stored === 'key-required' ? stored : 'off';
}

function isLoopback(req: Request): boolean {
  const clientIP = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
  const address = clientIP.trim().replace(/^::ffff:/i, '');
  return address === '127.0.0.1' || address === '::1' || address === 'unknown';
}

function authorize(req: Request): boolean {
  const mode = getOllamaEmulationMode();
  if (mode === 'off') return false;
  if (mode === 'open-loopback') return isLoopback(req);
  const authHeader = req.headers.get('authorization');
  const apiKeyHeader = req.headers.get('x-api-key');
  const token = (authHeader ? authHeader.replace(/^Bearer\s+/i, '') : apiKeyHeader ?? '') || '';
  if (!token) return false;
  return token === getUnifiedApiKey();
}

function authFailResponse(): Response {
  const mode = getOllamaEmulationMode();
  const status = mode === 'off' ? 404 : 403;
  return new Response(JSON.stringify({ error: 'Ollama emulation is disabled or not authorized' }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function normalizeOllamaModel(name: string | undefined): string {
  const trimmed = name?.trim().replace(/:latest$/i, '');
  return trimmed || 'auto';
}

function ollamaDoneReason(finishReason: string | null | undefined): string {
  return finishReason === 'length' ? 'length' : 'stop';
}

const CATALOG_MODIFIED_AT = new Date().toISOString();

function ollamaModelShape(model: ReturnType<typeof buildModelListing>['models'][number]) {
  return {
    name: model.id, model: model.id, modified_at: CATALOG_MODIFIED_AT,
    size: 0, digest: '',
    details: { parent_model: '', format: 'freellmapi', family: model.ownedBy, families: [model.ownedBy], parameter_size: 'remote', quantization_level: 'remote' },
  };
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

function ollamaDurations(startedMs: number, promptTokens: number, completionTokens: number) {
  const totalNs = Math.max(1, Math.round((performance.now() - startedMs) * 1e6));
  const promptShare = promptTokens + completionTokens > 0
    ? promptTokens / (promptTokens + completionTokens) : 0.5;
  const promptNs = Math.max(1, Math.round(totalNs * promptShare * 0.2));
  return { total_duration: totalNs, load_duration: 0, prompt_eval_duration: promptNs, eval_duration: Math.max(1, totalNs - promptNs) };
}

// GET /api/tags
export function ollamaTagsRoute(req: Request): Response {
  if (!authorize(req)) return authFailResponse();
  const { models } = buildModelListing();
  const auto = { name: 'auto', model: 'auto', modified_at: CATALOG_MODIFIED_AT, size: 0, digest: '', details: { parent_model: '', format: 'freellmapi', family: 'freellmapi', families: ['freellmapi'], parameter_size: 'remote', quantization_level: 'remote' } };
  return new Response(JSON.stringify({ models: [auto, ...models.filter(m => m.available === 1).map(ollamaModelShape)] }), { headers: { 'Content-Type': 'application/json' } });
}

// GET /api/version
export function ollamaVersionRoute(req: Request): Response {
  if (!authorize(req)) return authFailResponse();
  return new Response(JSON.stringify({ version: '0.9.9' }), { headers: { 'Content-Type': 'application/json' } });
}

// POST /api/show
const showSchema = z.object({ model: z.string().optional(), name: z.string().optional() }).passthrough();

export async function ollamaShowRoute(req: Request): Promise<Response> {
  if (!authorize(req)) return authFailResponse();
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  const parsed = showSchema.safeParse(body);
  if (!parsed.success || !(parsed.data.model || parsed.data.name)) {
    return new Response(JSON.stringify({ error: 'model is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const id = normalizeOllamaModel(parsed.data.model || parsed.data.name);
  const { models, autoContextWindow } = buildModelListing();
  if (id === 'auto') {
    return new Response(JSON.stringify({ license: '', modified_at: CATALOG_MODIFIED_AT, modelfile: 'FROM auto', parameters: `num_ctx ${autoContextWindow ?? 128000}`, template: '{{ .Prompt }}', details: { parent_model: '', format: 'freellmapi', family: 'freellmapi', families: ['freellmapi'], parameter_size: 'remote', quantization_level: 'remote' }, model_info: { 'general.architecture': 'freellmapi', 'general.context_length': autoContextWindow ?? 128000 }, capabilities: ['completion', 'tools'] }), { headers: { 'Content-Type': 'application/json' } });
  }
  const model = models.find(m => m.id === id);
  if (!model) return new Response(JSON.stringify({ error: `model '${id}' not found` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ license: '', modified_at: CATALOG_MODIFIED_AT, modelfile: `FROM ${model.id}`, parameters: `num_ctx ${model.contextWindow ?? 128000}`, template: '{{ .Prompt }}', details: ollamaModelShape(model).details, model_info: { 'general.architecture': model.ownedBy, 'general.context_length': model.contextWindow ?? 128000 }, capabilities: model.supportsTools ? ['completion', 'tools'] : ['completion'] }), { headers: { 'Content-Type': 'application/json' } });
}

// POST /api/chat
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.object({}).passthrough())]).optional(),
  tool_name: z.string().optional(),
  tool_calls: z.array(z.object({}).passthrough()).optional(),
}).passthrough();

const chatSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).default([]),
  stream: z.boolean().optional(),
  tools: z.array(z.object({}).passthrough()).optional(),
  options: z.object({}).passthrough().optional(),
  format: z.union([z.literal('json'), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();

function ollamaMessages(raw: z.infer<typeof messageSchema>[]): ChatMessage[] {
  const pendingCalls = new Map<string, string[]>();
  const converted: ChatMessage[] = [];
  raw.forEach((message, messageIndex) => {
    const toolCalls = message.tool_calls?.filter((c: any) => c?.function?.name).map((c: any, ci: number) => {
      const id = c.id || `call_${messageIndex}_${ci}`;
      const name = c.function.name as string;
      const queue = pendingCalls.get(name) ?? []; queue.push(id); pendingCalls.set(name, queue);
      return { id, type: 'function' as const, function: { name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) } };
    });
    let toolCallId: string | undefined;
    if (message.role === 'tool') {
      toolCallId = (message as any).tool_call_id;
      if (!toolCallId && message.tool_name) toolCallId = pendingCalls.get(message.tool_name)?.shift();
      if (!toolCallId) { const fp = [...pendingCalls.values()].find(q => q.length); toolCallId = fp?.shift() ?? `call_${messageIndex}`; }
    }
    const images = (message as any).images;
    const imageBlocks = Array.isArray(images) ? images.filter((i: unknown): i is string => typeof i === 'string' && i.length > 0).map((i: string) => ({ type: 'image_url' as const, image_url: { url: i.startsWith('data:') ? i : `data:image/png;base64,${i}` } })) : [];
    const textContent = typeof message.content === 'string' ? message.content : '';
    converted.push({ role: message.role, content: imageBlocks.length ? [{ type: 'text', text: textContent }, ...imageBlocks] : message.content ?? '', ...(message.tool_name ? { name: message.tool_name } : {}), ...(toolCallId ? { tool_call_id: toolCallId } : {}), ...(toolCalls?.length ? { tool_calls: toolCalls } : {}) } as ChatMessage);
  });
  return converted;
}

function ollamaTools(raw: unknown[] | undefined): ChatToolDefinition[] | undefined {
  if (!raw?.length) return undefined;
  const tools = raw.filter((t: any) => t?.function?.name).map((t: any) => ({ type: 'function' as const, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters ?? { type: 'object', properties: {} } } }));
  return tools.length ? tools : undefined;
}

export async function ollamaChatRoute(req: Request): Promise<Response> {
  if (!authorize(req)) return authFailResponse();
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return new Response(JSON.stringify({ error: `invalid request: ${parsed.error.message}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const b = parsed.data;
  const model = normalizeOllamaModel(b.model);
  if (b.messages.length === 0) {
    const unload = (b as any).keep_alive === 0;
    return new Response(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: unload ? 'unload' : 'load' }), { headers: { 'Content-Type': 'application/json' } });
  }

  const options = b.options as Record<string, unknown> | undefined;
  const messages = ollamaMessages(b.messages);
  const tools = ollamaTools(b.tools);
  const toolSchemas = toolSchemaMap(tools);
  const stream = b.stream !== false;
  const maxTokens = typeof options?.num_predict === 'number' ? options.num_predict : undefined;
  const temperature = typeof options?.temperature === 'number' ? options.temperature : undefined;
  const topP = typeof options?.top_p === 'number' ? options.top_p : undefined;
  const topK = typeof options?.top_k === 'number' ? options.top_k : undefined;
  const stop = Array.isArray(options?.stop) ? options.stop.filter((v: unknown): v is string => typeof v === 'string') : undefined;
  const responseFormat = b.format ? (b.format === 'json' ? { type: 'json_object' as const } : { type: 'json_schema' as const, json_schema: { name: 'ollama_response', schema: b.format } }) : undefined;

  const estimatedInputTokens = messages.reduce((s, m) => s + Math.ceil(contentToString(m.content).length / 4), 0);
  const estimatedTotal = estimatedInputTokens + routingReserveTokens(maxTokens);
  const start = performance.now();

  let preferredModel: number | undefined;
  if (model !== 'auto') {
    const row = getDb().prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(model) as { id: number } | undefined;
    if (row) preferredModel = row.id;
  }

  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, false, (tools?.length ?? 0) > 0);
    } catch (err: any) {
      return new Response(JSON.stringify({ error: lastError ? `All models rate-limited: ${sanitizeProviderErrorMessage(lastError.message)}` : sanitizeProviderErrorMessage(err.message) }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    recordRequest(route.platform, route.modelId, route.keyId);
    try {
      const opts = { temperature, max_tokens: maxTokens, top_p: topP, top_k: topK, stop, tools, response_format: responseFormat };
      if (stream) {
        const gen = route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, opts);
        const encoder = new TextEncoder();
        const chunks: Uint8Array[] = [];
        let finishReason: string | null = null;
        let outputTokens = 0;
        const toolAcc = new Map<number, { id?: string; name: string; args: string }>();
        for await (const chunk of gen) {
          const c = chunk.choices?.[0];
          if (!c) continue;
          if (c.finish_reason) finishReason = c.finish_reason;
          const text = c.delta?.content ?? '';
          if (text) { outputTokens += Math.ceil(text.length / 4); chunks.push(encoder.encode(`${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: text }, done: false })}\n`)); }
          for (const tcRaw of c.delta?.tool_calls ?? []) { const tc = tcRaw as any; const idx = tc.index ?? 0; const a = toolAcc.get(idx) ?? { name: '', args: '' }; if (tc.id && !a.id) a.id = tc.id; if (tc.function?.name) a.name += tc.function.name; if (tc.function?.arguments) a.args += tc.function.arguments; toolAcc.set(idx, a); }
        }
        const completedCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).filter(([, a]) => a.name).map(([, a], i) => ({ id: a.id || `call_${Date.now()}_${i}`, type: 'function' as const, function: { name: a.name, arguments: repairToolArguments(a.args || '{}', toolSchemas.get(a.name)) } }));
        if (completedCalls.length > 0) { chunks.push(encoder.encode(`${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '', tool_calls: completedCalls.map(c => { let args: unknown = {}; try { args = JSON.parse(c.function.arguments); } catch { args = { value: c.function.arguments }; } return { function: { name: c.function.name, arguments: args } }; }) }, done: false })}\n`)); }
        if (outputTokens === 0 && completedCalls.length === 0) throw new Error(`empty completion from ${route.displayName}`);
        chunks.push(encoder.encode(`${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: ollamaDoneReason(finishReason), ...ollamaDurations(start, estimatedInputTokens, outputTokens), prompt_eval_count: estimatedInputTokens, eval_count: outputTokens })}\n`));
        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + outputTokens);
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, outputTokens, Date.now() - start, null);
        return new Response(new ReadableStream({ start(ctrl) { for (const c of chunks) ctrl.enqueue(c); ctrl.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Routed-Via': routedViaValue(route.platform, route.modelId), ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}) } });
      } else {
        const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, opts);
        const msg = result.choices?.[0]?.message;
        const text = contentToString(msg?.content ?? '');
        const reasoning = msg?.reasoning_content ?? '';
        let toolCalls = msg?.tool_calls ?? [];
        // #809: a bare "safe"/"unsafe" classification word from a relay is an
        // upstream filter — fail over like an empty completion.
        if ((!text && !reasoning && toolCalls.length === 0)
          || (isUpstreamClassificationOutput(text, route.platform) && toolCalls.length === 0)) throw new Error(`empty completion from ${route.displayName}${isUpstreamClassificationOutput(text, route.platform) ? ' (upstream classification output)' : ''}`);
        for (const tc of toolCalls) tc.function.arguments = repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name));
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil((text.length + reasoning.length) / 4);
        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? (promptTokens + completionTokens));
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null);
        const ollamaToolCalls = toolCalls.map(c => { let args: unknown = {}; try { args = JSON.parse(c.function.arguments); } catch { args = { value: c.function.arguments }; } return { function: { name: c.function.name, arguments: args } }; });
        return new Response(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: text, ...(reasoning ? { thinking: reasoning } : {}), ...(ollamaToolCalls.length ? { tool_calls: ollamaToolCalls } : {}) }, done: true, done_reason: ollamaDoneReason(result.choices?.[0]?.finish_reason), ...ollamaDurations(start, promptTokens, completionTokens), prompt_eval_count: promptTokens, eval_count: completionTokens }), { headers: { 'Content-Type': 'application/json', 'X-Routed-Via': routedViaValue(route.platform, route.modelId), ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}) } });
      }
    } catch (err: any) {
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, sanitizeProviderErrorMessage(err.message));
      if (isRetryableError(err)) { skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`); setCooldown(route.platform, route.modelId, route.keyId, 120000); recordRateLimitHit(route.modelDbId); lastError = err; continue; }
      return new Response(JSON.stringify({ error: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}` }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return new Response(JSON.stringify({ error: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message ?? 'unknown'}` }), { status: 503, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/generate
const generateSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().default(''),
  system: z.string().optional(),
  suffix: z.string().optional(),
  stream: z.boolean().optional(),
  options: z.object({}).passthrough().optional(),
  format: z.union([z.literal('json'), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();

export async function ollamaGenerateRoute(req: Request): Promise<Response> {
  if (!authorize(req)) return authFailResponse();
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) return new Response(JSON.stringify({ error: `invalid request: ${parsed.error.message}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const b = parsed.data;
  const model = normalizeOllamaModel(b.model);
  if (!b.prompt && !b.suffix) {
    const unload = (b as any).keep_alive === 0;
    return new Response(JSON.stringify({ model, created_at: new Date().toISOString(), response: '', done: true, done_reason: unload ? 'unload' : 'load' }), { headers: { 'Content-Type': 'application/json' } });
  }

  const options = b.options as Record<string, unknown> | undefined;
  const messages: ChatMessage[] = [];
  if (b.system) messages.push({ role: 'system', content: b.system });
  messages.push({ role: 'user', content: b.suffix ? `${b.prompt}\n\nComplete the text before this suffix:\n${b.suffix}` : b.prompt });
  const stream = b.stream !== false;
  const maxTokens = typeof options?.num_predict === 'number' ? options.num_predict : undefined;
  const temperature = typeof options?.temperature === 'number' ? options.temperature : undefined;
  const topP = typeof options?.top_p === 'number' ? options.top_p : undefined;
  const topK = typeof options?.top_k === 'number' ? options.top_k : undefined;
  const responseFormat = b.format ? (b.format === 'json' ? { type: 'json_object' as const } : { type: 'json_schema' as const, json_schema: { name: 'ollama_response', schema: b.format } }) : undefined;

  const estimatedInputTokens = messages.reduce((s, m) => s + Math.ceil(contentToString(m.content).length / 4), 0);
  const estimatedTotal = estimatedInputTokens + routingReserveTokens(maxTokens);
  const start = performance.now();

  let preferredModel: number | undefined;
  if (model !== 'auto') {
    const row = getDb().prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(model) as { id: number } | undefined;
    if (row) preferredModel = row.id;
  }

  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try { route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel); } catch (err: any) { return new Response(JSON.stringify({ error: lastError ? sanitizeProviderErrorMessage(lastError.message) : sanitizeProviderErrorMessage(err.message) }), { status: 503, headers: { 'Content-Type': 'application/json' } }); }
    recordRequest(route.platform, route.modelId, route.keyId);
    try {
      const opts = { temperature, max_tokens: maxTokens, top_p: topP, top_k: topK, response_format: responseFormat };
      if (stream) {
        const gen = route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, opts);
        const encoder = new TextEncoder();
        const chunks: Uint8Array[] = [];
        let finishReason: string | null = null;
        let outputTokens = 0;
        for await (const chunk of gen) { const c = chunk.choices?.[0]; if (!c) continue; if (c.finish_reason) finishReason = c.finish_reason; const text = c.delta?.content ?? ''; if (text) { outputTokens += Math.ceil(text.length / 4); chunks.push(encoder.encode(`${JSON.stringify({ model, created_at: new Date().toISOString(), response: text, done: false })}\n`)); } }
        if (outputTokens === 0) throw new Error(`empty completion from ${route.displayName}`);
        chunks.push(encoder.encode(`${JSON.stringify({ model, created_at: new Date().toISOString(), response: '', done: true, done_reason: ollamaDoneReason(finishReason), context: [], ...ollamaDurations(start, estimatedInputTokens, outputTokens), prompt_eval_count: estimatedInputTokens, eval_count: outputTokens })}\n`));
        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + outputTokens);
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, outputTokens, Date.now() - start, null);
        return new Response(new ReadableStream({ start(ctrl) { for (const c of chunks) ctrl.enqueue(c); ctrl.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Routed-Via': routedViaValue(route.platform, route.modelId), ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}) } });
      } else {
        const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, opts);
        const text = contentToString(result.choices?.[0]?.message?.content ?? '');
        const reasoning = result.choices?.[0]?.message?.reasoning_content ?? '';
        if ((!text && !reasoning) || isUpstreamClassificationOutput(text, route.platform)) throw new Error(`empty completion from ${route.displayName}${isUpstreamClassificationOutput(text, route.platform) ? ' (upstream classification output)' : ''}`);
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);
        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? (promptTokens + completionTokens));
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null);
        return new Response(JSON.stringify({ model, created_at: new Date().toISOString(), response: text, thinking: reasoning || undefined, done: true, done_reason: ollamaDoneReason(result.choices?.[0]?.finish_reason), context: [], ...ollamaDurations(start, promptTokens, completionTokens), prompt_eval_count: promptTokens, eval_count: completionTokens }), { headers: { 'Content-Type': 'application/json', 'X-Routed-Via': routedViaValue(route.platform, route.modelId), ...(attempt > 0 ? { 'X-Fallback-Attempts': String(attempt) } : {}) } });
      }
    } catch (err: any) {
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, sanitizeProviderErrorMessage(err.message));
      if (isRetryableError(err)) { skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`); setCooldown(route.platform, route.modelId, route.keyId, 120000); recordRateLimitHit(route.modelDbId); lastError = err; continue; }
      return new Response(JSON.stringify({ error: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}` }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return new Response(JSON.stringify({ error: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message ?? 'unknown'}` }), { status: 503, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/embed and /api/embeddings
const embedSchema = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]).optional(),
  prompt: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
}).passthrough().refine(d => d.input != null || d.prompt != null, { message: 'input is required' });

export async function ollamaEmbedRoute(req: Request, legacy: boolean): Promise<Response> {
  if (!authorize(req)) return authFailResponse();
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  const parsed = embedSchema.safeParse(body);
  if (!parsed.success) return new Response(JSON.stringify({ error: `invalid request: ${parsed.error.message}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const rawInput = parsed.data.input ?? parsed.data.prompt ?? '';
  const inputs = Array.isArray(rawInput) ? rawInput : [rawInput];
  try {
    const result = await runEmbeddings(parsed.data.model?.replace(/:latest$/i, ''), inputs, parsed.data.dimensions);
    if (legacy) {
      return new Response(JSON.stringify({ embedding: result.vectors[0] ?? [] }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ model: parsed.data.model || result.family, embeddings: result.vectors, total_duration: 0, load_duration: 0, prompt_eval_count: result.inputTokens }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    return new Response(JSON.stringify({ error: err?.message ?? 'embedding request failed' }), { status, headers: { 'Content-Type': 'application/json' } });
  }
}
