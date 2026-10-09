import type { Actor, Entity } from './contracts.ts';
import type { ClinicalModel, ClinicalModelRegistry } from './clinical-models.ts';

export type CanonicalReference = {
  repository: string;
  contentId: string;
  version: number;
  templateId: string;
  templateVersion: string;
  templateSha256: string;
};

export interface ClinicalRepository {
  readonly key: string;
  readonly kinds: readonly string[];
  operationLeaseMs(): number;
  health(): Promise<void>;
  model(kind: string): ClinicalModel | undefined;
  create(
    actor: Actor,
    kind: string,
    patientId: string,
    data: Record<string, any>,
    operationId: string,
  ): Promise<Entity>;
  get(tenant: string, id: string): Promise<Entity | undefined>;
  list(tenant: string, patientId: string, kind?: string): Promise<Entity[]>;
  revise(actor: Actor, entity: Entity, data: Record<string, any>, action: string): Promise<Entity>;
  history(tenant: string, id: string): Promise<Entity[]>;
}

export const canonicalReference = (
  repository: ClinicalRepository,
  models: ClinicalModelRegistry,
  entity: Entity,
): CanonicalReference => {
  const model = models.model(entity.kind);
  if (!model) throw new Error(`Missing clinical model for ${entity.kind}`);
  return {
    repository: repository.key,
    contentId: entity.id,
    version: entity.version,
    templateId: model.templateId,
    templateVersion: model.version,
    templateSha256: model.sha256,
  };
};

export const canonicalOf = (entity: Entity): CanonicalReference | undefined => {
  const value = entity.data._canonical;
  return value && typeof value === 'object' ? (value as CanonicalReference) : undefined;
};
