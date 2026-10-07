// Validates FHIR R4 JSON with the official HL7 validator (run in Docker, so no local Java).
//   npm run fhir:validate -- file.json [more.json] [--ig hl7.fhir.uv.ips#2.0.0] [--profile url]
//                            [--terminology] [--hide-warnings]
// The validator jar is pinned and verified by SHA-256 on first use, then cached in .cache/.
// Terminology validation uses tx.fhir.org only with --terminology (it sends codes, never patient
// data beyond what the file holds, so use synthetic files); the default checks structure,
// profiles, invariants and bindings that need no terminology server.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '7.0.0';
const SHA256 = '0ec7285b0f23999c25979533c6e9105f5f01087889fcc113ac1dfc65560bcc69';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache/fhir-validator');
const jar = join(cache, `validator_cli-${VERSION}.jar`);

export async function ensureValidator() {
  if (existsSync(jar) && sha(jar) === SHA256) return jar;
  await mkdir(cache, { recursive: true });
  const url = `https://github.com/hapifhir/org.hl7.fhir.core/releases/download/${VERSION}/validator_cli.jar`;
  console.error(`Downloading HL7 validator ${VERSION} (about 200 MB, once)...`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Validator download failed (${response.status})`);
  await writeFile(jar, Buffer.from(await response.arrayBuffer()));
  if (sha(jar) !== SHA256) {
    rmSync(jar);
    throw new Error('Validator jar does not match the pinned SHA-256; refusing to run it');
  }
  return jar;
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export type Issue = { severity: string; text: string; expression?: string[] };
export type Result = { file: string; errors: Issue[]; warnings: Issue[]; information: number };

export async function validate(
  files: string[],
  options: { ig?: string[]; profile?: string; terminology?: boolean } = {},
): Promise<Result[]> {
  await ensureValidator();
  const work = mkdtempSync(join(tmpdir(), 'eir-fhir-validate-'));
  const packages = join(root, '.cache/fhir-packages');
  mkdirSync(packages, { recursive: true });
  try {
    const results: Result[] = [];
    for (const [i, file] of files.entries()) {
      const input = `in-${i}.json`;
      copyFileSync(file, join(work, input));
      const args = [
        'run',
        '--rm',
        '-v',
        `${cache}:/validator:ro`,
        '-v',
        `${work}:/work`,
        '-v',
        `${packages}:/root/.fhir`,
        'eclipse-temurin:21-jre',
        'java',
        '-jar',
        `/validator/${basename(jar)}`,
        `/work/${input}`,
        '-version',
        '4.0.1',
        '-tx',
        options.terminology ? 'http://tx.fhir.org' : 'n/a',
        '-output',
        `/work/out-${i}.json`,
        ...(options.ig ?? []).flatMap((ig, n) => {
          // A local file is mounted into the container; anything else is a package id.
          if (!existsSync(ig)) return ['-ig', ig];
          copyFileSync(ig, join(work, `ig-${n}.json`));
          return ['-ig', `/work/ig-${n}.json`];
        }),
        ...(options.profile ? ['-profile', options.profile] : []),
      ];
      try {
        execFileSync('docker', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        // The validator exits non-zero when it finds errors; the outcome file says what.
      }
      const outPath = join(work, `out-${i}.json`);
      if (!existsSync(outPath)) throw new Error(`Validator produced no outcome for ${file}`);
      const outcome = JSON.parse(readFileSync(outPath, 'utf8'));
      const issues: Issue[] = (outcome.issue ?? []).map((x: any) => ({
        severity: x.severity,
        text: x.details?.text ?? x.diagnostics ?? '',
        expression: x.expression,
      }));
      results.push({
        file,
        errors: issues.filter((x) => ['error', 'fatal'].includes(x.severity)),
        warnings: issues.filter((x) => x.severity === 'warning'),
        information: issues.filter((x) => x.severity === 'information').length,
      });
    }
    return results;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const files: string[] = [];
  const ig: string[] = [];
  let profile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ig') ig.push(args[++i]);
    else if (args[i] === '--profile') profile = args[++i];
    else if (!args[i].startsWith('--')) files.push(resolve(args[i]));
  }
  if (!files.length) throw new Error('Pass at least one FHIR JSON file');
  const results = await validate(files, {
    ig,
    profile,
    terminology: args.includes('--terminology'),
  });
  let failed = false;
  for (const r of results) {
    console.log(
      `${r.file}: ${r.errors.length} errors, ${r.warnings.length} warnings, ${r.information} information`,
    );
    for (const e of r.errors) console.log(`  ERROR ${e.expression?.join(', ') ?? ''}: ${e.text}`);
    if (!args.includes('--hide-warnings'))
      for (const w of r.warnings)
        console.log(`  warn  ${w.expression?.join(', ') ?? ''}: ${w.text}`);
    if (r.errors.length) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
