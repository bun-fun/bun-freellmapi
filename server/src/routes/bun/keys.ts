import crypto from 'crypto';
import { getDb } from '../../db/index.js';
import { encrypt, decrypt, maskKey } from '../../lib/crypto.js';
import { jsonResponse } from '../../lib/json.js';
import { z } from 'zod';
import { resolveProvider, getAllProviders } from '../../providers/index.js';
import { resolveCustomEndpointKey, customEndpointKeyIds } from '../../services/custom-endpoint.js';
import { normalizeBaseUrl } from '../../lib/endpoint-scope.js';
import { assessProviderUrl } from '../../lib/url-guard.js';
import { discoverEndpointModels, probeEndpointModel, classifyModelId, ModelDiscoveryError } from '../../services/model-discovery.js';
import { clearCooldownsForKey, getActiveCooldownsForKeys } from '../../services/ratelimit.js';
import { registerCustomChatModels, type CustomModelEntry } from '../../services/custom-model-register.js';
import { registerCustomMediaModel } from '../../services/custom-media-register.js';
import { probeEmbeddingDimensions, registerCustomEmbeddingModel } from '../../services/embeddings.js';
import { parseKeysFromFile, stripTrailingCommas, stripJsoncComments } from '../../lib/key-parser.js';

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
  'google', 'groq', 'cerebras', 'sambanova', 'bai', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu',
  'ollama', 'kilo', 'pollinations', 'llm7', 'huggingface',
  'opencode', 'ovh', 'agnes', 'reka', 'siliconflow',
  'routeway', 'bazaarlink', 'ainative', 'aion', 'requesty',
  'navy', 'nara', 'sealion', 'anyapi', 'orcarouter', 'modelscope',
  'qianfan', 'volcengine', 'longcat', 'xfyun', 'aihorde',
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

/**
 * Whether a stored row belongs in an export file. Kept in one place because
 * the export dialog shows a count before downloading, and computing that
 * count from a different rule than the export itself made it lie (#687).
 *
 * A custom endpoint is worth exporting even when it holds only the `no-key`
 * placeholder — the endpoint IS the thing being backed up, and its base_url
 * restores it. Anything else needs a real secret to be worth a line.
 */
function isExportableKey(row: { platform: string; baseUrl: string | null; key: string }): boolean {
  if (row.platform === 'custom') return Boolean(row.baseUrl);
  const v = row.key.trim();
  return v.length > 0 && v !== 'no-key';
}

interface CustomEndpointRef {
  baseUrl: string;
  keyId: number | null;
  storedKey: string | null;
}

// Turn a `{ keyId?, baseUrl? }` reference into the endpoint it names. A keyId
// is the stronger reference (it identifies one credential of the pool); a bare
// baseUrl falls back to the endpoint's first stored key, which is how the rest
// of the custom-endpoint machinery addresses an endpoint. Throws a
// `{ status, message }` for a reference that names nothing usable.
function resolveEndpointRef(ref: { keyId?: number; baseUrl?: string }): CustomEndpointRef {
  const db = getDb();
  const requestedBaseUrl = ref.baseUrl === undefined ? undefined : normalizeBaseUrl(ref.baseUrl);

  if (ref.keyId !== undefined) {
    const row = db.prepare('SELECT id, platform, base_url, encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?')
      .get(ref.keyId) as { id: number; platform: string; base_url: string | null; encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (!row || row.platform !== 'custom' || !row.base_url) {
      throw Object.assign(new Error('keyId does not name a custom endpoint'), { status: 400 });
    }
    if (requestedBaseUrl !== undefined && requestedBaseUrl !== row.base_url) {
      throw Object.assign(new Error('baseUrl does not match the endpoint keyId belongs to'), { status: 400 });
    }
    let storedKey: string | null = null;
    try {
      storedKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    } catch { /* an undecryptable row still names the endpoint */ }
    return { baseUrl: row.base_url, keyId: row.id, storedKey };
  }

  if (!requestedBaseUrl) {
    throw Object.assign(new Error('baseUrl or keyId is required'), { status: 400 });
  }

  // Any key of this base_url serves the whole endpoint (#619), so the first one
  // is as good a representative as any.
  const rows = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag FROM api_keys
     WHERE platform = 'custom' AND base_url = ? ORDER BY id
  `).all(requestedBaseUrl) as Array<{ id: number; encrypted_key: string; iv: string; auth_tag: string }>;
  for (const row of rows) {
    try {
      return { baseUrl: requestedBaseUrl, keyId: row.id, storedKey: decrypt(row.encrypted_key, row.iv, row.auth_tag) };
    } catch { /* try the next credential */ }
  }
  return { baseUrl: requestedBaseUrl, keyId: rows[0]?.id ?? null, storedKey: null };
}

// SSRF guard (#440): a base_url is the one user-controlled outbound target.
// Cloud metadata / link-local addresses are rejected outright; private ranges
// too when FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS is set.
async function rejectUnsafeBaseUrl(baseUrl: string): Promise<Response | null> {
  const verdict = await assessProviderUrl(baseUrl);
  if (verdict.allowed) return null;
  return jsonResponse({ error: { message: `baseUrl rejected: ${verdict.reason}` } }, 400);
}

// Ask a configured custom endpoint what models it currently serves (#488).
const discoverModelsSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  keyId: z.number().int().positive().optional(),
  // Lets the Keys page fetch a list for an endpoint the user is still typing in,
  // before it has been saved. Falls back to the endpoint's stored credential.
  apiKey: z.string().optional(),
}).refine(
  d => d.baseUrl !== undefined || d.keyId !== undefined,
  { message: 'baseUrl or keyId is required' },
);

function splitRawKey(rawKey: string) {
  const eqIndex = rawKey.indexOf('=');
  return {
    keyName: eqIndex === -1 ? rawKey : rawKey.slice(0, eqIndex),
    keyValue: eqIndex === -1 ? '' : rawKey.slice(eqIndex + 1),
  };
}

function insertImportedKey(platform: (typeof PLATFORMS)[number], keyName: string, keyValue: string) {
  if (platform === 'custom') {
    throw new Error('Custom providers must be added with a base URL');
  }
  if (!resolveProvider(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(keyValue.trim());
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, keyName, encrypted, iv, authTag);
}

// Models attached to an imported custom endpoint (#382). Ids that look like
// embedding models go through the embeddings path — it needs a dimension, so
// reuse the stored one when the model is already registered and probe the
// endpoint only for a new id. Everything else registers as a chat model.
async function registerImportedModels(
  db: ReturnType<typeof getDb>,
  baseUrl: string,
  keyId: number,
  apiKey: string,
  keyName: string,
  models: Array<{ id: string; supportsTools?: boolean; supportsVision?: boolean }>,
  errors: Array<{ key: string; error: string }>,
): Promise<number> {
  // #1051: classify by id, not just /embedding/. A whisper, diffusion or video
  // id registered as a chat model 404s in every chain; they go to their own
  // tables (or, for video, are skipped — nothing can serve a custom video
  // model yet).
  const kindOf = (id: string) => /embedding/i.test(id) ? 'embedding' : classifyModelId(id);
  const chat = models.filter(m => kindOf(m.id) === undefined);
  const embeds = models.filter(m => kindOf(m.id) === 'embedding');
  const media = models.filter(m => {
    const kind = kindOf(m.id);
    return kind === 'image' || kind === 'audio' || kind === 'transcription';
  });
  const video = models.filter(m => kindOf(m.id) === 'video');
  let registered = 0;

  if (chat.length > 0) {
    const entries: CustomModelEntry[] = chat.map(m => ({
      modelId: m.id,
      displayName: null,
      supportsTools: m.supportsTools,
      supportsVision: m.supportsVision,
    }));
    registered += db.transaction(() => registerCustomChatModels(db, baseUrl, keyId, entries))().length;
  }

  for (const m of media) {
    try {
      registerCustomMediaModel(db, keyId, {
        modelId: m.id,
        displayName: null,
        modality: kindOf(m.id) as 'image' | 'audio' | 'transcription',
      });
      registered++;
    } catch (err: any) {
      errors.push({ key: `${keyName}: ${m.id}`, error: err?.message ?? 'media registration failed' });
    }
  }
  for (const m of video) {
    errors.push({ key: `${keyName}: ${m.id}`, error: 'video generation models are not supported on custom endpoints yet; skipped' });
  }

  for (const m of embeds) {
    try {
      const existing = db.prepare(
        "SELECT dimensions FROM embedding_models WHERE platform = 'custom' AND model_id = ?",
      ).get(m.id) as { dimensions: number } | undefined;
      const dimensions = existing?.dimensions ?? await probeEmbeddingDimensions(baseUrl, apiKey, m.id);
      registerCustomEmbeddingModel(db, {
        keyId,
        modelId: m.id,
        displayName: null,
        family: m.id,
        dimensions,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
      });
      registered++;
    } catch (err: any) {
      errors.push({ key: `${keyName}: ${m.id}`, error: err?.message ?? 'embedding registration failed' });
    }
  }

  return registered;
}

// Parse one uploaded file's bytes into key candidates (#705). JSON/JSONC files
// are validated before handing them to the parser so malformed exports fail
// with a clear message instead of a silent zero-key result.
function parseUploadedFile(name: string, content: string) {
  if (!content.trim()) {
    throw Object.assign(new Error('File contains no data'), { status: 400 });
  }
  if (/\.jsonc?$/i.test(name)) {
    try {
      JSON.parse(stripTrailingCommas(stripJsoncComments(content)));
    } catch {
      throw Object.assign(new Error('Invalid JSON format'), { status: 400 });
    }
  }
  return parseKeysFromFile(content, name);
}


export async function apiKeysRoute(req: Request, _url: URL): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Provider checklist
  if (path === '/api/keys/providers' && req.method === 'GET') {
    const db = getDb();
    const countRows = db.prepare(`
      SELECT platform, COUNT(*) AS total_keys,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_keys
      FROM api_keys GROUP BY platform
    `).all() as Array<{ platform: string; total_keys: number; enabled_keys: number }>;
    const countsByPlatform = new Map(countRows.map(r => [r.platform, r]));

    const providers = getAllProviders()
      .filter(p => p.platform !== 'custom')
      .map(p => {
        const counts = countsByPlatform.get(p.platform);
        const keyCount = counts?.total_keys ?? 0;
        return {
          platform: p.platform,
          name: p.name,
          keyless: p.keyless,
          configured: keyCount > 0,
          keyCount,
          enabledKeyCount: counts?.enabled_keys ?? 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const configured = providers.filter(p => p.configured).length;
    return jsonResponse({
      providers,
      summary: {
        total: providers.length,
        configured,
        unconfigured: providers.length - configured,
      },
    });
  }

  // List all keys (masked)
  if (path === '/api/keys' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

    // Models attached to custom endpoints, grouped by ENDPOINT not by key row:
    // an endpoint can hold several credentials (#619) and every one of them
    // serves the endpoint's whole model list.
    const customModels = [
      ...db.prepare(`
        SELECT key_id, id, 'chat' AS kind, model_id, display_name, NULL AS family
          FROM models
         WHERE platform = 'custom' AND key_id IS NOT NULL
      `).all() as any[],
      ...db.prepare(`
        SELECT key_id, id, 'embedding' AS kind, model_id, display_name, family
          FROM embedding_models
         WHERE platform = 'custom' AND key_id IS NOT NULL
      `).all() as any[],
      ...db.prepare(`
        SELECT key_id, id, modality AS kind, model_id, display_name, NULL AS family
          FROM media_models
         WHERE platform = 'custom' AND key_id IS NOT NULL
      `).all() as any[],
    ];
    const endpointOfKey = new Map<number, string>();
    for (const row of rows) {
      if (row.platform === 'custom' && row.base_url) endpointOfKey.set(Number(row.id), row.base_url);
    }
    const endpointOf = (keyId: number) => endpointOfKey.get(keyId) ?? `key:${keyId}`;

    const modelsByEndpoint = new Map<string, any[]>();
    for (const m of customModels) {
      const keyId = Number(m.key_id);
      if (!Number.isInteger(keyId)) continue;
      const list = modelsByEndpoint.get(endpointOf(keyId)) ?? [];
      list.push({
        id: m.id,
        kind: m.kind,
        modelId: m.model_id,
        displayName: m.display_name,
        family: m.family ?? null,
      });
      modelsByEndpoint.set(endpointOf(keyId), list);
    }
    for (const list of modelsByEndpoint.values()) {
      list.sort((a, b) => {
        const ka = ['chat', 'embedding', 'image', 'audio'].indexOf(a.kind);
        const kb = ['chat', 'embedding', 'image', 'audio'].indexOf(b.kind);
        return (ka - kb) || String(a.displayName).localeCompare(String(b.displayName));
      });
    }

    // A cooling-down key reads as healthy and enabled while the router skips
    // it, so surface the cooldowns that explain the idleness (#P0-7).
    const cooldownsByKeyId = getActiveCooldownsForKeys(rows.map(row => Number(row.id)));

    const keys = rows.map(row => {
      let maskedKey = '****';
      let realKey = '';
      try {
        realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
        maskedKey = maskKey(realKey);
      } catch {
        maskedKey = '[decrypt failed]';
      }
      const cooldowns = cooldownsByKeyId.get(Number(row.id)) ?? [];
      return {
        id: row.id,
        platform: row.platform,
        label: row.label,
        maskedKey,
        baseUrl: row.base_url ?? null,
        status: row.status,
        enabled: row.enabled === 1,
        keyless: resolveProvider(row.platform)?.keyless === true,
        // Lets the export dialog count exactly what the export will write.
        exportable: isExportableKey({ platform: row.platform, baseUrl: row.base_url ?? null, key: realKey }),
        createdAt: row.created_at,
        lastCheckedAt: row.last_checked_at,
        lastHealthError: row.last_health_error ?? null,
        models: row.platform === 'custom' ? (modelsByEndpoint.get(endpointOf(Number(row.id))) ?? []) : undefined,
        cooldowns: cooldowns.map(c => ({
          modelId: c.modelId,
          expiresAtMs: c.expiresAtMs,
          remainingMs: c.remainingMs,
        })),
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

    // Decrypt and filter with the same rule the dialog counts by (#687):
    // a custom endpoint exports even when it only holds the no-key sentinel,
    // because its base_url is what restores it.
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
      .filter(k => isExportableKey({ platform: k.platform, baseUrl: k.baseUrl ?? null, key: k.key }));

    if (decryptedKeys.length === 0) {
      return jsonResponse({ error: { message: 'No keys to export' } }, 404);
    }

    if (format === 'env') {
      // Names have to stay unique: a .env round trip reads back into a map
      // keyed by name, so two rows sharing one name collapse into one key.
      // Repeats take a numeric suffix (GOOGLE_KEY_2), which still resolves to
      // the same platform through PREFIX_MAP.
      //
      // Custom endpoints get an indexed PAIR — a custom key without its
      // base_url cannot be restored (#687).
      const seenPerPlatform = new Map<string, number>();
      let customIndex = 0;
      const lines = decryptedKeys.map(k => {
        if (k.platform === 'custom' && k.baseUrl) {
          customIndex++;
          return [
            `# ${k.label || `custom endpoint ${customIndex}`}`,
            `CUSTOM_${customIndex}_BASE_URL=${k.baseUrl}`,
            `CUSTOM_${customIndex}_KEY=${k.key}`,
          ].join('\n');
        }
        const n = (seenPerPlatform.get(k.platform) ?? 0) + 1;
        seenPerPlatform.set(k.platform, n);
        const envKey = `${k.platform.toUpperCase()}_KEY${n > 1 ? `_${n}` : ''}=${k.key}`;
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
      // base_url is the fourth column: a custom row is an ENDPOINT, and
      // without its URL the key cannot be re-imported (#687). The importer
      // tolerates the three-column form too.
      const header = 'platform,key,label,base_url';
      const lines = decryptedKeys.map(k =>
        [escCsv(k.platform), escCsv(k.key), escCsv(neutralize(k.label)), escCsv(k.baseUrl ?? '')].join(',')
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

  // Clear every active cooldown for one key — an escalated cooldown can bench a
  // key for up to 24h from one bad window; give the operator a way back.
  // (Must precede the generic DELETE /:id handler, which would otherwise claim
  // the trailing 'cooldowns' segment as an id.)
  if (path.startsWith('/api/keys/') && path.endsWith('/cooldowns') && req.method === 'DELETE') {
    const idStr = path.slice('/api/keys/'.length, -'/cooldowns'.length);
    const id = Number(idStr);
    if (!Number.isInteger(id)) {
      return jsonResponse({ error: 'Invalid key id' }, 400);
    }
    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get(id);
    if (!exists) {
      return jsonResponse({ error: 'Key not found' }, 404);
    }
    const cleared = clearCooldownsForKey(id);
    return jsonResponse({ success: true, cleared });
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

  // Ask an endpoint what models it currently serves (#488). Reads ONLY the
  // operator's own base_url with their own key; nothing is written.
  if (path === '/api/keys/custom/discover-models' && req.method === 'POST') {
    let body: unknown;
    try { body = await req.json(); } catch { body = undefined; }
    const parsed = discoverModelsSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }, 400);
    }

    let endpoint: CustomEndpointRef;
    try {
      endpoint = resolveEndpointRef(parsed.data);
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, err.status ?? 400);
    }

    const rejected = await rejectUnsafeBaseUrl(endpoint.baseUrl);
    if (rejected) return rejected;

    // A submitted key wins (the user may be rotating it); otherwise use what the
    // endpoint already has. Auth-less local servers keep the 'no-key' sentinel.
    const apiKey = parsed.data.apiKey?.trim() || endpoint.storedKey || 'no-key';

    try {
      const discovered = await discoverEndpointModels(endpoint.baseUrl, apiKey);

      // "Already registered" means bound to THIS endpoint — any key of the pool
      // counts, since they all serve the same model list (#619).
      const db = getDb();
      const registeredIds = new Set<string>();
      if (endpoint.keyId != null) {
        const poolIds = [...customEndpointKeyIds(db, endpoint.keyId)];
        const placeholders = poolIds.map(() => '?').join(', ');
        const rows = db.prepare(
          `SELECT model_id FROM models WHERE platform = 'custom' AND key_id IN (${placeholders})`,
        ).all(...poolIds) as { model_id: string }[];
        for (const row of rows) registeredIds.add(row.model_id);
      }

      const models = discovered.map(m => ({ ...m, registered: registeredIds.has(m.id) }));
      return jsonResponse({
        baseUrl: endpoint.baseUrl,
        keyId: endpoint.keyId,
        models,
        total: models.length,
        registeredCount: models.filter(m => m.registered).length,
      });
    } catch (err: any) {
      if (err instanceof ModelDiscoveryError) {
        // `upstream_error`, never `authentication_error`: this status is relayed
        // from the operator's own endpoint, and a client that reads a bare 401 as
        // "session expired" would sign the operator out for testing a bad key.
        return jsonResponse({ error: { message: err.message, type: 'upstream_error' } }, err.status);
      }
      return jsonResponse({ error: { message: `Model discovery failed: ${err?.message ?? 'unknown error'}` } }, 502);
    }
  }

  // Fire one minimal real chat request at the endpoint (#685): gives an
  // unmeasured model a reliability/speed sample immediately. Only a SUCCESSFUL
  // probe writes a `requests` row and lifts the key's cooldowns.
  if (path === '/api/keys/custom/probe' && req.method === 'POST') {
    let body: unknown;
    try { body = await req.json(); } catch { body = undefined; }
    const parsed = discoverModelsSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }, 400);
    }

    let endpoint: CustomEndpointRef;
    try {
      endpoint = resolveEndpointRef(parsed.data);
    } catch (err: any) {
      return jsonResponse({ error: { message: err.message } }, err.status ?? 400);
    }

    const rejected = await rejectUnsafeBaseUrl(endpoint.baseUrl);
    if (rejected) return rejected;

    const apiKey = parsed.data.apiKey?.trim() || endpoint.storedKey || 'no-key';

    // Probe a model actually REGISTERED on this endpoint when there is one —
    // the sample must feed the stats of a model the router can pick. Any key
    // of the pool counts (#619); discovery is only the fallback.
    let registeredModelId: string | null = null;
    if (endpoint.keyId != null) {
      const db = getDb();
      const poolIds = [...customEndpointKeyIds(db, endpoint.keyId)];
      const placeholders = poolIds.map(() => '?').join(', ');
      const row = db.prepare(
        `SELECT model_id FROM models WHERE platform = 'custom' AND key_id IN (${placeholders}) ORDER BY id LIMIT 1`,
      ).get(...poolIds) as { model_id: string } | undefined;
      registeredModelId = row?.model_id ?? null;
    }

    try {
      const probe = await probeEndpointModel(endpoint.baseUrl, apiKey, registeredModelId);

      if (endpoint.keyId != null) {
        getDb().prepare(`
          INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, request_type)
          VALUES ('custom', ?, ?, 'success', ?, ?, ?, ?, 'chat')
        `).run(probe.modelId, endpoint.keyId, probe.inputTokens, probe.outputTokens, probe.latencyMs, probe.latencyMs);
        clearCooldownsForKey(endpoint.keyId);
      }

      return jsonResponse({ modelId: probe.modelId, latencyMs: probe.latencyMs });
    } catch (err: any) {
      if (err instanceof ModelDiscoveryError) {
        // `upstream_error`, never `authentication_error`: this status is relayed
        // from the operator's own endpoint, and a client that reads a bare 401 as
        // "session expired" would sign the operator out for testing a bad key.
        return jsonResponse({ error: { message: err.message, type: 'upstream_error' } }, err.status);
      }
      return jsonResponse({ error: { message: `Probe failed: ${err?.message ?? 'unknown error'}` } }, 502);
    }
  }

  // Reveal ONE key in plaintext for a copy action (#705), gated exactly like
  // the export it narrows: session alone is not enough, re-enter the password.
  if (path.startsWith('/api/keys/') && path.endsWith('/reveal') && req.method === 'POST') {
    const password = req.headers.get('x-reauth-password');
    if (!password) {
      return jsonResponse({ error: { message: 'Password verification required to reveal a key', type: 'authentication_error' } }, 403);
    }
    const db = getDb();
    const user = db.prepare('SELECT id, password_hash, salt FROM users LIMIT 1').get() as { id: number; password_hash: string; salt: string } | undefined;
    if (!user || !user.salt || !verifyDashboardPassword(password, user.password_hash, user.salt)) {
      return jsonResponse({ error: { message: 'Password verification required to reveal a key', type: 'authentication_error' } }, 403);
    }

    const idStr = path.slice('/api/keys/'.length, -'/reveal'.length);
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return jsonResponse({ error: { message: 'Invalid key ID' } }, 400);
    }

    const row = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?')
      .get(id) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (!row) {
      return jsonResponse({ error: { message: 'Key not found' } }, 404);
    }

    try {
      return jsonResponse({ key: decrypt(row.encrypted_key, row.iv, row.auth_tag) });
    } catch {
      return jsonResponse({ error: { message: 'This key could not be decrypted. It was stored with a different ENCRYPTION_KEY.' } }, 500);
    }
  }

  // Bulk import preview (#705): parse uploaded files into candidate keys and
  // flag duplicates against what is already stored. Nothing is persisted here.
  if (path === '/api/keys/preview' && req.method === 'POST') {
    try {
      const form = await req.formData();
      const files = [...form.getAll('files')].filter((v): v is File => v instanceof File);
      if (files.length === 0) {
        return jsonResponse({ error: { message: 'No files uploaded' } }, 400);
      }
      if (files.length > 10) {
        return jsonResponse({ error: { message: 'Too many files. Maximum is 10' } }, 413);
      }

      const keys: Array<{
        keyName: string; keyValue: string; detectedPlatform: string | null; prefix: string;
        baseUrl?: string; models?: Array<{ id: string; supportsTools?: boolean; supportsVision?: boolean }>;
        isDuplicate: boolean;
      }> = [];
      const skipped: string[] = [];

      const db = getDb();
      const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
      const existingKeys = new Set<string>();
      for (const row of existingRows) {
        try {
          existingKeys.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
        } catch { /* skip undecryptable rows */ }
      }

      let duplicateCount = 0;

      for (const file of files) {
        const content = await file.text();
        const result = parseUploadedFile(file.name, content);
        for (const parsedKey of result.keys) {
          const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
          const isDuplicate = existingKeys.has(keyValue.trim());
          if (isDuplicate) duplicateCount++;
          keys.push({
            keyName,
            keyValue,
            detectedPlatform: parsedKey.platform,
            prefix: parsedKey.prefix,
            ...(parsedKey.baseUrl ? { baseUrl: parsedKey.baseUrl } : {}),
            ...(parsedKey.models?.length ? { models: parsedKey.models } : {}),
            isDuplicate,
          });
        }
        skipped.push(...result.skipped);
      }

      return jsonResponse({ keys, total: keys.length, skipped, duplicates: duplicateCount });
    } catch (handlerErr: any) {
      return jsonResponse({ error: { message: handlerErr.message } }, handlerErr.status ?? 500);
    }
  }

  // Import the preview-selected keys (#687/#382). This is the route the
  // dashboard actually uses after /preview, so custom endpoints must restore
  // from their own export file here.
  if (path === '/api/keys/import-selected' && req.method === 'POST') {
    let body: unknown;
    try { body = await req.json(); } catch { body = undefined; }
    const importKeySchema = z.object({
      keyName: z.string().optional(),
      keyValue: z.string().min(1),
      platform: z.enum(PLATFORMS),
      baseUrl: z.string().optional(),
      models: z.array(z.object({
        id: z.string().min(1),
        supportsTools: z.boolean().optional(),
        supportsVision: z.boolean().optional(),
      })).max(200).optional(),
    });
    const parsed = z.object({ keys: z.array(importKeySchema).max(100) }).safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }, 400);
    }

    let imported = 0;
    let duplicateSkipped = 0;
    let modelsRegistered = 0;
    const errors: Array<{ key: string; error: string }> = [];

    const db = getDb();
    const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
    const existingKeys = new Set<string>();
    for (const row of existingRows) {
      try {
        existingKeys.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
      } catch { /* skip undecryptable rows */ }
    }

    // One SSRF verdict per endpoint, not per key — a pooled endpoint brings
    // several keys to one URL and each check costs a DNS lookup.
    const urlVerdicts = new Map<string, { allowed: boolean; reason?: string }>();

    for (const key of parsed.data.keys) {
      const keyName = key.keyName?.trim() || key.platform;
      if (key.platform === 'custom') {
        if (!key.baseUrl) {
          errors.push({ key: keyName, error: 'Custom providers must be added with a base URL' });
          continue;
        }
        const baseUrl = normalizeBaseUrl(key.baseUrl);
        let verdict = urlVerdicts.get(baseUrl);
        if (!verdict) {
          verdict = await assessProviderUrl(baseUrl);
          urlVerdicts.set(baseUrl, verdict);
        }
        if (!verdict.allowed) {
          errors.push({ key: keyName, error: `baseUrl rejected: ${verdict.reason}` });
          continue;
        }
        try {
          // 'no-key' is the auth-less placeholder — hand it over as "no key
          // submitted" so the resolver stores the sentinel once instead of
          // encrypting the literal string. Going through the resolver keeps
          // endpoint pooling intact (#619).
          const secret = key.keyValue.trim() === 'no-key' ? undefined : key.keyValue.trim() || undefined;
          const resolved = resolveCustomEndpointKey(db, baseUrl, secret, keyName);
          imported++;
          if (key.models?.length) {
            modelsRegistered += await registerImportedModels(
              db, baseUrl, resolved.keyId, resolved.storedKey, keyName, key.models, errors,
            );
          }
        } catch (err) {
          errors.push({ key: keyName, error: (err as Error).message });
        }
        continue;
      }

      if (existingKeys.has(key.keyValue.trim())) {
        duplicateSkipped++;
        errors.push({ key: keyName, error: 'Duplicate key — already exists' });
        continue;
      }

      try {
        insertImportedKey(key.platform, keyName, key.keyValue);
        imported++;
        existingKeys.add(key.keyValue.trim());
      } catch (err) {
        errors.push({ key: keyName, error: (err as Error).message });
      }
    }

    return jsonResponse({
      imported,
      skipped: [],
      errors,
      total: parsed.data.keys.length,
      modelsRegistered,
    });
  }

  return new Response('Not Found', { status: 404 });
}
