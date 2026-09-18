import { readFile } from 'node:fs/promises';
import { assert, type Plugin, type Terminology } from '../packages/contracts.ts';
import { icdSource, normalize, type Catalogue, type DiagnosisTerm } from '../packages/icd.ts';

let shared: Promise<Terminology> | undefined;
async function load(): Promise<Terminology> {
  const catalogue: Catalogue = JSON.parse(
    await readFile(new URL('../.terminology/icd-10-se-2026.json', import.meta.url), 'utf8').catch(
      () => {
        throw new Error('Install the official diagnosis catalogue with npm run terminology:import');
      },
    ),
  );
  if (catalogue.source.sha256 !== icdSource.sha256 || catalogue.entries.length < 38000)
    throw new Error('Unexpected diagnosis catalogue; reimport the verified release');
  const indexed = catalogue.entries.map(({ terms, ...term }) => ({
    term: Object.freeze(term),
    name: normalize(term.display),
    text: normalize([term.display, ...terms].join(' ')),
    compact: term.code.replace('.', '').toLowerCase(),
  }));
  const byCode = new Map(indexed.map((entry) => [entry.compact, entry.term]));
  const favorites = ['I10.9', 'E11.9', 'J45.9', 'M54.5', 'J30.1', 'K21.9'];
  return Object.freeze({
    source: Object.freeze({
      ...icdSource,
      count: indexed.length,
      publisher: 'E-hälsomyndigheten / Socialstyrelsen',
    }),
    lookup(code: string) {
      return byCode.get(normalize(code).replace('.', ''));
    },
    search(query: string, limit = 20) {
      const q = normalize(query);
      assert(q.length <= 100, 422, 'Search query is too long');
      assert(Number.isInteger(limit) && limit > 0 && limit <= 50, 422, 'Invalid result limit');
      if (!q)
        return {
          total: favorites.length,
          items: favorites
            .slice(0, limit)
            .map((code) => byCode.get(code.replace('.', '').toLowerCase())!),
        };
      const words = q.split(/\s+/),
        compact = q.replace('.', '');
      const hits: { term: DiagnosisTerm; rank: number }[] = [];
      for (const entry of indexed) {
        if (q.endsWith('.') && entry.compact === compact) continue;
        const rank =
          entry.compact === compact
            ? 0
            : entry.compact.startsWith(compact)
              ? 1
              : entry.name === q
                ? 2
                : entry.name.startsWith(q)
                  ? 3
                  : words.every((word) => entry.name.includes(word))
                    ? 4
                    : words.every((word) => entry.text.includes(word))
                      ? 5
                      : -1;
        if (rank >= 0) hits.push({ term: entry.term, rank });
      }
      hits.sort((a, b) => a.rank - b.rank || a.term.code.localeCompare(b.term.code, 'sv'));
      return { total: hits.length, items: hits.slice(0, limit).map((hit) => hit.term) };
    },
  });
}
export default {
  id: 'eir.terminology.icd-se',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['terminology'],
  requires: [],
  async setup(ctx) {
    shared ??= load().catch((error) => {
      shared = undefined;
      throw error;
    });
    ctx.provide('terminology', await shared);
  },
} satisfies Plugin;
