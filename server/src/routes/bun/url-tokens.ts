import { validateUrlToken } from '../../services/url-tokens.js';
import { getUnifiedApiKey } from '../../db/index.js';
import { proxyRoute } from './proxy.js';
import { responsesRoute } from './responses.js';
import { ollamaChatRoute, ollamaGenerateRoute, ollamaTagsRoute, ollamaShowRoute, ollamaVersionRoute, ollamaEmbedRoute } from './ollama.js';

// Separately revocable URL tokens for clients that cannot set headers.
// /v1/t/:token/... — validates the token, injects the unified key, then
// dispatches to the normal OpenAI/Ollama routes.

export async function urlTokenRoute(req: Request, url: URL, token: string, restPath: string): Promise<Response> {
  if (!validateUrlToken(token)) {
    return new Response(JSON.stringify({
      error: { message: 'Invalid or revoked URL token', type: 'authentication_error' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // Inject unified key as Bearer token for downstream auth checks
  const authedReq = new Request(req.url, {
    method: req.method,
    headers: {
      ...Object.fromEntries(req.headers.entries()),
      'authorization': `Bearer ${getUnifiedApiKey()}`,
      'x-url-token-authenticated': 'true',
    },
    body: req.body,
  });

  // Dispatch to the appropriate route based on the rest path
  const pathname = restPath;

  // Ollama emulation paths
  if (pathname === '/api/tags' && req.method === 'GET') return ollamaTagsRoute(authedReq);
  if (pathname === '/api/version' && req.method === 'GET') return ollamaVersionRoute(authedReq);
  if (pathname === '/api/show' && req.method === 'POST') return ollamaShowRoute(authedReq);
  if (pathname === '/api/chat' && req.method === 'POST') return ollamaChatRoute(authedReq);
  if (pathname === '/api/generate' && req.method === 'POST') return ollamaGenerateRoute(authedReq);
  if (pathname === '/api/embed' && req.method === 'POST') return ollamaEmbedRoute(authedReq, false);
  if (pathname === '/api/embeddings' && req.method === 'POST') return ollamaEmbedRoute(authedReq, true);

  // OpenAI-compatible paths
  if (pathname === '/v1/responses' && req.method === 'POST') return responsesRoute(authedReq, url);
  if (pathname.startsWith('/v1')) {
    const newUrl = new URL(req.url);
    return proxyRoute(authedReq, newUrl);
  }

  return new Response(JSON.stringify({
    error: { message: 'Not found', type: 'not_found' },
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}
