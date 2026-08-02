export const CLIENT_AGENTS = [
  'claude-code',
  'codex',
  'cline',
  'roo',
  'continue',
  'aider',
  'opencode',
  'goose',
  'qwen-code',
  'kilo-code',
  'crush',
  'cursor',
  'gemini-cli',
  'zed',
  'jetbrains',
  'ollama-client',
  'openai-sdk',
  'anthropic-sdk',
  'unknown',
] as const;

export type ClientAgent = (typeof CLIENT_AGENTS)[number];

function header(req: Request, name: string): string {
  return req.headers.get(name)?.toLowerCase() ?? '';
}

/**
 * Best-effort classifier from stable protocol/header signals first, then UA.
 * Adapted for Bun's native Request (Web API) instead of Express Request.
 */
export function classifyClientAgent(req: Request): ClientAgent {
  const url = new URL(req.url);
  const path = url.pathname.toLowerCase();
  const tokenizedPath = path.replace(/^\/v1\/t\/[^/]+/, '');
  const ua = header(req, 'user-agent');

  if (header(req, 'x-claude-code-session-id')) return 'claude-code';
  if (/claude[- ]?code|\bclaude-cli\b/.test(ua)) return 'claude-code';
  if (/\bcodex\b/.test(ua)) return 'codex';
  if (/qwen[- ]?code|\bqwen-cli\b/.test(ua)) return 'qwen-code';
  if (/gemini[- /]?cli/.test(ua)) return 'gemini-cli';
  if (/kilo[- ]?code|\bkilocode\b/.test(ua)) return 'kilo-code';
  if (/\bcrush(?:\/|\s|$)/.test(ua)) return 'crush';
  if (/opencode/.test(ua)) return 'opencode';
  if (/\bcline\b/.test(ua)) return 'cline';
  if (/\broo[- /]/.test(ua) || /roo code/.test(ua)) return 'roo';
  if (/continue(?:\.dev)?/.test(ua)) return 'continue';
  if (/\baider\b/.test(ua)) return 'aider';
  if (/\bgoose\b/.test(ua)) return 'goose';
  if (/\bcursor\b/.test(ua)) return 'cursor';
  if (/\bzed\b/.test(ua)) return 'zed';
  if (/jetbrains|intellij|pycharm|webstorm/.test(ua)) return 'jetbrains';
  if (/\bollama\b/.test(ua)) return 'ollama-client';
  if (/anthropic|claude-sdk/.test(ua)) return 'anthropic-sdk';
  if (/openai|langchain|litellm/.test(ua)) return 'openai-sdk';

  if (path.startsWith('/v1/responses') || tokenizedPath.startsWith('/responses')) return 'codex';
  if (path.startsWith('/v1beta/')) return 'gemini-cli';
  if (path.startsWith('/v1/messages')) {
    return header(req, 'x-session-id') ? 'claude-code' : 'anthropic-sdk';
  }
  if (tokenizedPath.startsWith('/api/chat')
      || tokenizedPath.startsWith('/api/generate')
      || tokenizedPath.startsWith('/api/tags')) return 'ollama-client';
  return 'unknown';
}
