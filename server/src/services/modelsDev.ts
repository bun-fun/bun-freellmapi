const MODELS_DEV_URL = 'https://raw.githubusercontent.com/anomalyco/models.dev/dev/models.json';

export interface ModelsDevModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string; [k: string]: string | null | undefined };
  top_provider?: { max_completion_tokens?: number | null; context_length?: number };
}

export async function fetchModelsDev(): Promise<ModelsDevModel[]> {
  const res = await fetch(MODELS_DEV_URL);
  if (!res.ok) throw new Error(`Failed to fetch models.dev: ${res.status}`);
  const data = (await res.json()) as { data: ModelsDevModel[] };
  return data.data;
}

export function filterFreeModels(models: ModelsDevModel[]): ModelsDevModel[] {
  return models.filter(
    (m) => m.pricing?.prompt === '0' && m.pricing?.completion === '0'
  );
}

const NATIVE_PROVIDERS = new Set([
  'google',
  'groq',
  'cerebras',
  'sambanova',
  'nvidia',
  'mistral',
  'github',
  'cohere',
  'cloudflare',
  'zhipu',
]);

export function mapToFreellmapi(model: ModelsDevModel): {
  platform: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
} {
  const id = model.id;
  const slashIdx = id.indexOf('/');
  const provider = slashIdx > 0 ? id.slice(0, slashIdx) : id;
  const localModelId = slashIdx > 0 ? id.slice(slashIdx + 1) : id;

  // Anything with :free suffix or unknown provider routes through OpenRouter
  if (id.includes(':free') || !NATIVE_PROVIDERS.has(provider)) {
    return {
      platform: 'openrouter',
      modelId: id,
      displayName: model.name,
      contextWindow: model.context_length ?? 0,
    };
  }

  return {
    platform: provider,
    modelId: localModelId,
    displayName: model.name,
    contextWindow: model.context_length ?? 0,
  };
}

function extractParamB(name: string): number | null {
  const match = name.match(/(\d+)\s*b\b/i);
  if (match) return parseInt(match[1], 10);
  const tmatch = name.match(/(\d+)\s*t\b/i);
  if (tmatch) return parseInt(tmatch[1], 10) * 1000;
  return null;
}

export function computeRanks(model: ModelsDevModel): {
  intelligence: number;
  speed: number;
} {
  const name = model.name.toLowerCase();
  const params = extractParamB(name);

  let intelligence = 15;
  let speed = 8;

  // Keyword-based intelligence adjustments
  const highIntelligence = [
    'opus', 'o1', 'o3', 'claude-3.5', 'claude-4',
    'gpt-4', 'gemini-pro', 'deepseek-v4', 'deepseek-r1',
    'qwen3-235b', 'qwen3-coder',
  ];
  const lowIntelligence = [
    'flash', 'lite', 'nano', 'mini', 'xs', 'small',
  ];

  if (highIntelligence.some((k) => name.includes(k))) intelligence -= 8;
  if (lowIntelligence.some((k) => name.includes(k))) intelligence += 5;
  if (name.includes('maverick') || name.includes('scout')) intelligence += 2;

  // Param-based adjustments
  if (params !== null) {
    if (params <= 2) {
      intelligence += 8;
      speed = 2;
    } else if (params <= 9) {
      intelligence += 5;
      speed = 3;
    } else if (params <= 32) {
      intelligence += 2;
      speed = 6;
    } else if (params <= 70) {
      intelligence += 0;
      speed = 8;
    } else if (params <= 120) {
      intelligence -= 2;
      speed = 9;
    } else if (params <= 250) {
      intelligence -= 4;
      speed = 10;
    } else if (params <= 500) {
      intelligence -= 5;
      speed = 11;
    } else {
      intelligence -= 6;
      speed = 12;
    }
  }

  // Context length bonus
  if (model.context_length > 500000) intelligence -= 1;

  // Clamp
  intelligence = Math.max(1, Math.min(30, intelligence));
  speed = Math.max(1, Math.min(15, speed));

  return { intelligence, speed };
}

/** Coarse size label derived from the model name, shared by the one-shot seed
 *  and the periodic models.dev refresh so the two never disagree. */
export function guessSizeLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('opus') || n.includes('o1') || n.includes('o3') || n.includes('claude-3.5') || n.includes('claude-4') || n.includes('gpt-4') || n.includes('gemini-pro') || n.includes('deepseek-v4') || n.includes('deepseek-r1')) {
    return 'Frontier';
  }
  if (n.includes('flash') || n.includes('lite') || n.includes('nano') || n.includes('mini') || n.includes('xs') || n.includes('small') || n.includes('8b') || n.includes('1.2b')) {
    return 'Small';
  }
  return 'Large';
}

/** A fully-mapped, ready-to-insert models.dev entry. Every field the DB stores
 *  for these rows is settled here so `seedModelsFromModelsDev` and the periodic
 *  refresh produce byte-identical rows. */
export interface ModelsDevEntry {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  contextWindow: number;
}

/** Map free models.dev models to insert-ready entries. Reused by the empty-DB
 *  seed and the scheduled reconcile (models-dev-sync.ts). */
export function buildModelsDevEntries(freeModels: ModelsDevModel[]): ModelsDevEntry[] {
  return freeModels.map((m) => {
    const mappedModel = mapToFreellmapi(m);
    const ranks = computeRanks(m);
    return {
      ...mappedModel,
      intelligenceRank: ranks.intelligence,
      speedRank: ranks.speed,
      sizeLabel: guessSizeLabel(m.name),
    };
  });
}
