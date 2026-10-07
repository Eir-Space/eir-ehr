// ElevenLabs speech synthesis with word timestamps. One request per narration line, cached by a hash
// of everything that affects the sound (voice, model, settings, text), so an unchanged line is never
// paid for twice. The API key is read from ELEVENLABS_API_KEY and is never written anywhere.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type VoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
};
export type ElevenConfig = {
  model: string;
  voiceId: string;
  settings: VoiceSettings;
  seed: number;
  language: string;
};
export type Spoken = { id: string; text: string; before?: string; after?: string };
export type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};
export type Synthesized = {
  id: string;
  wav: string;
  seconds: number;
  alignment: Alignment | null;
  cached: boolean;
  chars: number;
};

const key = () => {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('ELEVENLABS_API_KEY is not set');
  return k;
};
const cacheKey = (cfg: ElevenConfig, text: string) =>
  createHash('sha256').update(JSON.stringify({ cfg, text })).digest('hex').slice(0, 16);

async function remainingCharacters(): Promise<number> {
  const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': key() },
  });
  if (!r.ok) throw new Error(`ElevenLabs account check failed (${r.status})`);
  const d = (await r.json()) as { character_limit: number; character_count: number };
  return d.character_limit - d.character_count;
}

export async function synthesizeEleven(
  lines: Spoken[],
  cfg: ElevenConfig,
  dir: string,
): Promise<Synthesized[]> {
  mkdirSync(dir, { recursive: true });
  const todo = lines.filter((l) => !existsSync(join(dir, `${l.id}-${cacheKey(cfg, l.text)}.json`)));
  const needed = todo.reduce((n, l) => n + l.text.length, 0);
  if (needed > 0) {
    const left = await remainingCharacters();
    console.log(`  ElevenLabs: ${needed} new characters to synthesize, ${left} left this month.`);
    if (needed > left)
      throw new Error(
        `Not enough ElevenLabs characters (${needed} needed, ${left} left). Nothing was spent.`,
      );
  }
  const out: Synthesized[] = [];
  for (const l of lines) {
    const hash = cacheKey(cfg, l.text);
    const meta = join(dir, `${l.id}-${hash}.json`);
    const mp3 = join(dir, `${l.id}-${hash}.mp3`);
    const wav = join(dir, `${l.id}-${hash}.wav`);
    const cached = existsSync(meta);
    if (!cached) {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}/with-timestamps?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key(), 'content-type': 'application/json' },
          body: JSON.stringify({
            text: l.text,
            model_id: cfg.model,
            language_code: cfg.language,
            voice_settings: cfg.settings,
            seed: cfg.seed,
            // Neighbouring lines give the voice context, so intonation carries across separate requests.
            ...(l.before ? { previous_text: l.before } : {}),
            ...(l.after ? { next_text: l.after } : {}),
          }),
        },
      );
      if (!r.ok) {
        // Only the status and error code: a response body must never carry the key, but keep output small anyway.
        const detail = (await r.json().catch(() => ({}))) as {
          detail?: { code?: string; message?: string };
        };
        throw new Error(`ElevenLabs request failed (${r.status} ${detail.detail?.code ?? ''})`);
      }
      const body = (await r.json()) as { audio_base64: string; alignment: Alignment | null };
      writeFileSync(mp3, Buffer.from(body.audio_base64, 'base64'));
      writeFileSync(meta, JSON.stringify({ alignment: body.alignment, chars: l.text.length }));
    }
    const saved = JSON.parse(readFileSync(meta, 'utf8')) as {
      alignment: Alignment | null;
      chars: number;
    };
    if (!existsSync(wav))
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        mp3,
        '-ar',
        '44100',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wav,
      ]);
    const seconds = Number(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav],
        { encoding: 'utf8' },
      ).trim(),
    );
    out.push({ id: l.id, wav, seconds, alignment: saved.alignment, cached, chars: l.text.length });
  }
  return out;
}
