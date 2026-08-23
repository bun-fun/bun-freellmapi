// Express-compatible test harness for the Bun.serve-based server.
//
// The real server (server.ts) boots a full Bun.serve instance with DB init,
// backups, health checks, etc. — overkill for unit tests. Instead, this module
// starts a lightweight Bun.serve that only wires the route handlers the tests
// actually exercise. It exposes the same `.listen(port)` / `.close()` API that
// the Express-based tests expect.

import type { RouteResult } from './services/router.js';
import {
  anthropicRoute, anthropicCountTokensRoute,
  effortFromAnthropicThinking,
} from './routes/bun/anthropic.js';
import { proxyRoute } from './routes/bun/proxy.js';
import { responsesRoute } from './routes/bun/responses.js';
import { completionsRoute } from './routes/bun/completions.js';
import { geminiModelsRoute, geminiModelRoute, geminiGenerateRoute, geminiCountTokensRoute } from './routes/bun/gemini.js';
import {
  ollamaTagsRoute, ollamaVersionRoute, ollamaShowRoute,
  ollamaChatRoute, ollamaGenerateRoute, ollamaEmbedRoute,
  getOllamaEmulationMode,
} from './routes/bun/ollama.js';
import { apiKeysRoute } from './routes/bun/keys.js';
import { modelsRoute } from './routes/bun/models.js';
import { fallbackRoute } from './routes/bun/fallback.js';
import { analyticsRoute } from './routes/bun/analytics.js';
import { healthRoute } from './routes/bun/health.js';
import { settingsRoute } from './routes/bun/settings.js';
import { authRoute } from './routes/bun/auth.js';
import { platformsRoute } from './routes/bun/platforms.js';
import { premiumRoute } from './routes/bun/premium.js';
import { conversationsRoute } from './routes/bun/conversations.js';
import { authenticateRequest } from './lib/auth.js';
import { livezRoute, readyzRoute, providersRoute } from './routes/bun/status.js';
import { imagesRoute, speechRoute, transcriptionRoute } from './routes/bun/media-proxy.js';
import { urlTokenRoute } from './routes/bun/url-tokens.js';
import { mediaListRoute, mediaUsageRoute, mediaCustomRoute, mediaUpdateRoute, mediaDeleteRoute } from './routes/bun/media-dashboard.js';
import { embeddingsListRoute, embeddingsUsageRoute, embeddingsUpdateRoute, embeddingsCustomRoute, embeddingsDeleteRoute } from './routes/bun/embeddings-dashboard.js';
import { openapiRoute, docsRoute } from './routes/bun/docs.js';
import { serveStatic } from './lib/static.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = import.meta.url.startsWith('file:') ? fileURLToPath(import.meta.url) : import.meta.url;
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, '..', 'dist', 'web');

/**
 * Start a minimal test server that delegates to the real route handlers.
 * Returns an Express-like object so existing test code (app.listen(0),
 * server.address(), server.close()) keeps working.
 */
export function createApp(): any {
  return new TestServer();
}

class TestServer {
  private _bunServer: any = null;

  listen(port: number): any {
    const actualPort = port === 0 ? undefined : port;
    this._bunServer = Bun.serve({
      port: actualPort,
      hostname: '127.0.0.1',
      async fetch(req: Request) {
        const url = new URL(req.url);
        const pathname = url.pathname;

        // CORS preflight
        if (req.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': req.headers.get('origin') ?? '*',
              'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
              'Access-Control-Allow-Credentials': 'true',
            },
          });
        }

        // Ollama emulation (skip in tests unless explicitly needed)
        if (getOllamaEmulationMode() !== 'off') {
          const OLLAMA_API_PATHS = new Set(['/api/tags', '/api/version', '/api/show', '/api/chat', '/api/generate', '/api/embed', '/api/embeddings']);
          if (OLLAMA_API_PATHS.has(pathname)) {
            let res: Response;
            if (pathname === '/api/tags' && req.method === 'GET') res = ollamaTagsRoute(req);
            else if (pathname === '/api/version' && req.method === 'GET') res = ollamaVersionRoute(req);
            else if (pathname === '/api/show' && req.method === 'POST') res = await ollamaShowRoute(req);
            else if (pathname === '/api/chat' && req.method === 'POST') res = await ollamaChatRoute(req);
            else if (pathname === '/api/generate' && req.method === 'POST') res = await ollamaGenerateRoute(req);
            else if (pathname === '/api/embed' && req.method === 'POST') res = await ollamaEmbedRoute(req, false);
            else if (pathname === '/api/embeddings' && req.method === 'POST') res = await ollamaEmbedRoute(req, true);
            else res = new Response('Method not allowed', { status: 405 });
            return addCors(req, res);
          }
        }

        // Auth routes
        if (pathname.startsWith('/api/auth/')) {
          return addCors(req, await authRoute(req, url));
        }

        // Require auth for /api/* (except ping)
        if (pathname.startsWith('/api/') && pathname !== '/api/ping') {
          const auth = authenticateRequest(req);
          if (!auth.ok) return addCors(req, auth.response);
        }

        // API routes
        if (pathname.startsWith('/api/keys')) return addCors(req, await apiKeysRoute(req, url));
        if (pathname.startsWith('/api/models')) return addCors(req, await modelsRoute(req, url));
        if (pathname.startsWith('/api/fallback')) return addCors(req, await fallbackRoute(req, url));
        if (pathname.startsWith('/api/analytics')) return addCors(req, await analyticsRoute(req, url));
        if (pathname.startsWith('/api/health')) return addCors(req, await healthRoute(req, url));
        if (pathname.startsWith('/api/settings')) return addCors(req, await settingsRoute(req, url));
        if (pathname === '/api/platforms') return addCors(req, await platformsRoute(req, url));
        if (pathname.startsWith('/api/premium')) return addCors(req, await premiumRoute(req, url));
        if (pathname.startsWith('/api/conversations')) return addCors(req, await conversationsRoute(req, url));

        // Media dashboard
        if (pathname === '/api/media' && req.method === 'GET') return addCors(req, mediaListRoute());
        if (pathname === '/api/media/usage' && req.method === 'GET') return addCors(req, mediaUsageRoute(req));
        if (pathname === '/api/media/custom' && req.method === 'POST') { const r = await mediaCustomRoute(req); return addCors(req, r); }
        if (pathname.startsWith('/api/media/custom/') && req.method === 'DELETE') { const id = pathname.split('/').pop()!; return addCors(req, mediaDeleteRoute(id)); }
        if (pathname.startsWith('/api/media/') && req.method === 'PUT') { const id = pathname.split('/').pop()!; const r = await mediaUpdateRoute(req, id); return addCors(req, r); }

        // Embeddings dashboard
        if (pathname === '/api/embeddings' && req.method === 'GET') return addCors(req, embeddingsListRoute());
        if (pathname === '/api/embeddings' && req.method === 'PUT') return addCors(req, await embeddingsUpdateRoute(req));
        if (pathname === '/api/embeddings/usage' && req.method === 'GET') return addCors(req, embeddingsUsageRoute());
        if (pathname === '/api/embeddings/custom' && req.method === 'POST') return addCors(req, await embeddingsCustomRoute(req));
        if (pathname.startsWith('/api/embeddings/custom/') && req.method === 'DELETE') { const id = pathname.split('/').pop()!; return addCors(req, embeddingsDeleteRoute(id)); }

        // Health probes
        if (pathname === '/livez') return addCors(req, livezRoute(req));
        if (pathname === '/readyz') return addCors(req, readyzRoute(req));

        // OpenAI-compatible Responses API
        if (pathname === '/v1/responses' && req.method === 'POST') { const r = await responsesRoute(req, url); return addCors(req, r); }

        // Anthropic-compatible Messages API
        if (pathname === '/v1/messages/count_tokens' && req.method === 'POST') { const r = await anthropicCountTokensRoute(req, url); return addCors(req, r); }
        if (pathname === '/v1/messages' && req.method === 'POST') { const r = await anthropicRoute(req, url); return addCors(req, r); }

        // OpenAI-compatible embeddings
        if (pathname === '/v1/embeddings' && req.method === 'POST') { const r = await import('./routes/bun/embeddings.js').then(m => m.embeddingsRoute(req, url)); return addCors(req, r); }

        // Media proxy
        if (pathname === '/v1/images/generations' && req.method === 'POST') { const r = await imagesRoute(req); return addCors(req, r); }
        if (pathname === '/v1/audio/speech' && req.method === 'POST') { const r = await speechRoute(req); return addCors(req, r); }
        if (pathname === '/v1/audio/transcriptions' && req.method === 'POST') { const r = await transcriptionRoute(req); return addCors(req, r); }

        // Legacy completions
        if (pathname === '/v1/completions' && req.method === 'POST') { const r = await completionsRoute(req); return addCors(req, r); }

        // Docs
        if (pathname === '/v1/docs' && req.method === 'GET') return addCors(req, docsRoute());
        if (pathname === '/v1/openapi.json' && req.method === 'GET') return addCors(req, openapiRoute());
        if (pathname === '/v1/providers' && req.method === 'GET') return addCors(req, providersRoute(req));

        // URL tokens
        if (pathname.startsWith('/v1/t/')) {
          const parts = pathname.split('/');
          const token = parts[3] ?? '';
          const restPath = '/' + parts.slice(4).join('/');
          const r = await urlTokenRoute(req, url, token, restPath);
          return addCors(req, r);
        }

        // OpenAI-compatible proxy (chat/completions, models, etc.)
        if (pathname.startsWith('/v1')) { const r = await proxyRoute(req, url); return addCors(req, r); }

        // Gemini native API
        if (pathname.startsWith('/v1beta')) {
          let res: Response;
          if (pathname === '/v1beta/models' && req.method === 'GET') res = geminiModelsRoute(req);
          else if (pathname.startsWith('/v1beta/models/') && req.method === 'GET') {
            const modelId = decodeURIComponent(pathname.slice('/v1beta/models/'.length));
            res = geminiModelRoute(req, modelId);
          } else if (pathname.includes(':generateContent') && req.method === 'POST') {
            const modelMatch = pathname.match(/\/v1beta\/models\/(.+):generateContent$/);
            res = modelMatch ? await geminiGenerateRoute(req, decodeURIComponent(modelMatch[1]).replace(/^models\//, ''), false) : notFound();
          } else if (pathname.includes(':streamGenerateContent') && req.method === 'POST') {
            const modelMatch = pathname.match(/\/v1beta\/models\/(.+):streamGenerateContent$/);
            res = modelMatch ? await geminiGenerateRoute(req, decodeURIComponent(modelMatch[1]).replace(/^models\//, ''), true) : notFound();
          } else if (pathname.includes(':countTokens') && req.method === 'POST') {
            res = await geminiCountTokensRoute(req);
          } else {
            res = notFound();
          }
          return addCors(req, res);
        }

        // Ping
        if (pathname === '/api/ping') return addCors(req, pingHandler(req));

        // Static files
        const staticHandler = serveStatic(WEB_DIR);
        const staticRes = await staticHandler(req);
        if (staticRes) return staticRes;

        return new Response('Not Found', { status: 404 });
      },
      error(err) {
        console.error('[TestServer Error]', err);
        return new Response(JSON.stringify({ error: { message: (err as Error).message, type: 'server_error' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    return {
      address: () => ({ port: this._bunServer!.port, address: '127.0.0.1' }),
      close: () => this._bunServer!.stop(true),
    };
  }

  // Express middleware no-ops
  use(_path: any, _handler?: any): any { return this; }
  get(_path: string, _handler?: any): any { return this; }
  post(_path: string, _handler?: any): any { return this; }
  put(_path: string, _handler?: any): any { return this; }
  delete(_path: string, _handler?: any): any { return this; }
  all(_path: string, _handler?: any): any { return this; }
}

function addCors(req: Request, res: Response): Response {
  const origin = req.headers.get('origin');
  const headers = new Headers(res.headers);
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  headers.set('Access-Control-Allow-Credentials', 'true');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pingHandler(req: Request): Response {
  return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
