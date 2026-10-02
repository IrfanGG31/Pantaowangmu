// Voice notes → text with Groq Whisper (OpenAI-compatible /audio/transcriptions).
// Uses GROQ_API_KEY (+ GROQ_BASE_URL, default Groq) so chat can run on another provider; without GROQ_API_KEY it
// falls back to AI_API_KEY / AI_BASE_URL. Built-in FormData/Blob (Node 18+), so no extra dependency.

import { callChat, getAudioConfig, stripThinking } from './interpreter.js';

const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

const TIMEOUT_MS = 15000;

const cleanEnv = (value) => String(value || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');

/** @returns {{ baseUrl: string, apiKey: string, model: string } | null} null when voice notes are not configured */
export function getSttConfig() {
  const groqKey = cleanEnv(process.env.GROQ_API_KEY);
  const apiKey = groqKey || cleanEnv(process.env.AI_API_KEY);
  const baseUrl = (cleanEnv(process.env.GROQ_BASE_URL) || (groqKey ? GROQ_DEFAULT_BASE_URL : cleanEnv(process.env.AI_BASE_URL))).replace(/\/+$/, '');
  const model = cleanEnv(process.env.GROQ_WHISPER_MODEL);
  if (!baseUrl || !apiKey || !model || !/^https?:\/\//.test(baseUrl)) return null;
  return { baseUrl, apiKey, model };
}

/**
 * Transcribes Indonesian speech. Never throws; errors have the API key redacted.
 * @param {{ audio: Buffer, mimeType?: string, filename?: string }} input
 * @returns {Promise<{ ok: boolean, text?: string, status: number, latencyMs: number, model: string, error?: string }>}
 */
export async function transcribeAudio({ audio, mimeType = 'audio/ogg', filename = 'voice.ogg' }, { fetchImpl = fetch, config = getSttConfig() } = {}) {
  if (!config) return { ok: false, status: 0, latencyMs: 0, model: '', error: 'not configured' };
  const redact = (s) => String(s || '').split(config.apiKey).join('<AI_API_KEY>').slice(0, 300);
  const started = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType }), filename);
    form.append('model', config.model);
    form.append('language', 'id');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const res = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const body = await res.json().catch(() => null);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const message = body?.error?.message || body?.message || `HTTP ${res.status}`;
      return { ok: false, status: res.status, latencyMs, model: config.model, error: redact(typeof message === 'string' ? message : JSON.stringify(message)) };
    }
    const text = String(body?.text || '').replace(/\s+/g, ' ').trim();
    return { ok: true, text, status: res.status, latencyMs, model: config.model };
  } catch (err) {
    return {
      ok: false, status: 0, latencyMs: Date.now() - started, model: config.model,
      error: err.name === 'TimeoutError' ? `timeout ${TIMEOUT_MS}ms` : redact(err.cause?.code || err.message)
    };
  }
}

const AUDIO_FORMATS = { ogg: 'ogg', oga: 'ogg', opus: 'ogg', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', mp4: 'm4a', m4a: 'm4a', 'x-m4a': 'm4a', aac: 'aac', flac: 'flac' };

/**
 * Transcribes with a chat model that accepts audio (OpenRouter `input_audio`, e.g. Inkling Small). Never throws.
 * @param {{ audio: Buffer, mimeType?: string }} input
 */
export async function transcribeWithChat({ audio, mimeType = 'audio/ogg' }, { fetchImpl = fetch, config = getAudioConfig() } = {}) {
  if (!config) return { ok: false, status: 0, latencyMs: 0, model: '', error: 'not configured' };
  const format = AUDIO_FORMATS[String(mimeType).split('/')[1]?.split(';')[0]] || 'ogg';
  const messages = [
    { role: 'system', content: 'Kamu mentranskripsi voice note berbahasa Indonesia untuk aplikasi pencatat keuangan. Tulis persis apa yang diucapkan, angka boleh ditulis seperti diucapkan (mis. "95 ribu"). Balas HANYA teks transkripnya tanpa tambahan apa pun. Jika tidak ada ucapan yang jelas, balas kosong.' },
    { role: 'user', content: [{ type: 'input_audio', input_audio: { data: Buffer.from(audio).toString('base64'), format } }] }
  ];
  const result = await callChat(config, messages, { fetchImpl });
  if (!result.ok) return { ok: false, status: result.status, latencyMs: result.latencyMs, model: config.model, error: result.error };
  const text = stripThinking(result.content).replace(/^["'“]|["'”]$/g, '').replace(/\s+/g, ' ').trim();
  return { ok: true, text, status: result.status, latencyMs: result.latencyMs, model: config.model };
}

/**
 * Voice note → text: the audio chat model first (AI_AUDIO_*), then Groq Whisper; the first readable result wins.
 * @returns {Promise<{ ok: boolean, text?: string, status: number, latencyMs: number, model: string, error?: string }[]>} every attempt, last = final
 */
export async function transcribeVoice({ audio, mimeType, filename }, { fetchImpl = fetch } = {}) {
  const attempts = [];
  if (getAudioConfig()) attempts.push(await transcribeWithChat({ audio, mimeType }, { fetchImpl }));
  if (!attempts.at(-1)?.text && getSttConfig()) attempts.push(await transcribeAudio({ audio, mimeType, filename }, { fetchImpl }));
  return attempts;
}

export const voiceAvailable = () => Boolean(getAudioConfig() || getSttConfig());
