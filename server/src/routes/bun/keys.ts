import crypto from 'crypto';
import { getDb } from '../../db/index.js';
import { encrypt, decrypt, maskKey } from '../../lib/crypto.js';
import { jsonResponse } from '../../lib/json.js';
import { z } from 'zod';
import { resolveProvider } from '../../providers/index.js';
import { resolveCustomEndpointKey } from '../../services/custom-endpoint.js';

// PBKDF2 password verification — must match the Bun fork's auth.ts / db/index.ts
// which stores password_hash as a plain hex PBKDF2 digest and salt in a
// separate column. (Not scrypt like lib/password.ts — that's the upstream
// format and doesn't match this fork's users table.)
function verifyDashboardPassword(password: string, storedHash: string, salt: string): boolean {
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  // Constant-time compare to avoid timing side-channels.
  if (derived.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(storedHash, 'hex'));
}

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
  // `key` is optional so keyless providers (Kilo, OVH, AIHorde) can be added
  // without one; the handler enforces a non-empty key for everyone else.
  key: z.string().optional(),
  label: z.string().optional(),
});

// Count enabled catalog models for a platform. Used to warn when a key is
// added for a provider that has zero models in the operator's catalog —
// the Agnes case (#438): the provider is registered and selectable, but
// its models may not be seeded yet.
function enabledModelCount(db: ReturnType<typeof getDb>, platform: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM models WHERE platform = ? AND enabled = 1',
  ).get(platform) as { c: number };
  return row.c;
}


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
      const { platform, label } = parsed;

      const isKeyless = resolveProvider(platform)?.keyless === true;
      const rawKey = parsed.key?.trim() ?? '';

      if (!isKeyless && !rawKey) {
        return jsonResponse({ error: { message: 'key is required' } }, 400);
      }

      // Keyless providers store a sentinel so routing sees the platform as
      // configured; the provider omits the auth header on outgoing calls.
      const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

      const db = getDb();
      const existingCount = (db.prepare('SELECT COUNT(*) as cnt FROM api_keys WHERE platform = ? AND enabled = 1')
        .get(platform) as { cnt: number }).cnt;

      // A keyless provider needs only one sentinel row — re-enable an existing
      // one instead of piling up duplicates each time the user clicks "Add".
      if (isKeyless) {
        const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
        if (existing) {
          db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
          if (existingCount === 0) {
            db.prepare(`UPDATE models SET enabled = 1 WHERE platform = ?`).run(platform);
          }
          const modelsAvailable = enabledModelCount(db, platform);
          const notice = modelsAvailable === 0
            ? `Key saved, but no ${platform} models are in your catalog yet. `
              + `Add ${platform} as a custom OpenAI-compatible provider with its base URL `
              + `to discover available models, or wait for a catalog update.`
            : undefined;
          return jsonResponse({
            id: existing.id,
            platform,
            label: label ?? '',
            maskedKey: maskKey(keyToStore),
            status: 'unknown',
            enabled: true,
            modelsAvailable,
            notice,
          }, 200);
        }
      }

      const { encrypted, iv, authTag } = encrypt(keyToStore);
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, 'unknown', 1)
      `).run(platform, label ?? '', encrypted, iv, authTag);

      // If this is the first key for the platform, enable all models for it
      if (existingCount === 0) {
        db.prepare(`UPDATE models SET enabled = 1 WHERE platform = ?`).run(platform);
      }

      const modelsAvailable = enabledModelCount(db, platform);
      const notice = modelsAvailable === 0
        ? `Key saved, but no ${platform} models are in your catalog yet. `
          + `Add ${platform} as a custom OpenAI-compatible provider with its base URL `
          + `to discover available models, or wait for a catalog update.`
        : undefined;

      return jsonResponse({ success: true, platform, modelsAvailable, notice }, 201);
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  // Export keys — returns plaintext keys in the requested format.
  // GET /api/keys/export?format=json|env|csv&healthy=true
  // Password re-verification via x-reauth-password header is required.
  if (path === '/api/keys/export' && req.method === 'GET') {
    const password = req.headers.get('x-reauth-password');
    if (!password) {
      return jsonResponse({ error: { message: 'Password verification required to export keys', type: 'authentication_error' } }, 403);
    }

    // Re-verify the password against the first user account (single-user system).
    // Uses PBKDF2 to match the Bun fork's password storage format (salt is a
    // separate column, hash is a plain hex digest — not scrypt$...$...).
    const db = getDb();
    const user = db.prepare('SELECT id, password_hash, salt FROM users LIMIT 1').get() as { id: number; password_hash: string; salt: string } | undefined;
    if (!user || !user.salt || !verifyDashboardPassword(password, user.password_hash, user.salt)) {
      return jsonResponse({ error: { message: 'Password verification failed', type: 'authentication_error' } }, 403);
    }

    const url = new URL(req.url);
    const format = url.searchParams.get('format') ?? 'json';
    const healthyOnly = url.searchParams.get('healthy') === 'true';

    let whereClause = '';
    if (healthyOnly) {
      whereClause = "WHERE status = 'healthy'";
    }

    const rows = db.prepare(`SELECT * FROM api_keys ${whereClause} ORDER BY platform, created_at ASC`).all() as any[];

    // Decrypt and filter — only export keys with a real value
    const decryptedKeys = rows
      .map(row => {
        let key = '';
        try {
          key = decrypt(row.encrypted_key, row.iv, row.auth_tag);
        } catch {
          key = '';
        }
        return {
          platform: row.platform,
          key,
          label: row.label || '',
          baseUrl: row.base_url || undefined,
        };
      })
      .filter(k => {
        const v = k.key.trim();
        return v.length > 0 && v !== 'no-key';
      });

    if (decryptedKeys.length === 0) {
      return jsonResponse({ error: { message: 'No keys to export' } }, 404);
    }

    if (format === 'env') {
      const lines = decryptedKeys.map(k => {
        const envKey = `${k.platform.toUpperCase()}_KEY=${k.key}`;
        return k.label ? `# ${k.label}\n${envKey}` : envKey;
      });
      const content = lines.join('\n\n') + '\n';
      return new Response(content, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="freellmapi-keys.env"',
        },
      });
    }

    if (format === 'csv') {
      const escCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const neutralize = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
      const header = 'platform,key,label';
      const lines = decryptedKeys.map(k =>
        [escCsv(k.platform), escCsv(k.key), escCsv(neutralize(k.label))].join(',')
      );
      const content = [header, ...lines].join('\n') + '\n';
      return new Response(content, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="freellmapi-keys.csv"',
        },
      });
    }

    // Default: JSON format
    const jsonExport = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'freellmapi',
      keys: decryptedKeys,
    };
    return new Response(JSON.stringify(jsonExport, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="freellmapi-keys.json"',
      },
    });
  }

  // Update a key (e.g. label)
  if (path.match(/^\/api\/keys\/\d+$/) && req.method === 'PATCH') {
    const parts = path.split('/');
    const id = parseInt(parts[parts.length - 1]);
    if (isNaN(id)) return new Response('Invalid ID', { status: 400 });

    const db = getDb();
    const key = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(id) as { id: number } | undefined;
    if (!key) return new Response('Not Found', { status: 404 });

    let body: any;
    try { body = await req.json(); } catch {
      return jsonResponse({ error: { message: 'Invalid JSON' } }, 400);
    }

    const updates: string[] = [];
    const values: any[] = [];
    if (typeof body.label === 'string') {
      updates.push('label = ?');
      values.push(body.label);
    }
    if (typeof body.enabled === 'boolean') {
      updates.push('enabled = ?');
      values.push(body.enabled ? 1 : 0);
    }
    if (updates.length === 0) {
      return jsonResponse({ error: { message: 'No valid fields to update' } }, 400);
    }
    values.push(id);
    db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    return jsonResponse({ success: true });
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

  // Toggle all keys for a platform enabled/disabled
  if (path.startsWith('/api/keys/platform/') && req.method === 'PATCH') {
    const platform = path.split('/').pop();
    if (!platform) return new Response('Invalid platform', { status: 400 });
    try {
      const body = await req.json() as { enabled: boolean };
      const db = getDb();
      const rows = db.prepare('SELECT id FROM api_keys WHERE platform = ?').all(platform) as { id: number }[];
      if (rows.length === 0) return jsonResponse({ success: true, changed: 0 });
      const enabled = body.enabled ? 1 : 0;
      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE api_keys SET enabled = ? WHERE id IN (${placeholders})`).run(enabled, ...ids);
      // Update model enablement to match
      db.prepare(`UPDATE models SET enabled = ? WHERE platform = ?`).run(enabled, platform);
      return jsonResponse({ success: true, changed: rows.length });
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, 400);
    }
  }

  return new Response('Not Found', { status: 404 });
}
