import { getUnifiedApiKey, regenerateUnifiedKey, getDb } from '../../db/index.js';
import { jsonResponse, errorResponse } from '../../lib/json.js';
import { z } from 'zod';
import {
  isUnifyEnabled,
  setUnifyEnabled,
  getUnifyOverrides,
  setUnifyOverrides,
  unifyOverridesSchema,
} from '../../services/model-groups.js';

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

  // Unify settings — returns { enabled, overrides } and accepts partial updates.
  // The overrides object (merges + splits) is what the frontend reads to show
  // per-provider split/merge controls on the model detail page.
  if (path === '/api/settings/unify') {
    if (req.method === 'GET') {
      return jsonResponse({ enabled: isUnifyEnabled(), overrides: getUnifyOverrides() });
    }
    if (req.method === 'PUT') {
      try {
        const body = await req.json() as { enabled?: boolean; overrides?: unknown };
        if (body.enabled !== undefined) setUnifyEnabled(body.enabled);
        if (body.overrides !== undefined) setUnifyOverrides(body.overrides);
        return jsonResponse({ enabled: isUnifyEnabled(), overrides: getUnifyOverrides() });
      } catch (err: any) {
        return jsonResponse({ error: { message: err.message } }, 400);
      }
    }
  }

  return new Response('Not Found', { status: 404 });
}
