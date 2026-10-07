import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  ContributionName,
  Contributions,
  Plugin,
  ServiceName,
  Services,
} from './contracts.ts';
import { checkEvaluations } from './eval-gate.ts';
import { resolveProfile, type Row } from './profile.ts';
import {
  assertMatches,
  checkPolicy,
  readManifest,
  type PluginManifest,
} from './plugin-manifest.ts';

const serviceName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9.]*$/);
const manifest = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  apiVersion: z.literal(2),
  provides: z.array(serviceName),
  requires: z.array(serviceName),
  optionalRequires: z.array(serviceName).optional(),
  contributes: z.array(z.enum(['aiModel', 'contentStore'])).optional(),
});
export class Runtime {
  private services = new Map<ServiceName, unknown>();
  private contributed = new Map<ContributionName, Map<string, unknown>>();
  private disposers: (() => void | Promise<void>)[] = [];
  readonly active: {
    id: string;
    version: string;
    provides: string[];
    requires: string[];
    contributes: string[];
  }[] = [];
  contributions<K extends ContributionName>(name: K): ReadonlyMap<string, Contributions[K]> {
    let map = this.contributed.get(name);
    if (!map) this.contributed.set(name, (map = new Map()));
    return map as Map<string, Contributions[K]>;
  }
  has(name: ServiceName) {
    return this.services.has(name);
  }
  get<K extends ServiceName>(name: K): Services[K] {
    if (!this.services.has(name)) throw new Error(`Missing service: ${name}`);
    return this.services.get(name) as Services[K];
  }
  async start(entries: { plugin: Plugin; config?: Record<string, unknown> }[]) {
    if (this.active.length) throw new Error('Runtime already started');
    const providers = new Map<string, string>();
    const ids = new Set<string>();
    for (const { plugin } of entries) {
      manifest.parse(plugin);
      if (!plugin.provides.length && !plugin.contributes?.length)
        throw new Error(`Plugin ${plugin.id} provides or contributes nothing`);
      if (ids.has(plugin.id)) throw new Error(`Duplicate plugin: ${plugin.id}`);
      ids.add(plugin.id);
      for (const name of plugin.provides) {
        if (providers.has(name)) throw new Error(`Duplicate provider: ${name}`);
        providers.set(name, plugin.id);
      }
    }
    const pending = [...entries];
    try {
      while (pending.length) {
        const index = pending.findIndex(
          ({ plugin }) =>
            plugin.requires.every((name) => this.services.has(name)) &&
            // An optional dependency that some plugin provides must be started first.
            (plugin.optionalRequires ?? []).every(
              (name) => !providers.has(name) || this.services.has(name),
            ),
        );
        if (index < 0) throw new Error('Missing or cyclic plugin dependencies');
        const { plugin, config = {} } = pending.splice(index, 1)[0];
        const supplied = new Set<string>();
        const dispose = await plugin.setup(
          {
            onDispose: (dispose) => this.disposers.push(dispose),
            get: <K extends ServiceName>(name: K) => {
              if (!plugin.requires.includes(name) && !plugin.optionalRequires?.includes(name))
                throw new Error(`Undeclared dependency: ${name}`);
              return this.get(name);
            },
            has: (name) => {
              if (!plugin.requires.includes(name) && !plugin.optionalRequires?.includes(name))
                throw new Error(`Undeclared dependency: ${name}`);
              return this.services.has(name);
            },
            contribute: (name, key, value) => {
              const map = this.contributions(name) as Map<string, unknown>;
              if (!plugin.contributes?.includes(name) || !key || map.has(key))
                throw new Error(`Invalid contribution: ${name}/${key}`);
              map.set(key, value);
              this.disposers.push(() => void map.delete(key));
            },
            contributions: (name) => this.contributions(name),
            provide: (name, service) => {
              if (!plugin.provides.includes(name) || supplied.has(name))
                throw new Error(`Invalid service registration: ${name}`);
              supplied.add(name);
              this.services.set(name, service);
            },
          },
          config,
        );
        if (dispose) this.disposers.push(dispose);
        if (supplied.size !== plugin.provides.length)
          throw new Error(`Incomplete plugin: ${plugin.id}`);
        this.active.push({
          id: plugin.id,
          version: plugin.version,
          provides: plugin.provides,
          requires: plugin.requires,
          contributes: plugin.contributes ?? [],
        });
      }
      return this;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop() {
    const errors: unknown[] = [];
    for (const dispose of this.disposers.reverse()) {
      try {
        await dispose();
      } catch (e) {
        errors.push(e);
      }
    }
    this.disposers = [];
    this.services.clear();
    this.contributed.clear();
    this.active.length = 0;
    if (errors.length) throw new AggregateError(errors, 'Plugin teardown failed');
  }
}
// Loads a profile (JSON or layered YAML), validates sidecar manifests and policy, then starts
// the runtime. Overrides are keyed by plugin id and win over profile config.
export async function loadProfile(path: string) {
  const config = await resolveProfile(path);
  const loaded: { row: Row; plugin: Plugin; manifest?: PluginManifest }[] = [];
  for (const row of config.rows.filter((r) => r.enabled)) {
    const plugin: Plugin = (await import(pathToFileURL(row.module).href)).default;
    const sidecar = row.module.replace(/\.[^./\\]+$/, '') + '.plugin.yaml';
    const manifest = await readManifest(sidecar).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (manifest) assertMatches(manifest, plugin);
    loaded.push({ row, plugin, manifest });
  }
  const violations = checkPolicy(
    config.policy,
    loaded.map(({ plugin, manifest }) => ({ id: plugin.id, manifest })),
  );
  violations.push(
    ...(await checkEvaluations({
      policy: config.policy,
      evaluations: config.evaluations,
      rows: loaded.map(({ row, plugin, manifest }) => ({
        id: row.id,
        pluginId: plugin.id,
        config: row.config,
        manifest,
      })),
    })),
  );
  if (violations.length) throw new Error(`Profile policy violations: ${violations.join('; ')}`);
  return { config: { ...config, plugins: config.rows }, loaded };
}
export async function fromConfig(
  path: string,
  overrides: Record<string, Record<string, unknown>> = {},
) {
  const { config, loaded } = await loadProfile(path);
  const entries = loaded.map(({ row, plugin }) => ({
    plugin,
    config: { ...row.config, ...overrides[plugin.id] },
  }));
  return { runtime: await new Runtime().start(entries), config };
}
