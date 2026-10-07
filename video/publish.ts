// Turns the rendered masters in video/out into small web versions in video/publish: H.264 at 30 fps,
// WebVTT captions and a poster frame. `npm run hosting:prepare` copies the folder to the site as /video/.
//   npm run video:publish
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
const dest = join(here, 'publish');
mkdirSync(dest, { recursive: true });
for (const id of readdirSync(out).filter((d) => /^\d\d-/.test(d))) {
  const master = join(out, id, `${id}.mp4`);
  if (!existsSync(master)) continue;
  const web = join(dest, `${id}.mp4`);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    master,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '27',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    web,
  ]);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    '7',
    '-i',
    web,
    '-frames:v',
    '1',
    '-vf',
    'scale=1280:-1',
    join(dest, `${id}.jpg`),
  ]);
  for (const srt of readdirSync(join(out, id)).filter((f) => f.endsWith('.srt'))) {
    const lang = srt.split('.').at(-2);
    const text = readFileSync(join(out, id, srt), 'utf8').replace(
      /(\d\d:\d\d:\d\d),(\d{3})/g,
      '$1.$2',
    );
    writeFileSync(join(dest, `${id}.${lang}.vtt`), `WEBVTT\n\n${text}`);
  }
  console.log(`Published ${id} (${(readFileSync(web).length / 1e6).toFixed(1)} MB)`);
}
console.log(`Web versions are in ${resolve(dest)}`);
