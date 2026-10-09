import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, '.hosting');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(resolve(root, 'apps/web'), destination, { recursive: true });
await cp(resolve(root, 'node_modules/lucide/dist/umd/lucide.js'), resolve(destination, 'icons.js'));
// Explainer films: built by `npm run video:publish` into video/publish (not committed, they are large).
const films = resolve(root, 'video/publish');
if (existsSync(films)) await cp(films, resolve(destination, 'video'), { recursive: true });
else
  console.log(
    'No video/publish folder: the film section will show without media. See video/README.md.',
  );
console.log('Prepared static Hosting assets; no clinical data or session secrets included.');
