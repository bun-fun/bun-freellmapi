import { getDb } from '../../db/index.js';
import { encrypt, decrypt, maskKey } from '../../lib/crypto.js';
import { jsonResponse } from '../../lib/json.js';
import { z } from 'zod';

const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu',
  'ollama', 'kilo', 'pollinations', 'llm7', 'huggingface',
  'opencode', 'ovh', 'agnes', 'reka', 'siliconflow',
  'routeway', 'bazaarlink', 'ainative', 'aion', 'requesty',
  'navy', 'nara', 'sealion', 'modelscope', 'aihorde',
  'custom',
] as const;

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().min(1),
  label: z.string().optional(),
});

export async function apiKeysRoute(req: Request, _url: URL): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // List all keys (masked)
  if (path === '/api/keys' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

    const keys = rows.map(row => {
      let maskedKey = '****';
      try {
        const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
        maskedKey = maskKey(realKey);
      } catch {
        maskedKey = '[decrypt failed]';
      }
      return {
        id: row.id,
        platform: row.platform,
        label: row.label,
        maskedKey,
        status: row.status,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        lastCheckedAt: row.last_checked_at,
      };
    });

    return jsonResponse(keys);
  }

  // Add a key
  if (path === '/api/keys' && req.method === 'POST') {
    try {
      const body = await req.json();
      const parsed = addKeySchema.parse(body);
      const { platform, key, label } = parsed;

      const db = getDb();
      const existingCount = (db.prepare('SELECT COUNT(*) as cnt FROM api_keys WHERE platform = ? AND enabled = 1')
        .get(platform) as { cnt: number }).cnt;

      const { encrypted, iv, authTag } = encrypt(key);
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status)
        VALUES (?, ?, ?, ?, ?, 'unknown')
      `).run(platform, label ?? '', encrypted, iv, authTag);

      // If this is the first key for the platform, enable all models for it
      if (existingCount === 0) {
        db.prepare(`UPDATE models SET enabled = 1 WHERE platform = ?`).run(platform);
      }

      return jsonResponse({ success: true }, 201);
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  // Delete a key
  if (path.startsWith('/api/keys/') && req.method === 'DELETE') {
    const parts = path.split('/');
    const id = parseInt(parts[parts.length - 1]);
    if (isNaN(id)) return new Response('Invalid ID', { status: 400 });

    const db = getDb();
    const key = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(id) as { platform: string } | undefined;
    if (!key) return new Response('Not Found', { status: 404 });

    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

    // If no keys left for this platform, disable models
    const remaining = (db.prepare('SELECT COUNT(*) as cnt FROM api_keys WHERE platform = ? AND enabled = 1')
      .get(key.platform) as { cnt: number }).cnt;
    if (remaining === 0) {
      db.prepare(`UPDATE models SET enabled = 0 WHERE platform = ?`).run(key.platform);
    }

    return jsonResponse({ success: true });
  }

  // Toggle key enabled
  if (path.startsWith('/api/keys/') && path.endsWith('/toggle') && req.method === 'POST') {
    const parts = path.split('/');
    const id = parseInt(parts[parts.length - 2]);
    if (isNaN(id)) return new Response('Invalid ID', { status: 400 });

    const db = getDb();
    const key = db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(id) as { enabled: number } | undefined;
    if (!key) return new Response('Not Found', { status: 404 });

    const newEnabled = key.enabled === 1 ? 0 : 1;
    db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(newEnabled, id);

    return jsonResponse({ success: true, enabled: newEnabled === 1 });
  }

  return new Response('Not Found', { status: 404 });
}
