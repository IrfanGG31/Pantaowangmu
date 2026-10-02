// Voice notes → text with Groq Whisper (OpenAI-compatible /audio/transcriptions), using the AI_* key and base URL.
// Built-in FormData/Blob (Node 18+), so no extra dependency.

const TIMEOUT_MS = 15000;

const cleanEnv = (value) => String(value || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');

/** @returns {{ baseUrl: string, apiKey: string, model: string } | null} null when voice notes are not configured */
export function getSttConfig() {
  const baseUrl = cleanEnv(process.env.AI_BASE_URL).replace(/\/+$/, '');
  const apiKey = cleanEnv(process.env.AI_API_KEY);
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
