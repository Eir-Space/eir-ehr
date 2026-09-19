export type Actor = {
  id: string;
  tenant: string;
  role: 'clinician' | 'patient' | 'proxy' | 'auditor' | 'administrator' | 'integration';
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
  | 'coordination.read'
  | 'coordination.write'
  | 'coordination.manage'
  | 'coordination.export'
  | 'coordination.billing'
  | 'coordination.discharge'
  | 'modules.manage'
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
  | 'integration.manage'
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
export type Evidence = {
  ref: string;
  text: string;
};
export type ProposalOutput = {
  text: string;
  citations: Evidence[];
  model: string;
  mode: 'extractive' | 'model';
};
export interface Store {
  close(): Promise<void>;
  health(): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  get(tenant: string, id: string): Promise<Entity | undefined>;
  list(tenant: string, patientId?: string, kind?: string): Promise<Entity[]>;
  // Optional API-2 capability. Queue providers require database-side filtering.
  searchEntities?(
    tenant: string,
    kind: string,
    query: import('./entity-query.ts').EntityQuery,
  ): Promise<Entity[]>;
  insert(
    actor: Actor,
    kind: string,
    patientId: string | null,
    data: Record<string, any>,
  ): Promise<Entity>;
  revise(
    actor: Actor,
    entity: Entity,
    version: number,
    data: Record<string, any>,
    action: string,
  ): Promise<Entity>;
  audit(
    actor: Actor,
    action: string,
    patientId?: string,
    entityId?: string,
    outcome?: string,
  ): Promise<void>;
  history(tenant: string, id: string): Promise<Entity[]>;
  verifyAudit(): Promise<{
    ok: boolean;
    count: number;
  }>;
  grant(
    tenant: string,
    patientId: string,
    actorId: string,
    role: string,
    expires: string,
  ): Promise<void>;
  getGrant(
    tenant: string,
    patientId: string,
    actorId: string,
  ): Promise<
    | {
        role: string;
        expires: string;
      }
    | undefined
  >;
  restrict(tenant: string, patientId: string, blocked: boolean): Promise<void>;
  isBlocked(tenant: string, patientId: string): Promise<boolean>;
  saveSession(hash: string, actor: Actor, expires: string): Promise<void>;
  session(hash: string): Promise<
    | {
        actor: Actor;
        expires: string;
        lastSeen: string;
      }
    | undefined
  >;
  updateSession(hash: string, actor: Actor): Promise<void>;
  saveLogin(hash: string, data: Record<string, string>, expires: string): Promise<void>;
  consumeLogin(hash: string): Promise<Record<string, string> | undefined>;
  revokeSession(hash: string): Promise<void>;
  auditEntries(tenant: string, patientId?: string): Promise<Record<string, unknown>[]>;
  auditPage(tenant: string, query: AuditQuery): Promise<AuditRow[]>;
  auditEntry(tenant: string, seq: number): Promise<AuditRow | undefined>;
  changes(
    tenant: string,
    patientId: string,
    after: number,
  ): Promise<
    {
      cursor: number;
      record: Entity;
    }[]
  >;
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
  permit(actor: Actor, action: Permission, patientId?: string): Promise<void>;
  context?(
    actor: Actor,
    patientId?: string,
  ): Promise<{
    permissions: Permission[];
    unitId: string;
    name: string;
  }>;
  eligible?(
    actor: Actor,
    targetId: string,
    patientId: string,
    action: Permission,
  ): Promise<boolean>;
  members?(actor: Actor): Promise<TeamMember[]>;
  allowed(actor: Actor, patientId: string, write?: boolean): Promise<boolean>;
  check(actor: Actor, patientId: string, write?: boolean): Promise<void>;
  grant(
    actor: Actor,
    patientId: string,
    target: string,
    role: 'clinician' | 'proxy',
    expires: string,
    reason?: string,
  ): Promise<void>;
  block(actor: Actor, patientId: string, blocked: boolean): Promise<void>;
}
export interface Clinical {
  patients(actor: Actor): Promise<Entity[]>;
  register(actor: Actor, input: unknown): Promise<Entity>;
  chart(actor: Actor, patientId: string): Promise<Entity[]>;
  create(actor: Actor, patientId: string, kind: string, input: unknown): Promise<Entity>;
  transition(
    actor: Actor,
    id: string,
    action: string,
    version: number,
    input: unknown,
  ): Promise<Entity>;
  history(actor: Actor, id: string): Promise<Entity[]>;
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
  ): Promise<Entity>;
}
export interface Fhir {
  bundle(actor: Actor, patientId: string): Promise<Record<string, any>>;
}
export interface Identity {
  authenticate(token: string): Promise<Actor>;
  issue?(actor: Actor): Promise<string>;
  revoke?(token: string): Promise<void>;
  select?(token: string, assignmentId: string): Promise<Actor>;
  browser?: {
    origin: string;
    begin(): Promise<{
      url: string;
      binding: string;
    }>;
    callback(url: URL, binding: string): Promise<string>;
  };
}
export interface Workforce {
  current(actor: Actor): Promise<Entity>;
  assignments(actor: Actor): Promise<Entity[]>;
  forIdentity(issuer: string, subject: string): Promise<Entity[]>;
  actor(assignment: Entity, authentication?: Actor['authentication']): Actor;
  staff(actor: Actor): Promise<Entity[]>;
  create(actor: Actor, input: unknown): Promise<Entity>;
  update(actor: Actor, id: string, version: number, input: unknown): Promise<Entity>;
  units: {
    id: string;
    tenant: string;
    name: string;
  }[];
}
export interface AccessReview {
  list(
    actor: Actor,
    query: unknown,
  ): Promise<{
    entries: (AuditRow & {
      reviews: Entity[];
    })[];
    nextBefore: number | null;
    verification: {
      ok: boolean;
    };
  }>;
  review(actor: Actor, input: unknown): Promise<Entity>;
  emergency(actor: Actor, patientId: string, input: unknown): Promise<Entity>;
  protect(actor: Actor, patientId: string, version: number, input: unknown): Promise<Entity>;
}
export interface Services {
  coordinationDirectory: import('./coordination.ts').CoordinationDirectory;
  coordination: import('./coordination.ts').Coordination;
  sipPlans: import('./coordination.ts').SipPlans;
  coordinationPayment: import('./coordination.ts').CoordinationPayment;
  coordinationDocuments: import('./coordination.ts').CoordinationDocuments;
  coordinationNotifications: import('./coordination.ts').CoordinationNotifications;
  modules: import('./modules.ts').Modules;
  riskEngine: import('./deterioration.ts').RiskEngine;
  deterioration: import('./deterioration.ts').Deterioration;
  followUp: import('./follow-up.ts').FollowUp;
  followUpPolicy: import('./follow-up.ts').FollowUpPolicy;
  notificationTransport: import('./follow-up.ts').NotificationTransport;
  integrations: import('./integrations.ts').Integrations;
  labTransport: import('./integrations.ts').LabTransport;
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
export type TeamMember = {
  id: string;
  tenant: string;
  name: string;
  profession: string;
};
export interface CareTeam {
  timeZone: string;
  members(actor: Actor): Promise<TeamMember[]>;
  workspace(
    actor: Actor,
    day: string,
  ): Promise<{
    appointments: Entity[];
    tasks: Entity[];
  }>;
  book(actor: Actor, patientId: string, input: unknown): Promise<Entity>;
  appointment(
    actor: Actor,
    id: string,
    action: string,
    version: number,
    input: unknown,
  ): Promise<Entity>;
  createTask(actor: Actor, patientId: string, input: unknown): Promise<Entity>;
  task(actor: Actor, id: string, action: string, version: number, input: unknown): Promise<Entity>;
  encounterClosed(actor: Actor, encounterId: string): Promise<void>;
  // Domain services call these inside their own store transaction.
  createLinkedTask(
    actor: Actor,
    patientId: string,
    input: unknown,
    orderId: string,
  ): Promise<Entity>;
  syncLinkedTask(
    actor: Actor,
    order: Entity,
    event: 'result' | 'review' | 'cancel',
    resolution?: string,
  ): Promise<Entity>;
}
export interface Medications {
  list(
    actor: Actor,
    patientId: string,
  ): Promise<{
    items: Entity[];
    snapshot: string[];
    review: Entity | null;
    current: boolean;
  }>;
  add(actor: Actor, patientId: string, input: unknown): Promise<Entity>;
  update(actor: Actor, id: string, version: number, input: unknown): Promise<Entity>;
  reconcile(actor: Actor, patientId: string, input: unknown): Promise<Entity>;
}
export interface Laboratories {
  order(actor: Actor, patientId: string, input: unknown): Promise<Entity>;
  receive(actor: Actor, id: string, version: number, input: unknown): Promise<Entity>;
  review(actor: Actor, id: string, version: number, input: unknown): Promise<Entity>;
  cancel(actor: Actor, id: string, version: number, input: unknown): Promise<Entity>;
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
  ): {
    total: number;
    items: import('./icd.ts').DiagnosisTerm[];
  };
}
export type ServiceName = keyof Services;
export type Plugin = {
  id: string;
  version: string;
  apiVersion: 2;
  provides: ServiceName[];
  requires: ServiceName[];
  setup(
    ctx: {
      get<K extends ServiceName>(name: K): Services[K];
      provide<K extends ServiceName>(name: K, value: Services[K]): void;
      onDispose(dispose: () => void | Promise<void>): void;
    },
    config: Record<string, unknown>,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
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
