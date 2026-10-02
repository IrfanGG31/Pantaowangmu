// Optional startup check (AI_SELFTEST=true): calls each configured model once from the server's own network and
// logs whether it answered. Logs model names, status, latency and short answers only, never keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAiChain, getVisionConfig, getAudioConfig, callChat, readReceipt, stripThinking } from './interpreter.js';
import { transcribeWithChat, transcribeAudio, getSttConfig } from './transcribe.js';

const SAMPLE_RECEIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/fixtures/sample-receipt.jpg');

/** One second of a 440 Hz tone as 16 kHz mono WAV: enough to see whether a model accepts audio at all. */
export function toneWav(seconds = 1, rate = 16000) {
  const samples = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

const short = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);

/** @returns {Promise<Array<{ check: string, model: string, ok: boolean, status?: number, latency_ms?: number, detail: string }>>} */
export async function runAiSelfTest({ logger, fetchImpl = fetch } = {}) {
  const results = [];
  const report = (entry) => {
    results.push(entry);
    (entry.ok ? logger?.info : logger?.warn)?.call(logger, entry, `[AI selftest] ${entry.check}: ${entry.ok ? 'OK' : 'GAGAL'}`);
  };

  const chain = getAiChain();
  if (!chain.length) report({ check: 'chat', model: '-', ok: false, detail: 'tidak dikonfigurasi (AI_* kosong)' });
  for (const [i, config] of chain.entries()) {
    const r = await callChat(config, [
      { role: 'system', content: 'Balas hanya dengan JSON: {"reply":"ok","actions":[]}' },
      { role: 'user', content: 'tes' }
    ], { fetchImpl });
    report({ check: i === 0 ? 'chat utama' : 'chat cadangan', model: config.model, ok: r.ok && Boolean(String(r.content).trim()), status: r.status, latency_ms: r.latencyMs, detail: r.ok ? short(stripThinking(r.content)) : r.error });
  }

  const vision = getVisionConfig();
  if (vision && fs.existsSync(SAMPLE_RECEIPT)) {
    const started = Date.now();
    let warn = '';
    const receipt = await readReceipt(
      { imageBase64: fs.readFileSync(SAMPLE_RECEIPT).toString('base64'), mimeType: 'image/jpeg' },
      { fetchImpl, logger: { warn: (info) => { warn = info?.error || ''; } } }
    );
    report({
      check: 'foto struk', model: vision.model, ok: Boolean(receipt?.ok && receipt.total === 12500), latency_ms: Date.now() - started,
      detail: !receipt ? `gagal dipanggil ${warn}`.trim() : !receipt.ok ? `tidak terbaca (${receipt.reason})` : `total ${receipt.total} (benar: 12500), toko ${receipt.merchant || '-'}`
    });
  }

  if (getAudioConfig()) {
    const r = await transcribeWithChat({ audio: toneWav(), mimeType: 'audio/wav' }, { fetchImpl });
    report({ check: 'audio (input_audio)', model: r.model, ok: r.ok, status: r.status, latency_ms: r.latencyMs, detail: r.ok ? `audio diterima; jawaban: "${short(r.text)}"` : r.error });
  }
  if (getSttConfig()) {
    // Which models this key can use right now (ids only), so the right names can be picked for AI_* variables.
    const stt = getSttConfig();
    try {
      const res = await fetchImpl(`${stt.baseUrl}/models`, { headers: { Authorization: `Bearer ${stt.apiKey}` }, signal: AbortSignal.timeout(15000) });
      const body = await res.json().catch(() => null);
      const ids = Array.isArray(body?.data) ? body.data.map((m) => m.id).sort() : [];
      report({ check: 'daftar model', model: stt.baseUrl, ok: res.ok && ids.length > 0, status: res.status, detail: ids.length ? ids.join(', ') : `HTTP ${res.status}` });
    } catch (err) {
      report({ check: 'daftar model', model: stt.baseUrl, ok: false, detail: err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code || err.message).slice(0, 120) });
    }
    const r = await transcribeAudio({ audio: toneWav(), mimeType: 'audio/wav', filename: 'tone.wav' }, { fetchImpl });
    report({ check: 'whisper', model: r.model, ok: r.ok, status: r.status, latency_ms: r.latencyMs, detail: r.ok ? 'audio diterima' : r.error });
  }
  return results;
}
