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
import { authRoute } from './routes/bun/auth.js';
import { platformsRoute } from './routes/bun/platforms.js';
import { premiumRoute } from './routes/bun/premium.js';
import { authenticateRequest } from './lib/auth.js';
import { serveStatic } from './lib/static.js';
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

    // OpenAI-compatible proxy
    if (pathname.startsWith('/v1')) {
      const res = await proxyRoute(req, url);
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
