// Uploads the bundled operational templates to an openEHR server (idempotent).
//   OPENEHR_ENDPOINT=http://127.0.0.1:8090/ehrbase OPENEHR_ADMIN_USER=... OPENEHR_ADMIN_PASSWORD=... npm run openehr:setup
// Defaults match docker/compose.openehr.yml, whose credentials are disposable and local only.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoint = (process.env.OPENEHR_ENDPOINT ?? 'http://127.0.0.1:8090/ehrbase').replace(
  /\/+$/,
  '',
);
const user = process.env.OPENEHR_ADMIN_USER ?? 'ehrbase-admin';
const password = process.env.OPENEHR_ADMIN_PASSWORD ?? 'EvenMoreSecretPassword';
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../templates/openehr');
const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
let failed = false;
for (const name of (await readdir(dir)).filter((f) => f.endsWith('.opt')).sort()) {
  const response = await fetch(`${endpoint}/rest/openehr/v1/definition/template/adl1.4`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/xml', accept: 'application/xml' },
    body: await readFile(join(dir, name)),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  const outcome =
    response.status === 201
      ? 'uploaded'
      : response.status === 409
        ? 'already present'
        : `FAILED (${response.status})`;
  if (![201, 409].includes(response.status)) failed = true;
  console.log(`${name}: ${outcome}`);
}
process.exit(failed ? 1 : 0);
