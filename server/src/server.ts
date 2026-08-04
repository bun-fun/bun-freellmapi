import { initDb } from './db/index.js';
import { getEncryptionKeyHex } from './lib/crypto.js';
import { startHealthChecker } from './services/health.js';
import { restoreLatestBackup, createBackup, startBackupScheduler } from './services/backup.js';
import { NodeScheduler } from './lib/scheduler.js';
import { apiKeysRoute } from './routes/bun/keys.js';
import { modelsRoute } from './routes/bun/models.js';
import { fallbackRoute } from './routes/bun/fallback.js';
import { analyticsRoute } from './routes/bun/analytics.js';
import { healthRoute } from './routes/bun/health.js';
import { settingsRoute } from './routes/bun/settings.js';
import { proxyRoute } from './routes/bun/proxy.js';
import { responsesRoute } from './routes/bun/responses.js';
import { anthropicRoute, anthropicCountTokensRoute } from './routes/bun/anthropic.js';
import { embeddingsRoute } from './routes/bun/embeddings.js';
import { authRoute } from './routes/bun/auth.js';
import { platformsRoute } from './routes/bun/platforms.js';
import { premiumRoute } from './routes/bun/premium.js';
import { authenticateRequest } from './lib/auth.js';
import { serveStatic } from './lib/static.js';
import { livezRoute, readyzRoute, providersRoute } from './routes/bun/status.js';
import { imagesRoute, speechRoute, transcriptionRoute } from './routes/bun/media-proxy.js';
import { completionsRoute } from './routes/bun/completions.js';
import { openapiRoute, docsRoute } from './routes/bun/docs.js';
import { geminiModelsRoute, geminiModelRoute, geminiGenerateRoute, geminiCountTokensRoute } from './routes/bun/gemini.js';
import {
  ollamaTagsRoute, ollamaVersionRoute, ollamaShowRoute,
  ollamaChatRoute, ollamaGenerateRoute, ollamaEmbedRoute,
  getOllamaEmulationMode,
} from './routes/bun/ollama.js';
import { urlTokenRoute } from './routes/bun/url-tokens.js';
import {
  mediaListRoute, mediaUsageRoute, mediaCustomRoute,
  mediaUpdateRoute, mediaDeleteRoute,
} from './routes/bun/media-dashboard.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const PORT = parseInt(process.env.PORT ?? '3001');
const HOST = process.env.HOST ?? '0.0.0.0';
const __filename = import.meta.url.startsWith('file:') ? fileURLToPath(import.meta.url) : import.meta.url;
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'data', 'freeapi.db');
const WEB_DIR = path.join(__dirname, 'web');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

async function start() {
  const restored = await restoreLatestBackup(DB_PATH);
  await initDb(DB_PATH);
  if (!restored) {
    await createBackup();
  }

  const server = Bun.serve({
  port: PORT,
  hostname: HOST,

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
        }
      });
    }

    // Ollama emulation routes — own their exact /api/* paths with their own
    // auth (open-loopback / key-required). Must come BEFORE the dashboard
    // session gate because real Ollama clients don't use dashboard auth.
    const OLLAMA_API_PATHS = new Set([
      '/api/tags', '/api/version', '/api/show',
      '/api/chat', '/api/generate',
      '/api/embed', '/api/embeddings',
    ]);
    if (OLLAMA_API_PATHS.has(pathname) && getOllamaEmulationMode() !== 'off') {
      let res: Response;
      if (pathname === '/api/tags' && req.method === 'GET') res = ollamaTagsRoute(req);
      else if (pathname === '/api/version' && req.method === 'GET') res = ollamaVersionRoute(req);
      else if (pathname === '/api/show' && req.method === 'POST') res = await ollamaShowRoute(req);
      else if (pathname === '/api/chat' && req.method === 'POST') res = await ollamaChatRoute(req);
      else if (pathname === '/api/generate' && req.method === 'POST') res = await ollamaGenerateRoute(req);
      else if (pathname === '/api/embed' && req.method === 'POST') res = await ollamaEmbedRoute(req, false);
      else if (pathname === '/api/embeddings' && req.method === 'POST') res = await ollamaEmbedRoute(req, true);
      else {
        // Fall through to dashboard route for /api/embeddings if it's a valid session
        if (pathname === '/api/embeddings') {
          const auth = authenticateRequest(req);
          if (!auth.ok) return addCors(req, auth.response);
          const er = await embeddingsRoute(req, url);
          return addCors(req, er);
        }
        res = new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
      }
      return addCors(req, res);
    }

    // Auth routes (no auth required)
    if (pathname.startsWith('/api/auth/')) {
      const res = await authRoute(req, url);
      return addCors(req, res);
    }

    // Require authentication for all /api/* routes (except ping)
    if (pathname.startsWith('/api/') && pathname !== '/api/ping') {
      const auth = authenticateRequest(req);
      if (!auth.ok) return addCors(req, auth.response);
    }

    // API routes
    if (pathname.startsWith('/api/keys')) {
      const res = await apiKeysRoute(req, url);
      return addCors(req, res);
    }

    if (pathname.startsWith('/api/models')) {
      const res = await modelsRoute(req, url);
      return addCors(req, res);
    }

    if (pathname.startsWith('/api/fallback')) {
      const res = await fallbackRoute(req, url);
      return addCors(req, res);
    }

    if (pathname.startsWith('/api/analytics')) {
      const res = await analyticsRoute(req, url);
      return addCors(req, res);
    }

    if (pathname.startsWith('/api/health')) {
      const res = await healthRoute(req, url);
      return addCors(req, res);
    }

    if (pathname.startsWith('/api/settings')) {
      const res = await settingsRoute(req, url);
      return addCors(req, res);
    }

    if (pathname === '/api/platforms') {
      const res = await platformsRoute(req, url);
      return addCors(req, res);
    }

    if (pathname.startsWith('/api/premium')) {
      const res = await premiumRoute(req, url);
      return addCors(req, res);
    }

    // Media dashboard routes
    if (pathname === '/api/media' && req.method === 'GET') {
      return addCors(req, mediaListRoute());
    }
    if (pathname === '/api/media/usage' && req.method === 'GET') {
      return addCors(req, mediaUsageRoute(req));
    }
    if (pathname === '/api/media/custom' && req.method === 'POST') {
      const res = await mediaCustomRoute(req);
      return addCors(req, res);
    }
    if (pathname.startsWith('/api/media/custom/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop()!;
      return addCors(req, mediaDeleteRoute(id));
    }
    if (pathname.startsWith('/api/media/') && req.method === 'PUT') {
      const id = pathname.split('/').pop()!;
      const res = await mediaUpdateRoute(req, id);
      return addCors(req, res);
    }

    // Liveness / readiness probes (unauthenticated)
    if (pathname === '/livez') return addCors(req, livezRoute(req));
    if (pathname === '/readyz') return addCors(req, readyzRoute(req));

    // OpenAI-compatible Responses API (Codex)
    if (pathname === '/v1/responses' && req.method === 'POST') {
      const res = await responsesRoute(req, url);
      return addCors(req, res);
    }

    // Anthropic-compatible Messages API (Claude Code)
    if (pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
      const res = await anthropicCountTokensRoute(req, url);
      return addCors(req, res);
    }

    if (pathname === '/v1/messages' && req.method === 'POST') {
      const res = await anthropicRoute(req, url);
      return addCors(req, res);
    }

    // OpenAI-compatible embeddings
    if (pathname === '/v1/embeddings' && req.method === 'POST') {
      const res = await embeddingsRoute(req, url);
      return addCors(req, res);
    }

    // OpenAI-compatible image generation
    if (pathname === '/v1/images/generations' && req.method === 'POST') {
      const res = await imagesRoute(req);
      return addCors(req, res);
    }

    // OpenAI-compatible text-to-speech
    if (pathname === '/v1/audio/speech' && req.method === 'POST') {
      const res = await speechRoute(req);
      return addCors(req, res);
    }

    // OpenAI-compatible speech-to-text
    if (pathname === '/v1/audio/transcriptions' && req.method === 'POST') {
      const res = await transcriptionRoute(req);
      return addCors(req, res);
    }

    // Legacy OpenAI completions
    if (pathname === '/v1/completions' && req.method === 'POST') {
      const res = await completionsRoute(req);
      return addCors(req, res);
    }

    // Static API docs (no auth)
    if (pathname === '/v1/docs' && req.method === 'GET') return addCors(req, docsRoute());
    if (pathname === '/v1/openapi.json' && req.method === 'GET') return addCors(req, openapiRoute());

    // Per-provider status (unified key auth)
    if (pathname === '/v1/providers' && req.method === 'GET') {
      return addCors(req, providersRoute(req));
    }

    // URL token routes — /v1/t/:token/...
    if (pathname.startsWith('/v1/t/')) {
      const parts = pathname.split('/');
      const token = parts[3] ?? '';
      const restPath = '/' + parts.slice(4).join('/');
      const res = await urlTokenRoute(req, url, token, restPath);
      return addCors(req, res);
    }

    // OpenAI-compatible proxy (models, chat/completions)
    if (pathname.startsWith('/v1')) {
      const res = await proxyRoute(req, url);
      return addCors(req, res);
    }

    // Gemini native API (/v1beta/*)
    if (pathname.startsWith('/v1beta')) {
      let res: Response;
      if (pathname === '/v1beta/models' && req.method === 'GET') {
        res = geminiModelsRoute(req);
      } else if (pathname.startsWith('/v1beta/models/') && req.method === 'GET') {
        const modelId = decodeURIComponent(pathname.slice('/v1beta/models/'.length));
        res = geminiModelRoute(req, modelId);
      } else if (pathname.includes(':generateContent') && req.method === 'POST') {
        const modelMatch = pathname.match(/\/v1beta\/models\/(.+):generateContent$/);
        if (modelMatch) {
          res = await geminiGenerateRoute(req, decodeURIComponent(modelMatch[1]).replace(/^models\//, ''), false);
        } else {
          res = new Response(JSON.stringify({ error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
      } else if (pathname.includes(':streamGenerateContent') && req.method === 'POST') {
        const modelMatch = pathname.match(/\/v1beta\/models\/(.+):streamGenerateContent$/);
        if (modelMatch) {
          res = await geminiGenerateRoute(req, decodeURIComponent(modelMatch[1]).replace(/^models\//, ''), true);
        } else {
          res = new Response(JSON.stringify({ error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
      } else if (pathname.includes(':countTokens') && req.method === 'POST') {
        res = await geminiCountTokensRoute(req);
      } else {
        res = new Response(JSON.stringify({ error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return addCors(req, res);
    }

    // Health check with debug info
    if (pathname === '/api/ping') {
      return addCors(req, pingHandler(req));
    }

    // Static files and SPA fallback
    const staticHandler = serveStatic(WEB_DIR);
    const staticRes = await staticHandler(req);
    if (staticRes) return staticRes;

    return new Response('Not Found', { status: 404 });
  },

  error(error: any) {
    console.error('[Server Error]', error);
    return new Response(JSON.stringify({
      error: { message: error.message, type: 'server_error' }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  },
});

  console.log(`\n  Encryption key: ${getEncryptionKeyHex()}\n`);
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Proxy endpoint: http://${HOST}:${PORT}/v1/chat/completions`);
  const scheduler = new NodeScheduler();
  startHealthChecker(scheduler);
  startBackupScheduler();
}

start().catch(console.error);

function addCors(req: Request, res: Response): Response {
  const origin = req.headers.get('origin');
  const headers = new Headers(res.headers);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  headers.set('Access-Control-Allow-Credentials', 'true');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function pingHandler(req: Request): Response {
  const debugInfo = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    clientInfo: {
      method: req.method,
      url: req.url,
      path: new URL(req.url).pathname,
      query: Object.fromEntries(new URL(req.url).searchParams),
      clientIP: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown',
      userAgent: req.headers.get('user-agent') ?? '',
      clientHost: req.headers.get('host') ?? '',
      referer: req.headers.get('referer') ?? '',
      origin: req.headers.get('origin') ?? '',
    },
    serverInfo: {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      bunVersion: Bun.version,
      pid: process.pid,
    }
  };

  console.log('\n=== CLIENT CONNECTION DEBUG ===');
  console.log(`Timestamp: ${debugInfo.timestamp}`);
  console.log(`Client IP: ${debugInfo.clientInfo.clientIP}`);
  console.log(`User Agent: ${debugInfo.clientInfo.userAgent}`);
  console.log(`Request URL: ${debugInfo.clientInfo.url}`);
  console.log('=== END DEBUG ===\n');

  return new Response(JSON.stringify(debugInfo), {
    headers: { 'Content-Type': 'application/json' }
  });
}
