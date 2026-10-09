import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../packages/runtime.ts';
import { manifestSchema, assertMatches } from '../packages/plugin-manifest.ts';
import type { Plugin } from '../packages/contracts.ts';
import countrySE from '../plugins/country-se.ts';

const order: string[] = [];
const wants = (id: string, optionalRequires: Plugin['optionalRequires']): Plugin => ({
  id,
  version: '1.0.0',
  apiVersion: 2,
  provides: [],
  requires: [],
  optionalRequires,
  contributes: ['aiModel'],
  setup(ctx) {
    order.push(`${id}:${ctx.has('country')}`);
    ctx.contribute('aiModel', id, { id, generate: async () => ({}) as never });
  },
});

test('an optional dependency that the profile provides starts first, even if listed later', async () => {
  order.length = 0;
  const runtime = await new Runtime().start([
    { plugin: wants('test.consumer', ['country']) },
    { plugin: countrySE },
  ]);
  assert.deepEqual(order, ['test.consumer:true']);
  await runtime.stop();
});

test('an absent optional dependency lets the plugin start and report it missing', async () => {
  order.length = 0;
  const runtime = await new Runtime().start([{ plugin: wants('test.consumer', ['country']) }]);
  assert.deepEqual(order, ['test.consumer:false']);
  await runtime.stop();
});

test('only declared dependencies can be queried or read', async () => {
  const sneaky: Plugin = {
    ...wants('test.sneaky', undefined),
    setup: (ctx) => void ctx.has('country'),
  };
  await assert.rejects(new Runtime().start([{ plugin: sneaky }]), /Undeclared dependency/);
});

test('a required dependency is still required, and manifests must declare optional ones', async () => {
  const needs: Plugin = { ...wants('test.needs', undefined), requires: ['country'] };
  await assert.rejects(new Runtime().start([{ plugin: needs }]), /Missing or cyclic/);
  const plugin = wants('test.consumer', ['country']);
  const manifest = manifestSchema.parse({
    id: plugin.id,
    version: plugin.version,
    apiVersion: 2,
    contributes: ['aiModel'],
  });
  assert.throws(() => assertMatches(manifest, plugin), /optionalRequires/);
  assertMatches({ ...manifest, optionalRequires: ['country'] }, plugin);
});
