import { getDb } from '../../db/index.js';
import { jsonResponse } from '../../lib/json.js';

const LABELS: Record<string, string> = {
  google: 'Google AI Studio',
  groq: 'Groq',
  cerebras: 'Cerebras',
  sambanova: 'SambaNova',
  nvidia: 'NVIDIA NIM',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  github: 'GitHub Models',
  cohere: 'Cohere',
  cloudflare: 'Cloudflare Workers AI',
  zhipu: 'Zhipu AI (Z.ai)',
};

export async function platformsRoute(_req: Request, _url: URL): Promise<Response> {
  const db = getDb();

  const modelPlatforms = db.prepare('SELECT DISTINCT platform FROM models').all() as { platform: string }[];
  const keyPlatforms = db.prepare('SELECT DISTINCT platform FROM api_keys').all() as { platform: string }[];

  const seen = new Set<string>();
  const platforms: { value: string; label: string }[] = [];

  for (const row of [...modelPlatforms, ...keyPlatforms]) {
    if (!seen.has(row.platform)) {
      seen.add(row.platform);
      platforms.push({
        value: row.platform,
        label: LABELS[row.platform] ?? row.platform,
      });
    }
  }

  // Ensure all known platforms are present
  for (const [value, label] of Object.entries(LABELS)) {
    if (!seen.has(value)) {
      platforms.push({ value, label });
    }
  }

  platforms.sort((a, b) => a.value.localeCompare(b.value));
  return jsonResponse(platforms);
}
