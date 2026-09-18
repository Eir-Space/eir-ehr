import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, '.hosting');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(resolve(root, 'apps/web'), destination, { recursive: true });
await cp(resolve(root, 'node_modules/lucide/dist/umd/lucide.js'), resolve(destination, 'icons.js'));
console.log('Prepared static Hosting assets; no clinical data or session secrets included.');
