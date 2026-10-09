// Builds an explainer video from code: Swedish narration (ElevenLabs, or the local offline Supertonic
// voice) + HTML/SVG scenes rendered frame by frame with Playwright, joined with crossfades by ffmpeg.
// Deterministic: a frame depends only on the narration timeline and the scene files.
//
//   npm run video:prepare                                   once: icons and brand assets
//   npm run video:build -- 01-vad-och-varfor                full quality (1920x1080, 60 fps)
//   npm run video:build -- 01-vad-och-varfor --preview      quick look (1280x720, 30 fps)
//   npm run video:build -- 01-vad-och-varfor --check        also transcribe the audio back and report
//   npm run video:still -- 01-vad-och-varfor titel 3.5      one frame as PNG, to check a scene
//
// Environment: ELEVENLABS_API_KEY (else the local voice is used), VIDEO_TTS, VIDEO_VOICE,
// VIDEO_TTS_PYTHON / VIDEO_STT_PYTHON for the local voice and the speech check (see video/README.md).
import { mixFilter } from './audio-mix.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parse } from 'yaml';
import { z } from 'zod';
import { synthesizeEleven, type Alignment, type Synthesized } from './tts-elevenlabs.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const here = join(root, 'video');

const line = z
  .object({
    text: z.string().min(1),
    say: z.string().min(1).optional(),
    pause: z.number().min(0).max(5).optional(),
  })
  .strict();
const scene = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().optional(),
    html: z.string().regex(/^[\w-]+\.html$/),
    lines: z.array(line).min(1),
  })
  .strict();
const narration = z
  .object({
    id: z.string(),
    title: z.string(),
    language: z.enum(['en', 'sv']).default('en'),
    scenes: z.array(scene).min(1),
  })
  .strict();
const voices = z
  .object({
    elevenlabs: z.object({
      model: z.string(),
      voice: z.string(),
      seed: z.number().int(),
      settings: z.object({
        stability: z.number(),
        similarity_boost: z.number(),
        style: z.number(),
        use_speaker_boost: z.boolean(),
      }),
      voices: z.record(z.string(), z.string()),
    }),
    supertonic: z.object({ voice: z.string() }),
    kokoro: z.object({ voice: z.string(), speed: z.number().default(1) }),
  })
  .strict();

const LEAD = 0.9; // visuals settle before the voice starts
const GAP = 0.5; // between lines
const TAIL = 1.3; // after the last line of a scene
const CROSS = 0.6; // crossfade between scenes: shorter than LEAD and TAIL, so it happens in silence

// ---- speech ----------------------------------------------------------------------------------

const pronounce = (text: string, dict: Record<string, string>) => {
  let out = text;
  for (const k of Object.keys(dict).sort((a, b) => b.length - a.length))
    out = out.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
        'gu',
      ),
      dict[k],
    );
  return out;
};

type Word = { text: string; start: number; end: number };
// Caption words with the time each is spoken. The voice reads a rewritten text (pronunciation), so
// each caption word is mapped to where its rewritten form appears in the spoken text.
type Asr = { speech: { start: number; end: number }; words: Word[] };
function wordTimes(
  caption: string,
  dict: Record<string, string>,
  alignment: Alignment | null,
  seconds: number,
  asr: Asr | null = null,
): { spoken: string; words: Word[] } {
  const tokens = caption.split(/\s+/).filter(Boolean);
  const said = tokens.map((t) => pronounce(t, dict));
  const spoken = said.join(' ');
  // Transcribing the real audio gives true word times. When the recogniser hears the same number of
  // words as the caption has, they pair one to one; otherwise the words are spread over the time the
  // voice is actually speaking, weighted by length.
  if (asr && asr.words.length) {
    if (asr.words.length === tokens.length)
      return {
        spoken,
        words: tokens.map((text, i) => ({
          text,
          start: asr.words[i].start,
          end: asr.words[i].end,
        })),
      };
    const span = Math.max(0.1, asr.speech.end - asr.speech.start);
    const weight = said.map((w) => w.length + 2 + (/[,.;:!?]$/.test(w) ? 3 : 0));
    const sum = weight.reduce((a, b) => a + b, 0);
    let acc = 0;
    return {
      spoken,
      words: tokens.map((text, i) => {
        const start = asr.speech.start + (acc / sum) * span;
        acc += weight[i];
        return { text, start, end: asr.speech.start + (acc / sum) * span };
      }),
    };
  }
  const exact = alignment && alignment.characters.length === spoken.length;
  let at = 0;
  const total = spoken.length || 1;
  const words = tokens.map((text, i) => {
    const from = at,
      to = at + said[i].length - 1;
    at += said[i].length + 1;
    if (exact)
      return {
        text,
        start: alignment!.character_start_times_seconds[from],
        end: alignment!.character_end_times_seconds[to],
      };
    return { text, start: (from / total) * seconds, end: ((to + 1) / total) * seconds };
  });
  return { spoken, words };
}

function localVoice(
  spoken: { id: string; text: string }[],
  engine: string,
  voice: string,
  speed: number,
  dir: string,
  lang: string,
) {
  const python = process.env.VIDEO_TTS_PYTHON;
  const [cmd, args] = python
    ? [python, [join(here, 'tts.py')]]
    : ['uv', ['run', '--with', 'supertonic==1.3.1', 'python', join(here, 'tts.py')]];
  const r = spawnSync(cmd, args, {
    input: JSON.stringify({ engine, voice, speed, lang, out: dir, lines: spoken }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`Local speech synthesis failed:\n${r.stderr.slice(-1200)}`);
  const made = JSON.parse(r.stdout) as {
    lines: { id: string; file: string; seconds: number; rate: number; cached: boolean }[];
  };
  // The mix runs at 44.1 kHz; convert any other rate once and keep the result beside the original.
  for (const l of made.lines) {
    if (l.rate === 44100) continue;
    const converted = l.file.replace(/\.wav$/, '.44k.wav');
    if (!existsSync(converted))
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        l.file,
        '-ar',
        '44100',
        '-ac',
        '1',
        converted,
      ]);
    l.file = converted;
  }
  return made;
}

// True word times from the audio, when a Parakeet environment is available (video/align.py).
function alignLines(files: { id: string; file: string }[]): Map<string, Asr> {
  const py = process.env.VIDEO_ALIGN_PYTHON ?? process.env.VIDEO_TTS_PYTHON;
  const found = new Map<string, Asr>();
  if (!py || flag('no-align')) return found;
  const r = spawnSync(py, [join(here, 'align.py')], {
    input: JSON.stringify({ lines: files }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.log('  Word alignment unavailable; captions use estimated word times.');
    return found;
  }
  for (const l of JSON.parse(r.stdout).lines as (Asr & { id: string })[]) found.set(l.id, l);
  return found;
}

function readWav(path: string): Int16Array {
  const buf = readFileSync(path);
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4),
      size = buf.readUInt32LE(p + 4);
    if (id === 'data')
      return new Int16Array(
        buf.buffer.slice(buf.byteOffset + p + 8, buf.byteOffset + p + 8 + size),
      );
    p += 8 + size + (size % 2);
  }
  throw new Error(`No audio data in ${path}`);
}
function writeWav(path: string, samples: Int16Array, rate: number) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + samples.length * 2, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(
    path,
    Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]),
  );
}
const srtTime = (s: number) => {
  const ms = Math.round(s * 1000),
    p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// ---- main ------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
if (!id)
  throw new Error('Usage: build.ts <video-id> [--preview] [--check] [--still <scene> <seconds>]');
const flag = (n: string) => args.includes(`--${n}`);
const stillAt = args.indexOf('--still');
const n = narration.parse(parse(readFileSync(join(here, 'narration', `${id}.yaml`), 'utf8')));
const config = voices.parse(parse(readFileSync(join(here, 'voices.yaml'), 'utf8')));
const dictionaries = parse(readFileSync(join(here, 'pronunciation.yaml'), 'utf8')) as Record<
  string,
  Record<string, string>
>;
// English: local Kokoro. Swedish: ElevenLabs when a key is set, else the local Supertonic voice.
const provider =
  process.env.VIDEO_TTS ??
  (n.language === 'en' ? 'kokoro' : process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'supertonic');
const dict = dictionaries[`${provider}-${n.language}`] ?? {};
const strings = parse(readFileSync(join(here, 'locales', `${n.language}.yaml`), 'utf8')) as Record<
  string,
  string
>;
const out = join(here, 'out', n.id);
mkdirSync(out, { recursive: true });

const flat = n.scenes.flatMap((s, si) =>
  s.lines.map((l, li) => ({ si, li, id: `s${si}-l${li}`, caption: l.text, say: l.say })),
);
const planned = flat.map((f, k) => {
  const w = f.say
    ? { spoken: f.say }
    : {
        spoken: f.caption
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => pronounce(t, dict))
          .join(' '),
      };
  const next = flat[k + 1],
    prev = flat[k - 1];
  return {
    ...f,
    spoken: w.spoken,
    before: prev && prev.si === f.si ? prev.caption : undefined,
    after: next && next.si === f.si ? next.caption : undefined,
  };
});

let audio: Map<string, { wav: string; seconds: number; alignment: Alignment | null; asr?: Asr }>;
let voiceName: string;
if (provider === 'elevenlabs') {
  const e = config.elevenlabs;
  voiceName = process.env.VIDEO_VOICE ?? e.voice;
  const voiceId = e.voices[voiceName] ?? voiceName;
  console.log(`Narration: ElevenLabs ${e.model}, voice ${voiceName}`);
  const done = await synthesizeEleven(
    planned.map((p) => ({ id: p.id, text: p.spoken, before: p.before, after: p.after })),
    { model: e.model, voiceId, settings: e.settings, seed: e.seed, language: n.language },
    join(out, 'audio'),
  );
  audio = new Map(
    done.map((d: Synthesized) => [
      d.id,
      { wav: d.wav, seconds: d.seconds, alignment: d.alignment },
    ]),
  );
  console.log(
    `  ${done.filter((d) => d.cached).length} cached, ${done.filter((d) => !d.cached).length} new (${done.filter((d) => !d.cached).reduce((s, d) => s + d.chars, 0)} characters)`,
  );
} else {
  const kokoro = provider === 'kokoro';
  voiceName = process.env.VIDEO_VOICE ?? (kokoro ? config.kokoro.voice : config.supertonic.voice);
  console.log(`Narration: local ${kokoro ? 'Kokoro' : 'Supertonic'} voice ${voiceName} (offline)`);
  const done = localVoice(
    planned.map((p) => ({ id: p.id, text: p.spoken })),
    provider,
    voiceName,
    kokoro ? config.kokoro.speed : 1,
    join(out, 'audio'),
    n.language,
  );
  const asr = alignLines(done.lines.map((d) => ({ id: d.id, file: d.file })));
  audio = new Map(
    done.lines.map((d) => [
      d.id,
      { wav: d.file, seconds: d.seconds, alignment: null, asr: asr.get(d.id) },
    ]),
  );
  console.log(
    `  ${done.lines.filter((d) => d.cached).length} cached, ${done.lines.filter((d) => !d.cached).length} new; word times from ${asr.size ? 'the audio (Parakeet)' : 'estimates'}`,
  );
}

// Timeline. Scene durations are whole frames so crossfade offsets are exact.
const fps = flag('preview') ? 30 : 60;
type TLine = {
  id: string;
  text: string;
  spoken: string;
  wav: string;
  seconds: number;
  start: number;
  end: number;
  words: Word[];
};
type TScene = {
  id: string;
  html: string;
  title: string;
  duration: number;
  start: number;
  lines: TLine[];
};
let clock = 0;
const scenes: TScene[] = n.scenes.map((s, si) => {
  let t = LEAD;
  const lines: TLine[] = s.lines.map((l, li) => {
    const a = audio.get(`s${si}-l${li}`)!;
    t += li === 0 ? 0 : GAP + (l.pause ?? 0);
    const p = planned.find((x) => x.id === `s${si}-l${li}`)!;
    const wt = wordTimes(l.text, dict, a.alignment, a.seconds, a.asr ?? null);
    const words = wt.words.map((w) => ({ text: w.text, start: t + w.start, end: t + w.end }));
    const tl = {
      id: p.id,
      text: l.text,
      spoken: p.spoken,
      wav: a.wav,
      seconds: a.seconds,
      start: t,
      end: t + a.seconds,
      words,
    };
    t += a.seconds;
    return tl;
  });
  const duration = Math.ceil((t + TAIL) * fps) / fps;
  const sc = { id: s.id, html: s.html, title: s.title ?? s.id, duration, start: clock, lines };
  clock += duration - CROSS;
  return sc;
});
const total = clock + CROSS;
writeFileSync(
  join(out, 'timing.json'),
  JSON.stringify(
    {
      provider,
      voice: voiceName,
      total,
      scenes: scenes.map((s) => ({ ...s, lines: s.lines.map(({ wav, ...l }) => l) })),
    },
    null,
    2,
  ),
);
console.log(`Timeline: ${scenes.length} scenes, ${total.toFixed(1)} s`);

const rate = 44100;
const track = new Int16Array(Math.ceil(total * rate));
for (const s of scenes)
  for (const l of s.lines) track.set(readWav(l.wav), Math.round((s.start + l.start) * rate));
writeWav(join(out, 'narration.wav'), track, rate);
writeFileSync(
  join(out, `${n.id}.${n.language}.srt`),
  scenes
    .flatMap((s) => s.lines.map((l) => ({ ...l, g: s.start + l.start })))
    .map((l, i) => `${i + 1}\n${srtTime(l.g)} --> ${srtTime(l.g + l.seconds)}\n${l.text}\n`)
    .join('\n'),
);

if (flag('check')) {
  const py = process.env.VIDEO_STT_PYTHON;
  if (!py) console.log('Skipping --check: set VIDEO_STT_PYTHON (see video/README.md).');
  else {
    const r = spawnSync(py, [join(here, 'check-speech.py')], {
      input: JSON.stringify({
        lang: n.language,
        lines: scenes
          .flatMap((s) => s.lines)
          .map((l) => ({ id: l.id, file: l.wav, expected: l.spoken })),
      }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) console.log('Speech check failed:\n' + r.stderr.slice(-800));
    else {
      const report = JSON.parse(r.stdout);
      writeFileSync(join(out, 'speech-check.json'), JSON.stringify(report, null, 2));
      console.log(
        `Speech check: word error rate ${(report.wer * 100).toFixed(1)} % (advisory; lower is clearer)`,
      );
      for (const l of report.lines.filter((x: { wer: number }) => x.wer > 0.15))
        console.log(
          `  ${l.id} (${(l.wer * 100).toFixed(0)} %)\n    said:  ${l.expected}\n    heard: ${l.heard}`,
        );
    }
  }
}

// ---- frames ----------------------------------------------------------------------------------

const scale = flag('preview') ? 2 / 3 : 1;
const sceneUrl = (s: TScene) => `file://${join(here, 'scenes', s.html)}`;
const theme = args.includes('--theme') ? args[args.indexOf('--theme') + 1] : 'light';
if (!['light', 'dark'].includes(theme)) throw new Error('--theme must be light or dark');
const timingFor = (s: TScene, i: number) => ({
  duration: s.duration,
  globalStart: s.start,
  total,
  chapter: `${String(i + 1).padStart(2, '0')} · ${s.title}`,
  lines: s.lines.map((l) => ({ start: l.start, end: l.end, text: l.text, words: l.words })),
});
const browser = await chromium.launch();
async function page() {
  const p = await (
    await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale })
  ).newPage();
  await p.addInitScript(`window.__manual = true; window.__theme = '${theme}';`);
  return p;
}
async function load(p: Awaited<ReturnType<typeof page>>, s: TScene, i: number) {
  await p.goto(sceneUrl(s));
  await p.evaluate(
    ([t, str]) => {
      (window as any).__timing = t;
      (window as any).__strings = str;
      (window as any).__start();
    },
    [timingFor(s, i), strings] as const,
  );
  await p.evaluate(() => (document as any).fonts.ready);
  const missing = (await p.evaluate(() => (window as any).__missingStrings)) as string[];
  if (missing.length)
    throw new Error(
      `Scene ${s.id} uses strings missing from locales/${n.language}.yaml: ${missing.join(', ')}`,
    );
}

if (stillAt >= 0) {
  const i = scenes.findIndex((x) => x.id === args[stillAt + 1]);
  if (i < 0)
    throw new Error(
      `Unknown scene ${args[stillAt + 1]}. Scenes: ${scenes.map((x) => x.id).join(', ')}`,
    );
  const at = parseFloat(args[stillAt + 2] ?? '0');
  const p = await page();
  await load(p, scenes[i], i);
  await p.evaluate((t) => (window as any).__setTime(t), at);
  const file = join(out, `still-${scenes[i].id}-${at}${theme === 'dark' ? '-dark' : ''}.png`);
  await p.screenshot({ path: file });
  await browser.close();
  console.log(`Wrote ${file} (scene lasts ${scenes[i].duration.toFixed(1)} s)`);
  process.exit(0);
}

const workers = Math.max(1, Math.min(6, Math.floor(cpus().length / 2)));
const pages = await Promise.all(Array.from({ length: workers }, page));
const clips: string[] = [];
const framesDir = join(out, 'frames');
let frameTotal = 0;
for (const [i, s] of scenes.entries()) {
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const frames = Math.round(s.duration * fps);
  await Promise.all(
    pages.map(async (p, w) => {
      await load(p, s, i);
      for (let f = w; f < frames; f += workers) {
        await p.evaluate((t) => (window as any).__setTime(t), f / fps);
        await p.screenshot({
          path: join(framesDir, `${String(f).padStart(6, '0')}.jpg`),
          type: 'jpeg',
          quality: 93,
        });
      }
    }),
  );
  frameTotal += frames;
  const clip = join(out, `clip-${String(i).padStart(2, '0')}.mp4`);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(fps),
    '-i',
    join(framesDir, '%06d.jpg'),
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '12',
    '-pix_fmt',
    'yuv420p',
    clip,
  ]);
  clips.push(clip);
  console.log(`  scene ${i + 1}/${scenes.length} ${s.id}: ${frames} frames (${frameTotal} total)`);
}
rmSync(framesDir, { recursive: true, force: true });
await browser.close();

// Join the clips with crossfades and put the narration on top.
const inputs = clips.flatMap((c) => ['-i', c]);
let chain = '';
let acc = scenes[0].duration;
for (let k = 1; k < scenes.length; k++) {
  const inLabel = k === 1 ? '[0:v]' : `[v${k - 1}]`;
  chain += `${inLabel}[${k}:v]xfade=transition=fade:duration=${CROSS}:offset=${(acc - CROSS).toFixed(4)}[v${k}];`;
  acc += scenes[k].duration - CROSS;
}
const last = scenes.length === 1 ? '0:v' : `v${scenes.length - 1}`;
// Quiet generated ambient pad under the narration, ducked while someone speaks. --no-music turns it off.
let music: string | null = null;
if (!args.includes('--no-music')) {
  music = join(out, 'music.wav');
  execFileSync(
    process.env.VIDEO_TTS_PYTHON ?? 'python3',
    [join(here, 'music.py'), total.toFixed(2), music],
    { stdio: 'inherit' },
  );
}
const mp4 = join(out, theme === 'light' ? `${n.id}.mp4` : `${n.id}.dark.mp4`);
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    ...inputs,
    '-i',
    join(out, 'narration.wav'),
    ...(music ? ['-i', music] : []),
    '-filter_complex',
    music
      ? chain + mixFilter(clips.length, clips.length + 1, total)
      : `${chain}[${clips.length}:a]loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.4,afade=t=out:st=${(total - 1).toFixed(2)}:d=1[a]`,
    '-map',
    scenes.length === 1 ? '0:v' : `[${last}]`,
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '16',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    mp4,
  ],
  { stdio: 'inherit' },
);
for (const c of clips) rmSync(c);
console.log(
  `Done: ${mp4} (${total.toFixed(0)} s, ${(readFileSync(mp4).length / 1e6).toFixed(1)} MB)\nCaptions: ${join(out, `${n.id}.${n.language}.srt`)}`,
);
