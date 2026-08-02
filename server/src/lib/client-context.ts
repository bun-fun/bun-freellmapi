import { AsyncLocalStorage } from 'async_hooks';
import { classifyClientAgent, type ClientAgent } from './client-classifier.js';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  agent: ClientAgent | null;
}

const storage = new AsyncLocalStorage<ClientContext>();

function clientLoggingEnabled(): boolean {
  return process.env.REQUEST_ANALYTICS_LOG_CLIENT !== 'false';
}

/**
 * Run a callback with a client context derived from the request.
 * Bun-native replacement for the Express clientContextMiddleware.
 */
export function runWithClientContext<T>(req: Request, fn: () => T): T {
  if (!clientLoggingEnabled()) {
    return storage.run({ ip: null, userAgent: null, agent: null }, fn);
  }
  const ua = req.headers.get('user-agent');
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? null;
  return storage.run({
    ip: ip?.replace(/^::ffff:/i, '') ?? null,
    userAgent: ua ? ua.slice(0, 256) : null,
    agent: classifyClientAgent(req),
  }, fn);
}

export function getClientContext(): ClientContext {
  return storage.getStore() ?? { ip: null, userAgent: null, agent: null };
}
