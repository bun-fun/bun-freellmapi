import { getUnifiedApiKey, regenerateUnifiedKey, getDb } from '../../db/index.js';
import { jsonResponse, errorResponse } from '../../lib/json.js';
import { z } from 'zod';

export async function settingsRoute(req: Request, _url: URL): Promise<Response> {
  const path = new URL(req.url).pathname;

  // Unified API key
  if (path === '/api/settings/api-key') {
    if (req.method === 'GET') {
      return jsonResponse({ apiKey: getUnifiedApiKey() });
    }
    if (req.method === 'POST' && path.endsWith('/regenerate')) {
      const newKey = regenerateUnifiedKey();
      return jsonResponse({ apiKey: newKey });
    }
  }

  // Proxy settings
  if (path === '/api/settings/proxy' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'proxy_%'").all() as { key: string; value: string }[];
    const settings: Record<string, any> = {};
    for (const r of rows) settings[r.key] = r.value;
    return jsonResponse(settings);
  }

  // Compression settings
  if (path === '/api/settings/compression') {
    const db = getDb();
    if (req.method === 'GET') {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'compression_config'").get() as { value: string } | undefined;
      return jsonResponse(row?.value ? JSON.parse(row.value) : { enabled: false, engines: [] });
    }
    if (req.method === 'PUT') {
      try {
        const body = await req.json();
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('compression_config', ?)").run(JSON.stringify(body));
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: { message: err.message } }, 400);
      }
    }
  }

  // Fusion settings
  if (path === '/api/settings/fusion') {
    const db = getDb();
    if (req.method === 'GET') {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'fusion_config'").get() as { value: string } | undefined;
      return jsonResponse(row?.value ? JSON.parse(row.value) : { enabled: false, models: [], judgeModel: null });
    }
    if (req.method === 'PUT') {
      try {
        const body = await req.json();
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('fusion_config', ?)").run(JSON.stringify(body));
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: { message: err.message } }, 400);
      }
    }
  }

  // Unify settings
  if (path === '/api/settings/unify') {
    const db = getDb();
    if (req.method === 'GET') {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'unify_enabled'").get() as { value: string } | undefined;
      return jsonResponse({ enabled: row?.value === 'true' });
    }
    if (req.method === 'PUT') {
      try {
        const body = await req.json() as { enabled: boolean };
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('unify_enabled', ?)").run(String(body.enabled));
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ error: { message: err.message } }, 400);
      }
    }
  }

  return new Response('Not Found', { status: 404 });
}
