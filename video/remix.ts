// Re-mixes the audio of an already rendered video (picture copied untouched), e.g. after changing the music.
//   npx tsx video/remix.ts 01-what-and-why [--dark]
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mixFilter } from './audio-mix.ts';

const here = dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id) throw new Error('usage: remix.ts <video id> [--dark]');
const out = join(here, 'out', id);
const mp4 = join(out, process.argv.includes('--dark') ? `${id}.dark.mp4` : `${id}.mp4`);
const tmp = mp4.replace(/\.mp4$/, '.remix.mp4');
if (!existsSync(mp4)) throw new Error(`no ${mp4}`);
const total = Number(
  execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4],
    { encoding: 'utf8' },
  ).trim(),
);
const music = join(out, 'music.wav');
execFileSync(
  process.env.VIDEO_TTS_PYTHON ?? 'python3',
  [join(here, 'music.py'), total.toFixed(2), music],
  { stdio: 'inherit' },
);
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-i',
    mp4,
    '-i',
    join(out, 'narration.wav'),
    '-i',
    music,
    '-filter_complex',
    mixFilter(1, 2, total),
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    tmp,
  ],
  { stdio: 'inherit' },
);
renameSync(tmp, mp4);
console.log(`Remixed ${mp4}`);
