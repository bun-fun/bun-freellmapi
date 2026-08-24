import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { jsonResponse } from '../../lib/json.js';
import { encrypt, decrypt, maskKey } from '../../lib/crypto.js';
import { mintClientProfileKey, hashClientProfileKey } from '../../lib/system-prompt.js';

// Client-profile CRUD (#411). The full `sk-cp-...` key is returned exactly
// once — from create and rotate; the list endpoint only ever shows the masked
// form (rendered from the encrypted copy, since the auth path stores nothing
// but a hash).

const MAX_NAME_LEN = 100;
// Generous ceiling — a system prompt is configuration, not a document.
const MAX_PROMPT_LEN = 32_000;

const createSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullish(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
  // null clears the prompt (the profile key then authenticates without
  // injecting anything); absent leaves it untouched.
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullable().optional(),
  enabled: z.boolean().optional(),
});

interface ProfileRow {
  id: number;
  name: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  system_prompt: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function maskedKeyFor(row: Pick<ProfileRow, 'encrypted_key' | 'iv' | 'auth_tag'>): string {
  try {
    return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return '[decrypt failed]';
  }
}

function toJson(row: ProfileRow) {
  return {
    id: row.id,
    name: row.name,
    maskedKey: maskedKeyFor(row),
    systemPrompt: row.system_prompt,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getProfile(id: number): ProfileRow | undefined {
  return getDb().prepare('SELECT * FROM client_profiles WHERE id = ?').get(id) as ProfileRow | undefined;
}

function invalidId(): Response {
  return jsonResponse({ error: { message: 'Invalid profile id' } }, 400);
}

function notFound(): Response {
  return jsonResponse({ error: { message: 'Client profile not found' } }, 404);
}

export async function clientProfilesRoute(req: Request, _url: URL): Promise<Response> {
  const path = new URL(req.url).pathname;
  const segments = path.split('/').filter(Boolean); // ['api', 'client-profiles', ...]

  if (segments[1] !== 'client-profiles') {
    return new Response('Not Found', { status: 404 });
  }

  const id = segments.length > 2 ? Number(segments[2]) : undefined;

  // GET /api/client-profiles
  if (segments.length === 2 && req.method === 'GET') {
    const rows = getDb().prepare('SELECT * FROM client_profiles ORDER BY id').all() as ProfileRow[];
    return jsonResponse(rows.map(toJson));
  }

  // POST /api/client-profiles
  if (segments.length === 2 && req.method === 'POST') {
    let body: unknown;
    try { body = await req.json(); } catch { body = undefined; }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: { message: 'A profile name is required' } }, 400);
    }
    const key = mintClientProfileKey();
    const { encrypted, iv, authTag } = encrypt(key);
    const prompt = parsed.data.systemPrompt?.trim() || null;
    const info = getDb().prepare(`
      INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(parsed.data.name, hashClientProfileKey(key), encrypted, iv, authTag, prompt);
    const row = getProfile(Number(info.lastInsertRowid))!;
    // The only time the full key leaves the server (besides rotate).
    return jsonResponse({ ...toJson(row), key }, 201);
  }

  // POST /api/client-profiles/:id/rotate
  if (segments.length === 4 && segments[3] === 'rotate' && req.method === 'POST') {
    if (!Number.isInteger(id) || (id as number) <= 0) return invalidId();
    const existing = getProfile(id as number);
    if (!existing) return notFound();

    const key = mintClientProfileKey();
    const { encrypted, iv, authTag } = encrypt(key);
    getDb().prepare(`
      UPDATE client_profiles
      SET token_hash = ?, encrypted_key = ?, iv = ?, auth_tag = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(hashClientProfileKey(key), encrypted, iv, authTag, id);
    return jsonResponse({ ...toJson(getProfile(id as number)!), key });
  }

  // PATCH /api/client-profiles/:id
  if (segments.length === 3 && req.method === 'PATCH') {
    if (!Number.isInteger(id) || (id as number) <= 0) return invalidId();
    let body: unknown;
    try { body = await req.json(); } catch { body = undefined; }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: { message: 'Invalid profile update' } }, 400);
    }
    const row = getProfile(id as number);
    if (!row) return notFound();

    const { name, systemPrompt, enabled } = parsed.data;
    const nextPrompt = systemPrompt === undefined
      ? row.system_prompt
      : (systemPrompt?.trim() || null);
    getDb().prepare(`
      UPDATE client_profiles
      SET name = ?, system_prompt = ?, enabled = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? row.name,
      nextPrompt,
      enabled === undefined ? row.enabled : (enabled ? 1 : 0),
      id,
    );
    return jsonResponse(toJson(getProfile(id as number)!));
  }

  // DELETE /api/client-profiles/:id
  if (segments.length === 3 && req.method === 'DELETE') {
    if (!Number.isInteger(id) || (id as number) <= 0) return invalidId();
    const info = getDb().prepare('DELETE FROM client_profiles WHERE id = ?').run(id);
    if (info.changes === 0) return notFound();
    return jsonResponse({ success: true });
  }

  return new Response('Not Found', { status: 404 });
}
