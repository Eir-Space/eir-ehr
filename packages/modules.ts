import type { Actor, Entity } from './contracts.ts';

export type ModuleDefinition = {
  id: string;
  name: string;
  moduleVersion: string;
  canEnable: boolean;
  restriction: string;
};
export interface Modules {
  definitions: ModuleDefinition[];
  state(tenant: string, unitId: string, id: string): Promise<{ enabled: boolean; version: number }>;
  list(actor: Actor): Promise<{
    items: (ModuleDefinition & { enabled: boolean; version: number })[];
    canManage: boolean;
  }>;
  set(actor: Actor, id: string, input: unknown): Promise<Entity>;
}
