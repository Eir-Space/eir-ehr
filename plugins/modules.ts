import { z } from 'zod';
import { assert, type Plugin } from '../packages/contracts.ts';
import type { Modules } from '../packages/modules.ts';

export default {
  id: 'eir.modules',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['modules'],
  requires: ['store', 'access'],
  setup(ctx, config) {
    const store = ctx.get('store'),
      access = ctx.get('access');
    const { definitions } = z
      .object({
        definitions: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z][a-z0-9-]+$/),
                name: z.string().min(1),
                moduleVersion: z.string().min(1),
                canEnable: z.boolean().default(false),
                restriction: z.string().default(''),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .parse(config);
    assert(
      new Set(definitions.map((d) => d.id)).size === definitions.length,
      422,
      'Duplicate module definition',
    );
    assert(store.searchEntities, 503, 'Module settings require bounded entity search');
    const row = async (tenant: string, unitId: string, moduleId: string) =>
      (
        await store.searchEntities!(tenant, 'moduleSetting', {
          equals: { unitId, moduleId },
          limit: 1,
        })
      )[0];
    const service: Modules = {
      definitions,
      async state(tenant, unitId, id) {
        const setting = await row(tenant, unitId, id);
        const definition = definitions.find((d) => d.id === id);
        return {
          enabled: !!definition?.canEnable && !!setting?.data.enabled,
          version: setting?.version ?? 0,
        };
      },
      async list(actor) {
        assert(
          actor.unitId && ['clinician', 'administrator'].includes(actor.role),
          403,
          'Staff assignment required',
        );
        const context = await access.context?.(actor);
        assert(context, 403, 'Active assignment required');
        const items = [];
        for (const definition of definitions)
          items.push({
            ...definition,
            ...(await service.state(actor.tenant, actor.unitId, definition.id)),
          });
        await store.audit(actor, 'modules.read');
        return { items, canManage: context.permissions.includes('modules.manage') };
      },
      async set(actor, id, input) {
        assert(actor.unitId, 403, 'Unit assignment required');
        const data = z
          .object({
            enabled: z.boolean(),
            version: z.number().int().nonnegative(),
            reason: z.string().trim().min(5).max(500),
          })
          .strict()
          .parse(input);
        return store.transaction(async () => {
          await access.permit(actor, 'modules.manage');
          const definition = definitions.find((d) => d.id === id);
          assert(definition, 404, 'Optional module is not installed');
          assert(
            !data.enabled || definition.canEnable,
            409,
            'Module activation is not approved in this deployment',
          );
          const previous = await row(actor.tenant, actor.unitId!, id);
          assert(
            (previous?.version ?? 0) === data.version,
            409,
            'Module setting changed. Reload before saving.',
          );
          const next = {
            unitId: actor.unitId,
            moduleId: id,
            enabled: data.enabled,
            reason: data.reason,
            changedBy: actor.id,
          };
          return previous
            ? store.revise(actor, previous, data.version, next, 'module.activation-changed')
            : store.insert(actor, 'moduleSetting', null, next);
        });
      },
    };
    ctx.provide('modules', service);
  },
} satisfies Plugin;
