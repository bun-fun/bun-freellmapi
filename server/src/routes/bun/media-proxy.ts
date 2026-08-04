import { z } from 'zod';
import { getUnifiedApiKey } from '../../db/index.js';
import {
  runImageGeneration, runSpeech, runTranscription,
  MediaError, MAX_TRANSCRIPTION_BYTES,
} from '../../services/media.js';
import { safeHeaderValue } from '../../lib/header-value.js';

// OpenAI-compatible media endpoints: image generation, text-to-speech, and
// speech-to-text. Routed through the media catalog (its own table, never the
// chat router). Failover is across providers, never across modalities.

function authenticate(req: Request): boolean {
  const authHeader = req.headers.get('authorization');
  const apiKeyHeader = req.headers.get('x-api-key');
  const clientIP = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
  const isLocal = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1';

  const token = authHeader
    ? authHeader.replace(/^Bearer\s+/i, '')
    : apiKeyHeader ?? '';

  if (token && !isLocal) {
    const unifiedKey = getUnifiedApiKey();
    return token === unifiedKey;
  }
  return true;
}

function authResponse(): Response {
  return new Response(JSON.stringify({
    error: { message: 'Invalid API key', type: 'authentication_error' },
  }), { status: 401, headers: { 'Content-Type': 'application/json' } });
}

function mediaErrorType(status: number): string {
  if (status === 400 || status === 413) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  return 'server_error';
}

const ImageBody = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  n: z.number().int().positive().max(4).optional(),
  size: z.string().optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
});

export async function imagesRoute(req: Request): Promise<Response> {
  if (!authenticate(req)) return authResponse();

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({
      error: { message: 'Invalid JSON', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = ImageBody.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({
      error: { message: 'Invalid request: `prompt` is required', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const result = await runImageGeneration(parsed.data.model, {
      prompt: parsed.data.prompt, n: parsed.data.n, size: parsed.data.size,
    });
    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: result.images,
      model: result.modelId,
      provider: result.platform,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    return new Response(JSON.stringify({
      error: { message: `image generation error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) },
    }), { status: httpStatus, headers: { 'Content-Type': 'application/json' } });
  }
}

const SpeechBody = z.object({
  model: z.string().optional(),
  input: z.string().min(1),
  voice: z.string().optional(),
  response_format: z.string().optional(),
});

export async function speechRoute(req: Request): Promise<Response> {
  if (!authenticate(req)) return authResponse();

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({
      error: { message: 'Invalid JSON', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = SpeechBody.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({
      error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const result = await runSpeech(parsed.data.model, {
      input: parsed.data.input, voice: parsed.data.voice, format: parsed.data.response_format,
    });
    return new Response(result.audio, {
      headers: {
        'Content-Type': result.contentType,
        'X-Provider': safeHeaderValue(result.platform),
      },
    });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    return new Response(JSON.stringify({
      error: { message: `speech error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) },
    }), { status: httpStatus, headers: { 'Content-Type': 'application/json' } });
  }
}

const TRANSCRIPTION_FORMATS = new Set(['json', 'text', 'verbose_json', 'srt', 'vtt']);

export async function transcriptionRoute(req: Request): Promise<Response> {
  if (!authenticate(req)) return authResponse();

  // Parse multipart form data using Bun's formData
  let formData: any;
  try {
    formData = await req.formData();
  } catch {
    return new Response(JSON.stringify({
      error: { message: 'Malformed multipart/form-data upload.', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return new Response(JSON.stringify({
      error: { message: 'Invalid request: `file` is required (multipart/form-data audio upload).', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  if (file.size > MAX_TRANSCRIPTION_BYTES) {
    return new Response(JSON.stringify({
      error: {
        message: `Audio file too large: the maximum upload size is ${MAX_TRANSCRIPTION_BYTES / (1024 * 1024)} MB.`,
        type: 'invalid_request_error', code: 'file_too_large',
      },
    }), { status: 413, headers: { 'Content-Type': 'application/json' } });
  }

  const model = (formData.get('model') as string | null)?.trim() ?? '';
  if (!model) {
    return new Response(JSON.stringify({
      error: { message: "Invalid request: `model` is required (use 'whisper-1' or 'auto' to let the router decide).", type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const rawFormat = (formData.get('response_format') as string | null)?.trim() ?? '';
  const responseFormat = rawFormat || 'json';
  if (!TRANSCRIPTION_FORMATS.has(responseFormat)) {
    return new Response(JSON.stringify({
      error: { message: `Invalid response_format '${responseFormat}'. Supported: json, text, verbose_json, vtt.`, type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  if (responseFormat === 'srt') {
    return new Response(JSON.stringify({
      error: {
        message: "response_format 'srt' is not supported: no configured provider produces srt natively. Use json, text, verbose_json, or vtt.",
        type: 'invalid_request_error', code: 'unsupported_format',
      },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const temperatureRaw = formData.get('temperature');
  let temperature: number | undefined;
  if (temperatureRaw != null && temperatureRaw !== '') {
    temperature = Number(temperatureRaw);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      return new Response(JSON.stringify({
        error: { message: 'Invalid temperature: must be a number between 0 and 1.', type: 'invalid_request_error' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const language = (formData.get('language') as string | null)?.trim() || undefined;
  const prompt = (formData.get('prompt') as string | null) || undefined;

  const audioBuffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await runTranscription(model || 'auto', {
      file: audioBuffer,
      filename: file.name || 'audio',
      mimeType: file.type || 'audio/wav',
      language,
      prompt,
      temperature,
      responseFormat,
    });

    const contentType = responseFormat === 'text' ? 'text/plain'
      : responseFormat === 'vtt' ? 'text/vtt'
      : 'application/json';

    if (responseFormat === 'text') {
      return new Response(result.text, { headers: { 'Content-Type': contentType } });
    }
    if (responseFormat === 'vtt' && result.vtt) {
      return new Response(result.vtt, { headers: { 'Content-Type': contentType } });
    }

    const responseBody: Record<string, unknown> = { text: result.text };
    if (responseFormat === 'verbose_json') {
      if (result.language) responseBody.language = result.language;
      if (result.duration != null) responseBody.duration = result.duration;
      if (result.segments) responseBody.segments = result.segments;
    }
    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': contentType },
    });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    return new Response(JSON.stringify({
      error: { message: `transcription error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) },
    }), { status: httpStatus, headers: { 'Content-Type': 'application/json' } });
  }
}
