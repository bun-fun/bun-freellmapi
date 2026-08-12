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
import {
  getSavedFusionConfig,
  setSavedFusionConfig,
  getFusionMaxK,
  savedFusionConfigSchema,
} from '../../services/fusion.js';
import { getClaudeModelMap, setClaudeModelMap } from '../../services/anthropic-map.js';

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

  // Fusion settings — GET/PUT return the full { config, maxK } shape the
  // dashboard's Fusion page renders (config.mode/models/judge/k/strategy/
  // expose_panel). PUT dedupes the panel and clamps k to the operator cap via
  // the fusion service, so the stored value always passes savedFusionConfigSchema.
  if (path === '/api/settings/fusion') {
    if (req.method === 'GET') {
      return jsonResponse({ config: getSavedFusionConfig(), maxK: getFusionMaxK() });
    }
    if (req.method === 'PUT') {
      try {
        const body = await req.json();
        // Validate before persisting: an invalid body would otherwise be stored
        // verbatim and become unreadable — getSavedFusionConfig falls back to
        // the default and every dashboard save silently reverts.
        const parsed = savedFusionConfigSchema.safeParse(body);
        if (!parsed.success) {
          return jsonResponse({ error: { message: 'Invalid fusion config: ' + parsed.error.errors.map(e => e.message).join(', ') } }, 400);
        }
        return jsonResponse({ config: setSavedFusionConfig(parsed.data), maxK: getFusionMaxK() });
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

  // Anthropic model map — GET returns the current family→model mapping, PUT
  // accepts a partial patch and persists the merged result.
  if (path === '/api/settings/anthropic-map') {
    if (req.method === 'GET') {
      return jsonResponse({ map: getClaudeModelMap() });
    }
    if (req.method === 'PUT') {
      try {
        const body = await req.json();
        return jsonResponse({ map: setClaudeModelMap(body) });
      } catch (err: any) {
        return jsonResponse({ error: { message: err.message } }, 400);
      }
    }
  }

  return new Response('Not Found', { status: 404 });
}
