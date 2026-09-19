import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Plugin, ServiceName, Services } from './contracts.ts';

const serviceName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9.]*$/);
const manifest = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  apiVersion: z.literal(2),
  provides: z.array(serviceName).min(1),
  requires: z.array(serviceName),
});
export class Runtime {
  private services = new Map<ServiceName, unknown>();
  private disposers: (() => void | Promise<void>)[] = [];
  readonly active: { id: string; version: string; provides: string[]; requires: string[] }[] = [];
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
        const index = pending.findIndex(({ plugin }) =>
          plugin.requires.every((name) => this.services.has(name)),
        );
        if (index < 0) throw new Error('Missing or cyclic plugin dependencies');
        const { plugin, config = {} } = pending.splice(index, 1)[0];
        const supplied = new Set<string>();
        const dispose = await plugin.setup(
          {
            onDispose: (dispose) => this.disposers.push(dispose),
            get: <K extends ServiceName>(name: K) => {
              if (!plugin.requires.includes(name))
                throw new Error(`Undeclared dependency: ${name}`);
              return this.get(name);
            },
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
    this.active.length = 0;
    if (errors.length) throw new AggregateError(errors, 'Plugin teardown failed');
  }
}
export async function fromConfig(
  path: string,
  overrides: Record<string, Record<string, unknown>> = {},
) {
  const rendererId = z.string().regex(/^[a-z][a-z0-9-]*$/);
  const config = z
    .object({
      profile: z.string(),
      plugins: z.array(
        z.object({ module: z.string(), config: z.record(z.string(), z.unknown()).optional() }),
      ),
      chartRenderers: z.array(rendererId).min(1),
      defaultRenderer: rendererId,
    })
    .parse(JSON.parse(await readFile(path, 'utf8')));
  if (!config.chartRenderers.includes(config.defaultRenderer))
    throw new Error('Default renderer is not enabled');
  const entries = [];
  for (const entry of config.plugins) {
    const plugin: Plugin = (await import(pathToFileURL(resolve(dirname(path), entry.module)).href))
      .default;
    entries.push({ plugin, config: { ...entry.config, ...overrides[plugin.id] } });
  }
  return { runtime: await new Runtime().start(entries), config };
}
