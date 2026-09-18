import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';

export const icdSource = {
  system: 'http://hl7.org/fhir/sid/icd-10-se',
  version: '2026-01-01',
  url: 'https://samarbetsyta.ehalsomyndigheten.se/download/attachments/451267009/icd-10-se.tsv?api=v2&modificationDate=1779615619577&version=1',
  sha256: '696c0c02178dabce2c99802898e98cb5c7c4a3af1f78c5cc1c2ad29f5eaabae8',
};
export type DiagnosisTerm = {
  system: string;
  version: string;
  code: string;
  display: string;
  parent: string;
  selectable: boolean;
  notPrincipal: boolean;
  manifestation: boolean;
};
export type Catalogue = {
  source: typeof icdSource;
  entries: (DiagnosisTerm & { terms: string[] })[];
};
export const normalize = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('sv-SE').trim();
export function importIcd(bytes: Buffer): Catalogue {
  if (createHash('sha256').update(bytes).digest('hex') !== icdSource.sha256)
    throw new Error('ICD source checksum changed. Review the official release before importing.');
  // The publisher embeds unescaped quotes inside HTML cells. Keep strict column counts.
  const rows = parse(bytes, {
    columns: true,
    delimiter: '\t',
    bom: true,
    relax_quotes: true,
  }) as Record<string, string>[];
  if (rows.length !== 82489) throw new Error('Unexpected ICD-10-SE release row count');
  const hierarchy = new Map(
    rows
      .filter((row) => row.Titel)
      .map((row) => [
        row.Kod,
        {
          parent: row['Överordnad kod'],
          notPrincipal: false,
          manifestation: false,
        },
      ]),
  );
  for (const row of rows) {
    const node = hierarchy.get(row.Kod);
    if (node) {
      node.notPrincipal ||= Boolean(row['Ej huvuddiagnos']);
      node.manifestation ||= row['Manifestation(*)/Etiologi(†)'].includes('Manifestationskod');
    }
  }
  const entries = new Map<string, Catalogue['entries'][number]>();
  for (const row of rows) {
    if (!/^[A-Z]\d{2}(?:\.[A-Z\d]{1,2})?$/.test(row.Kod)) continue;
    if (row.Titel) {
      if (entries.has(row.Kod)) throw new Error(`Duplicate ICD definition: ${row.Kod}`);
      entries.set(row.Kod, {
        system: icdSource.system,
        version: icdSource.version,
        code: row.Kod,
        display: row.Titel,
        parent: row['Överordnad kod'],
        selectable: true,
        notPrincipal: Boolean(row['Ej huvuddiagnos']),
        manifestation: row['Manifestation(*)/Etiologi(†)'].includes('Manifestationskod'),
        terms: [],
      });
    }
    const entry = entries.get(row.Kod);
    if (!entry) throw new Error(`Missing ICD definition: ${row.Kod}`);
    for (const field of ['Latin', 'Exempel', 'Innefattar'])
      if (row[field]) entry.terms.push(row[field]);
  }
  const parents = new Set([...entries.values()].map((entry) => entry.parent));
  for (const entry of entries.values()) {
    const visited = new Set<string>();
    let code = entry.code;
    while (hierarchy.has(code)) {
      if (visited.has(code)) throw new Error(`Cycle in ICD hierarchy: ${code}`);
      visited.add(code);
      const node = hierarchy.get(code)!;
      entry.notPrincipal ||= node.notPrincipal;
      entry.manifestation ||= node.manifestation;
      code = node.parent;
    }
    entry.selectable = entry.code.length > 3 || !parents.has(entry.code);
    const parent = entries.get(entry.parent);
    if (parent) entry.terms.push(parent.display, ...parent.terms);
  }
  if (entries.size < 38000) throw new Error('ICD catalogue is incomplete');
  return { source: icdSource, entries: [...entries.values()] };
}
