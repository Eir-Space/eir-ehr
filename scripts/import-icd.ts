import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { importIcd, icdSource } from '../packages/icd.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const response = process.argv[2]
  ? undefined
  : await fetch(icdSource.url, { signal: AbortSignal.timeout(60000) });
if (response && !response.ok) throw new Error(`Official ICD download failed: ${response.status}`);
const bytes = process.argv[2]
  ? await readFile(process.argv[2])
  : Buffer.from(await response!.arrayBuffer());
const catalogue = importIcd(bytes);
const directory = resolve(root, '.terminology');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'icd-10-se-2026.json.tmp'), JSON.stringify(catalogue));
await rename(
  resolve(directory, 'icd-10-se-2026.json.tmp'),
  resolve(directory, 'icd-10-se-2026.json'),
);
console.log(
  `Imported ${catalogue.entries.length} ICD-10-SE ${icdSource.version} codes from the verified official release.`,
);
