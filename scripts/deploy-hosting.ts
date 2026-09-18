import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = process.argv[2];
assert(project && /^[a-z][a-z0-9-]+$/.test(project), 'Supply an explicit Google Cloud project ID');
const hosting = z
  .object({
    site: z.string().regex(/^[a-z0-9-]+$/),
    public: z.literal('.hosting'),
    ignore: z.array(z.string()),
    predeploy: z.array(z.string()),
    rewrites: z.array(
      z
        .object({
          source: z.string(),
          run: z.object({ serviceId: z.string(), region: z.string() }).strict(),
        })
        .strict(),
    ),
    headers: z.array(
      z
        .object({
          source: z.string(),
          headers: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
        })
        .strict(),
    ),
  })
  .strict()
  .parse(JSON.parse(await readFile(resolve(root, 'firebase.json'), 'utf8')).hosting);
assert.equal(
  process.argv[3],
  hosting.site,
  'Explicitly confirm the Hosting site as the second argument',
);
await import('./prepare-hosting.ts');
const token = execFileSync('gcloud', ['auth', 'print-access-token'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': project };
async function api(path: string, body: unknown, method = 'POST') {
  const response = await fetch(`https://firebasehosting.googleapis.com/v1beta1/${path}`, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`Hosting API ${response.status}: ${result.error?.message ?? 'Request failed'}`);
  return result;
}
const files: Record<string, string> = {};
const content = new Map<string, Buffer>();
async function collect(path = '') {
  for (const entry of await readdir(resolve(root, '.hosting', path), { withFileTypes: true })) {
    assert(
      !entry.isSymbolicLink() && !entry.name.startsWith('.'),
      'Do not publish symlinks or hidden files',
    );
    const relative = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collect(relative);
      continue;
    }
    assert(entry.isFile(), 'Only ordinary static files may be published');
    const compressed = gzipSync(await readFile(resolve(root, '.hosting', relative)));
    const hash = createHash('sha256').update(compressed).digest('hex');
    files[`/${relative}`] = hash;
    content.set(hash, compressed);
  }
}
await collect();
assert(
  Object.keys(files).length > 0 && Object.keys(files).length <= 1000,
  'This deployer supports 1-1000 static files',
);
console.log(`Publishing ${Object.keys(files).length} static files to ${project}/${hosting.site}`);
const version = await api(`sites/${hosting.site}/versions`, {
  config: {
    rewrites: hosting.rewrites.map(({ source, run }) => ({ glob: source, run })),
    headers: hosting.headers.map(({ source, headers }) => ({
      glob: source,
      headers: Object.fromEntries(headers.map(({ key, value }) => [key, value])),
    })),
  },
});
assert(
  new RegExp(`^sites/${hosting.site}/versions/[a-zA-Z0-9_-]+$`).test(version.name),
  'Unexpected version name',
);
const upload = await api(`${version.name}:populateFiles`, { files });
if (upload.uploadRequiredHashes?.length) {
  const url = new URL(upload.uploadUrl);
  assert.equal(url.origin, 'https://upload-firebasehosting.googleapis.com');
  assert.equal(url.pathname, `/upload/${version.name}/files`);
  for (const hash of upload.uploadRequiredHashes as string[]) {
    const compressed = content.get(hash);
    assert(compressed, 'Server requested an unknown content hash');
    const response = await fetch(`${url.href}/${hash}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(compressed),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Static upload failed: ${response.status}`);
  }
}
const finalized = await api(`${version.name}?update_mask=status`, { status: 'FINALIZED' }, 'PATCH');
assert.equal(finalized.status, 'FINALIZED');
const release = await api(
  `sites/${hosting.site}/releases?versionName=${encodeURIComponent(version.name)}`,
  {},
);
console.log(`Released ${release.name}: https://${hosting.site}.web.app`);
