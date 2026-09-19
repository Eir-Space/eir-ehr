export type Actor = {
  id: string;
  tenant: string;
  role: 'clinician' | 'patient' | 'proxy' | 'auditor' | 'administrator';
  patientId?: string;
  assignmentId?: string;
  unitId?: string;
  authentication?: {
    method: 'local' | 'oidc';
    issuer: string;
    subject: string;
    acr?: string;
    authenticatedAt: number;
  };
};
export type Permission =
  | 'chart.read'
  | 'chart.export'
  | 'patient.register'
  | 'record.write'
  | 'note.sign'
  | 'medication.write'
  | 'medication.reconcile'
  | 'lab.order'
  | 'lab.receive'
  | 'lab.review'
  | 'schedule.write'
  | 'task.write'
  | 'ai.use'
  | 'access.manage'
  | 'access.emergency'
  | 'patient.protected'
  | 'workforce.manage'
  | 'audit.review';
export type AuditRow = {
  seq: number;
  at: string;
  actor: string;
  action: string;
  patientId: string | null;
  entityId: string | null;
  outcome: string;
  hash: string;
  unitId?: string;
  assignmentId?: string;
  [key: string]: unknown;
};
export type AuditQuery = {
  before?: number;
  limit: number;
  unitId: string;
  actorId?: string;
  patientId?: string;
  outcome?: string;
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
  session(hash: string): { actor: Actor; expires: string; lastSeen: string } | undefined;
  updateSession(hash: string, actor: Actor): void;
  saveLogin(hash: string, data: Record<string, string>, expires: string): void;
  consumeLogin(hash: string): Record<string, string> | undefined;
  revokeSession(hash: string): void;
  auditEntries(tenant: string, patientId?: string): Record<string, unknown>[];
  auditPage(tenant: string, query: AuditQuery): AuditRow[];
  auditEntry(tenant: string, seq: number): AuditRow | undefined;
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
  permit(actor: Actor, action: Permission, patientId?: string): void;
  context?(
    actor: Actor,
    patientId?: string,
  ): { permissions: Permission[]; unitId: string; name: string };
  eligible?(actor: Actor, targetId: string, patientId: string, action: Permission): boolean;
  members?(actor: Actor): TeamMember[];
  allowed(actor: Actor, patientId: string, write?: boolean): boolean;
  check(actor: Actor, patientId: string, write?: boolean): void;
  grant(
    actor: Actor,
    patientId: string,
    target: string,
    role: 'clinician' | 'proxy',
    expires: string,
    reason?: string,
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
  select?(token: string, assignmentId: string): Promise<Actor>;
  browser?: {
    origin: string;
    begin(): Promise<{ url: string; binding: string }>;
    callback(url: URL, binding: string): Promise<string>;
  };
}
export interface Workforce {
  current(actor: Actor): Entity;
  assignments(actor: Actor): Entity[];
  forIdentity(issuer: string, subject: string): Entity[];
  actor(assignment: Entity, authentication?: Actor['authentication']): Actor;
  staff(actor: Actor): Entity[];
  create(actor: Actor, input: unknown): Entity;
  update(actor: Actor, id: string, version: number, input: unknown): Entity;
  units: { id: string; tenant: string; name: string }[];
}
export interface AccessReview {
  list(
    actor: Actor,
    query: unknown,
  ): {
    entries: (AuditRow & { reviews: Entity[] })[];
    nextBefore: number | null;
    verification: { ok: boolean };
  };
  review(actor: Actor, input: unknown): Entity;
  emergency(actor: Actor, patientId: string, input: unknown): Entity;
  protect(actor: Actor, patientId: string, version: number, input: unknown): Entity;
}
export interface Services {
  workforce: Workforce;
  accessReview: AccessReview;
  medications: Medications;
  laboratories: Laboratories;
  careTeam: CareTeam;
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
export type TeamMember = { id: string; tenant: string; name: string; profession: string };
export interface CareTeam {
  timeZone: string;
  members(actor: Actor): TeamMember[];
  workspace(actor: Actor, day: string): { appointments: Entity[]; tasks: Entity[] };
  book(actor: Actor, patientId: string, input: unknown): Entity;
  appointment(actor: Actor, id: string, action: string, version: number, input: unknown): Entity;
  createTask(actor: Actor, patientId: string, input: unknown): Entity;
  task(actor: Actor, id: string, action: string, version: number, input: unknown): Entity;
  encounterClosed(actor: Actor, encounterId: string): void;
  // Domain services call these inside their own store transaction.
  createLinkedTask(actor: Actor, patientId: string, input: unknown, orderId: string): Entity;
  syncLinkedTask(
    actor: Actor,
    order: Entity,
    event: 'result' | 'review' | 'cancel',
    resolution?: string,
  ): Entity;
}
export interface Medications {
  list(
    actor: Actor,
    patientId: string,
  ): { items: Entity[]; snapshot: string[]; review: Entity | null; current: boolean };
  add(actor: Actor, patientId: string, input: unknown): Entity;
  update(actor: Actor, id: string, version: number, input: unknown): Entity;
  reconcile(actor: Actor, patientId: string, input: unknown): Entity;
}
export interface Laboratories {
  order(actor: Actor, patientId: string, input: unknown): Entity;
  receive(actor: Actor, id: string, version: number, input: unknown): Entity;
  review(actor: Actor, id: string, version: number, input: unknown): Entity;
  cancel(actor: Actor, id: string, version: number, input: unknown): Entity;
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
