import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { jsonResponse, parseJson } from '../../lib/json.js';

// Playground conversation storage (ported from upstream /api/conversations).
// The Playground page lists conversations in its sidebar (summaries, no
// bodies), loads one when you switch to it, and PUTs the whole transcript back
// after each completed exchange. Gated by the dispatcher's /api/* session auth.

const MAX_TITLE_LEN = 200;
export const MAX_MESSAGES_BYTES = 2 * 1024 * 1024;

const metaSchema = z.object({
  platform: z.string().optional(),
  model: z.string().optional(),
  latency: z.number().optional(),
  fallbackAttempts: z.number().optional(),
  fusionPanel: z.array(z.object({
    platform: z.string(),
    model: z.string(),
    status: z.enum(['ok', 'failed']).optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  })).optional(),
  fusionJudge: z.object({ platform: z.string(), model: z.string() }).nullable().optional(),
});

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  images: z.array(z.string()).optional(),
  isError: z.boolean().optional(),
  reasoning: z.string().optional(),
  meta: metaSchema.optional(),
});

const messagesSchema = z.array(messageSchema);

const modelSchema = z.string().max(200).nullable();
const systemPromptSchema = z.string().max(32_000).nullable();

const createSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).optional(),
  messages: messagesSchema.optional(),
  model: modelSchema.optional(),
  systemPrompt: systemPromptSchema.optional(),
}).strict();

const updateSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).optional(),
  messages: messagesSchema.optional(),
  model: modelSchema.optional(),
  systemPrompt: systemPromptSchema.optional(),
}).strict();

interface ConversationRow {
  id: number;
  title: string;
  messages_json: string;
  model: string | null;
  system_prompt: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface SummaryRow {
  id: number;
  title: string;
  model: string | null;
  message_count: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function toJson(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    messages: parseMessages(row.messages_json),
    model: row.model,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function parseMessages(json: string): unknown[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getConversation(id: number): ConversationRow | undefined {
  return getDb()
    .prepare('SELECT * FROM playground_conversations WHERE id = ?')
    .get(id) as ConversationRow | undefined;
}

function parseId(path: string): number | null {
  const seg = path.split('/').pop() ?? '';
  const id = Number(seg);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function serialiseMessages(messages: unknown[]): { json?: string; error?: Response } {
  const json = JSON.stringify(messages);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_MESSAGES_BYTES) {
    return {
      error: jsonResponse({
        error: {
          message:
            `Conversation is too large to save (${Math.round(bytes / 1024)} KB; the limit is ` +
            `${Math.round(MAX_MESSAGES_BYTES / 1024)} KB). Start a new conversation to keep going.`,
          type: 'conversation_too_large',
        },
      }, 413),
    };
  }
  return { json };
}

export async function conversationsRoute(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const db = getDb();

  // GET /api/conversations — summaries for the sidebar
  if (path === '/api/conversations' && method === 'GET') {
    const rows = db.prepare(`
      SELECT id,
             title,
             model,
             json_array_length(messages_json) AS message_count,
             created_at_ms,
             updated_at_ms
        FROM playground_conversations
       ORDER BY updated_at_ms DESC, id DESC
    `).all() as SummaryRow[];
    return jsonResponse(rows.map(row => ({
      id: row.id,
      title: row.title,
      model: row.model,
      messageCount: row.message_count ?? 0,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
    })));
  }

  // POST /api/conversations — create
  if (path === '/api/conversations' && method === 'POST') {
    const body = await parseJson(req);
    const parsed = createSchema.safeParse(body ?? {});
    if (!parsed.success) return jsonResponse({ error: { message: 'Invalid conversation' } }, 400);
    const ser = serialiseMessages(parsed.data.messages ?? []);
    if (ser.error) return ser.error;

    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO playground_conversations
        (title, messages_json, model, system_prompt, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      parsed.data.title ?? '',
      ser.json!,
      parsed.data.model ?? null,
      parsed.data.systemPrompt ?? null,
      now,
      now,
    );
    return jsonResponse(toJson(getConversation(Number(info.lastInsertRowid))!), 201);
  }

  // Sub-resource routes need a trailing id segment
  const id = parseId(path);
  if (id !== null) {
    // GET /api/conversations/:id — full transcript
    if (method === 'GET') {
      const row = getConversation(id);
      if (!row) return jsonResponse({ error: { message: 'Conversation not found' } }, 404);
      return jsonResponse(toJson(row));
    }

    // PUT /api/conversations/:id — full upsert of mutable state
    if (method === 'PUT') {
      const row = getConversation(id);
      if (!row) return jsonResponse({ error: { message: 'Conversation not found' } }, 404);
      const body = await parseJson(req);
      const parsed = updateSchema.safeParse(body ?? {});
      if (!parsed.success) return jsonResponse({ error: { message: 'Invalid conversation update' } }, 400);

      const { title, messages, model, systemPrompt } = parsed.data;
      let messagesJson = row.messages_json;
      if (messages !== undefined) {
        const ser = serialiseMessages(messages);
        if (ser.error) return ser.error;
        messagesJson = ser.json!;
      }

      db.prepare(`
        UPDATE playground_conversations
           SET title = ?, messages_json = ?, model = ?, system_prompt = ?, updated_at_ms = ?
         WHERE id = ?
      `).run(
        title ?? row.title,
        messagesJson,
        model === undefined ? row.model : model,
        systemPrompt === undefined ? row.system_prompt : systemPrompt,
        Date.now(),
        id,
      );
      return jsonResponse(toJson(getConversation(id)!));
    }

    // DELETE /api/conversations/:id
    if (method === 'DELETE') {
      const info = db.prepare('DELETE FROM playground_conversations WHERE id = ?').run(id);
      if (info.changes === 0) return jsonResponse({ error: { message: 'Conversation not found' } }, 404);
      return jsonResponse({ success: true });
    }
  }

  return jsonResponse({ error: { message: 'Not found' } }, 404);
}
