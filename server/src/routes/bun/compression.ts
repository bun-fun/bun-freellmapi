import type { ChatMessage, ChatToolDefinition } from '@freellmapi/shared/types.js';
import { z } from 'zod';
import { jsonResponse } from '../../lib/json.js';
import { COMPRESSION_MODES, type CompressionMode } from '../../services/compression/types.js';
import { compressRequest } from '../../services/compression/pipeline.js';
import { getCompressionConfig } from '../../services/compression/config.js';
import { getCompressionStats } from '../../services/compression/stats.js';

const previewMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string(),
    z.null(),
    z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  ]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }),
  }).passthrough()).optional(),
}).passthrough();

function previewMessages(body: unknown): ChatMessage[] | null {
  if (typeof body === 'string') return [{ role: 'user', content: body }];
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (Array.isArray(value.messages)) {
    const parsed = z.array(previewMessageSchema).safeParse(value.messages);
    return parsed.success ? parsed.data as ChatMessage[] : null;
  }
  if (typeof value.body === 'string') return [{ role: 'user', content: value.body }];
  if (value.body && typeof value.body === 'object' && Array.isArray((value.body as Record<string, unknown>).messages)) {
    const parsed = z.array(previewMessageSchema).safeParse((value.body as Record<string, unknown>).messages);
    return parsed.success ? parsed.data as ChatMessage[] : null;
  }
  return null;
}

export async function compressionRoute(req: Request, _url: URL): Promise<Response> {
  const path = new URL(req.url).pathname;

  if (path === '/api/compression/stats' && req.method === 'GET') {
    return jsonResponse({ config: getCompressionConfig(), ...getCompressionStats() });
  }

  // Dry-run the compression pipeline on an arbitrary payload (#712): accepts
  // raw messages, a full request body, or a bare string; nothing is recorded.
  if (path === '/api/compression/preview' && req.method === 'POST') {
    let body: unknown;
    try { body = await req.json(); } catch { body = undefined; }
    const messages = previewMessages(body);
    if (!messages || messages.length === 0) {
      return jsonResponse({
        error: {
          message: 'Preview requires `messages`, a request `body` containing messages, or a string `body`.',
          type: 'invalid_request_error',
        },
      }, 400);
    }
    const rawMode = (body as { mode?: unknown })?.mode;
    const mode: CompressionMode = typeof rawMode === 'string'
      && (COMPRESSION_MODES as readonly string[]).includes(rawMode)
        ? rawMode as CompressionMode
        : getCompressionConfig().mode;
    const targetTokens = (body as { targetTokens?: unknown })?.targetTokens;
    const tools = Array.isArray((body as { tools?: unknown })?.tools)
      ? (body as { tools: ChatToolDefinition[] }).tools
      : undefined;
    const result = compressRequest(messages, {
      previewMode: mode,
      targetTokens: typeof targetTokens === 'number' && targetTokens > 0 ? Math.floor(targetTokens) : undefined,
      tools,
      recordStats: false,
    });
    return jsonResponse({
      mode: result.mode,
      original: messages,
      compressed: result.messages,
      diff: {
        beforeChars: result.stats.originalChars,
        afterChars: result.stats.compressedChars,
        savedChars: result.stats.originalChars - result.stats.compressedChars,
      },
      stats: result.stats,
    });
  }

  return new Response('Not Found', { status: 404 });
}
