import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse } from 'yaml';
import type { Plugin } from './contracts.ts';

// Declarative, operator-reviewable description of a plugin. It lives beside the module as
// `<module>.plugin.yaml`. The code remains the source of truth for behavior; the manifest
// states what the plugin needs and what it claims, so a profile can be audited and policy
// can be enforced before any plugin code runs its setup.
const serviceName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9.]*$/);
export const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    apiVersion: z.literal(2),
    title: z.string().min(1).max(120).optional(),
    provides: z.array(serviceName).default([]),
    contributes: z.array(z.enum(['aiModel', 'contentStore'])).default([]),
    requires: z.array(serviceName).default([]),
    optionalRequires: z.array(serviceName).default([]),
    // Network egress the plugin may perform. `loopback` means local model servers only.
    network: z.enum(['none', 'loopback', 'allowlist', 'any']).default('none'),
    egressHosts: z.array(z.string().min(1)).default([]),
    // Classes of data the plugin receives. Policy can deny a class for a plugin.
    dataClasses: z
      .array(z.enum(['none', 'synthetic', 'pseudonymised', 'identified-clinical']))
      .default(['none']),
    // in-process plugins run with application privileges; process isolation is declared here
    // so a profile can refuse in-process execution for third-party code.
    isolation: z.enum(['in-process', 'process', 'wasm']).default('in-process'),
    // Machine-learning plugins state what they are for and point at release evidence.
    // Implementation family an evaluation report names (for example `ollama`). A language-model
    // plugin needs one to be accepted by a profile that requires evaluation.
    evaluationFamily: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    intendedUse: z
      .object({
        purpose: z.string().min(1).max(300),
        notFor: z.array(z.string().min(1)).default([]),
        evidence: z.array(z.string().min(1)).default([]),
        usesLanguageModel: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((m) => m.provides.length + m.contributes.length > 0, 'Provides or contributes nothing');
export type PluginManifest = z.infer<typeof manifestSchema>;

export async function readManifest(path: string): Promise<PluginManifest> {
  return manifestSchema.parse(parse(await readFile(path, 'utf8')));
}

// A manifest must describe the code it sits beside. Drift is a startup error, not a warning.
export function assertMatches(manifest: PluginManifest, plugin: Plugin) {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  if (manifest.id !== plugin.id)
    throw new Error(`Manifest id ${manifest.id} does not match plugin ${plugin.id}`);
  if (manifest.version !== plugin.version)
    throw new Error(`Manifest version for ${plugin.id} does not match the plugin`);
  if (!same(manifest.provides, plugin.provides))
    throw new Error(`Manifest provides for ${plugin.id} does not match the plugin`);
  if (!same(manifest.contributes, plugin.contributes ?? []))
    throw new Error(`Manifest contributes for ${plugin.id} does not match the plugin`);
  if (!same(manifest.optionalRequires, plugin.optionalRequires ?? []))
    throw new Error(`Manifest optionalRequires for ${plugin.id} does not match the plugin`);
  if (!same(manifest.requires, plugin.requires))
    throw new Error(`Manifest requires for ${plugin.id} does not match the plugin`);
}

export const policySchema = z
  .object({
    // Highest egress any plugin may declare.
    maxNetwork: z.enum(['none', 'loopback', 'allowlist', 'any']).default('any'),
    // Data classes no plugin may declare.
    denyDataClasses: z
      .array(z.enum(['none', 'synthetic', 'pseudonymised', 'identified-clinical']))
      .default([]),
    // Plugins that use a language model must carry intendedUse evidence in this profile.
    requireEvidenceForLanguageModels: z.boolean().default(false),
    requireManifest: z.boolean().default(false),
    // Every language-model plugin must have a passing, current evaluation for its exact model.
    requireEvaluation: z
      .object({
        useCase: z.literal('draft-note'),
        maxAgeDays: z.number().int().min(1).max(3650).default(90),
      })
      .strict()
      .optional(),
    allowedIsolation: z
      .array(z.enum(['in-process', 'process', 'wasm']))
      .default(['in-process', 'process', 'wasm']),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;

const rank = { none: 0, loopback: 1, allowlist: 2, any: 3 } as const;

// Returns human-readable violations; the caller decides to fail startup.
export function checkPolicy(
  policy: Policy,
  entries: { id: string; manifest?: PluginManifest }[],
): string[] {
  const out: string[] = [];
  for (const { id, manifest } of entries) {
    if (!manifest) {
      if (policy.requireManifest) out.push(`${id}: no manifest`);
      continue;
    }
    if (rank[manifest.network] > rank[policy.maxNetwork])
      out.push(`${id}: network ${manifest.network} exceeds policy ${policy.maxNetwork}`);
    for (const cls of manifest.dataClasses)
      if (policy.denyDataClasses.includes(cls)) out.push(`${id}: data class ${cls} denied`);
    if (!policy.allowedIsolation.includes(manifest.isolation))
      out.push(`${id}: isolation ${manifest.isolation} not allowed`);
    if (
      policy.requireEvidenceForLanguageModels &&
      manifest.intendedUse?.usesLanguageModel &&
      manifest.intendedUse.evidence.length === 0
    )
      out.push(`${id}: language model plugin has no evidence`);
  }
  return out;
}
