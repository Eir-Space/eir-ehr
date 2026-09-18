export type Actor = {
  id: string;
  tenant: string;
  role: 'clinician' | 'patient' | 'proxy' | 'auditor';
  patientId?: string;
};
export type Entity = {
  id: string;
  tenant: string;
  patientId: string;
  kind: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, any>;
};
export type Evidence = { ref: string; text: string };
export type ProposalOutput = {
  text: string;
  citations: Evidence[];
  model: string;
  mode: 'extractive' | 'model';
};
export interface Store {
  transaction<T>(fn: () => T): T;
  get(tenant: string, id: string): Entity | undefined;
  list(tenant: string, patientId?: string, kind?: string): Entity[];
  insert(actor: Actor, kind: string, patientId: string | null, data: Record<string, any>): Entity;
  revise(
    actor: Actor,
    entity: Entity,
    version: number,
    data: Record<string, any>,
    action: string,
  ): Entity;
  audit(
    actor: Actor,
    action: string,
    patientId?: string,
    entityId?: string,
    outcome?: string,
  ): void;
  history(tenant: string, id: string): Entity[];
  verifyAudit(): { ok: boolean; count: number };
  grant(tenant: string, patientId: string, actorId: string, role: string, expires: string): void;
  getGrant(
    tenant: string,
    patientId: string,
    actorId: string,
  ): { role: string; expires: string } | undefined;
  restrict(tenant: string, patientId: string, blocked: boolean): void;
  isBlocked(tenant: string, patientId: string): boolean;
  saveSession(hash: string, actor: Actor, expires: string): void;
  session(hash: string): { actor: Actor; expires: string } | undefined;
  revokeSession(hash: string): void;
  auditEntries(tenant: string, patientId?: string): Record<string, unknown>[];
  changes(tenant: string, patientId: string, after: number): { cursor: number; record: Entity }[];
}
export interface Country {
  code: string;
  locale: string;
  identifier(input: { type: string; value: string }): {
    type: string;
    value: string;
    system: string;
  };
}
export interface Access {
  check(actor: Actor, patientId: string, write?: boolean): void;
  grant(
    actor: Actor,
    patientId: string,
    target: string,
    role: 'clinician' | 'proxy',
    expires: string,
  ): void;
  block(actor: Actor, patientId: string, blocked: boolean): void;
}
export interface Clinical {
  patients(actor: Actor): Entity[];
  register(actor: Actor, input: unknown): Entity;
  chart(actor: Actor, patientId: string): Entity[];
  create(actor: Actor, patientId: string, kind: string, input: unknown): Entity;
  transition(actor: Actor, id: string, action: string, version: number, input: unknown): Entity;
  history(actor: Actor, id: string): Entity[];
}
export interface AIProvider {
  id: string;
  generate(evidence: Evidence[]): Promise<ProposalOutput>;
}
export interface AIReview {
  propose(actor: Actor, patientId: string, encounterId: string): Promise<Entity>;
  review(
    actor: Actor,
    id: string,
    version: number,
    decision: 'accept' | 'reject',
    text?: string,
  ): Entity;
}
export interface Fhir {
  bundle(actor: Actor, patientId: string): Record<string, any>;
}
export interface Identity {
  authenticate(token: string): Promise<Actor>;
  issue?(actor: Actor): string;
  revoke?(token: string): void;
}
export interface Services {
  terminology: Terminology;
  store: Store;
  country: Country;
  access: Access;
  clinical: Clinical;
  aiProvider: AIProvider;
  aiReview: AIReview;
  fhir: Fhir;
  identity: Identity;
}
export interface Terminology {
  source: {
    system: string;
    version: string;
    url: string;
    sha256: string;
    count: number;
    publisher: string;
  };
  lookup(code: string): import('./icd.ts').DiagnosisTerm | undefined;
  search(
    query: string,
    limit?: number,
  ): { total: number; items: import('./icd.ts').DiagnosisTerm[] };
}
export type ServiceName = keyof Services;
export type Plugin = {
  id: string;
  version: string;
  apiVersion: 1;
  provides: ServiceName[];
  requires: ServiceName[];
  setup(
    ctx: {
      get<K extends ServiceName>(name: K): Services[K];
      provide<K extends ServiceName>(name: K, value: Services[K]): void;
      onDispose(dispose: () => void): void;
    },
    config: Record<string, unknown>,
  ): void | (() => void) | Promise<void | (() => void)>;
};
export class Fault extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new Fault(status, message);
}
