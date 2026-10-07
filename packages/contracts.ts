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
export type ProjectionReport = {
  tenant: string;
  scanned: number;
  projected: number;
  upToDate: number;
  unmapped: number;
  failed: number;
  deferred: number;
};
export type ReconcileReport = {
  tenant: string;
  entities: number;
  counts: Record<string, number>;
  // Entity ids only, never clinical data. At most 20 per category.
  samples: Record<string, string[]>;
};
export interface Projection {
  runOnce(): Promise<ProjectionReport[]>;
  reconcile(): Promise<ReconcileReport[]>;
}
export type QueryCoverage = {
  ledger: number; // records in the legal ledger that match the question
  served: number; // of those, returned from the content store and verified against the ledger
  notProjected: number;
  unmapped: number;
  stale: number;
  diverged: number;
  missing: number;
};
type Answered = {
  source: string;
  asOf: string;
  coverage: QueryCoverage;
  // True only when every matching ledger record was served and verified.
  complete: boolean;
  // Rows in the content store that are not linked to a ledger record (never served).
  foreign: number;
  truncated: boolean;
};
export type VitalsAnswer = Answered & {
  code: string;
  points: {
    ref: string; // `${entityId}@${version}`, the same reference form AI evidence uses
    entityId: string;
    version: number;
    value: number;
    unit: string;
    effectiveAt: string;
  }[];
};
export type ProblemsAnswer = Answered & {
  problems: {
    ref: string;
    entityId: string;
    version: number;
    system?: string;
    code?: string;
    display: string;
    onset?: string;
    status: string;
  }[];
};
export interface ClinicalQuery {
  vitals(
    actor: Actor,
    patientId: string,
    query: { code: string; from?: string; to?: string; limit?: number },
  ): Promise<VitalsAnswer>;
  problems(actor: Actor, patientId: string, query?: { status?: string }): Promise<ProblemsAnswer>;
}
export type NetworkReach = 'none' | 'loopback' | 'allowlist' | 'any';
export interface AIProvider {
  id: string;
  // Declared reach of this provider. A router treats a provider without it as unrestricted.
  meta?: { network: NetworkReach; usesLanguageModel: boolean };
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
export interface FhirIps {
  // An International Patient Summary document Bundle (HL7 FHIR IPS 2.0.0, R4).
  document(actor: Actor, patientId: string): Promise<Record<string, any>>;
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
  projection: Projection;
  clinicalQuery: ClinicalQuery;
  fhirIps: FhirIps;
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
// Many-provider seams: any number of plugins register a named value under one contribution.
export interface Contributions {
  aiModel: AIProvider;
  contentStore: import('./content.ts').ContentStore;
}
export type ServiceName = keyof Services;
export type ContributionName = keyof Contributions;
export type Plugin = {
  id: string;
  version: string;
  apiVersion: 2;
  provides: ServiceName[];
  requires: ServiceName[];
  // Used when some plugin in the profile provides them; they start first, and `ctx.has` says
  // whether they are present. A plugin degrades without them instead of failing to start.
  optionalRequires?: ServiceName[];
  contributes?: ContributionName[];
  setup(
    ctx: {
      get<K extends ServiceName>(name: K): Services[K];
      has(name: ServiceName): boolean;
      provide<K extends ServiceName>(name: K, value: Services[K]): void;
      contribute<K extends ContributionName>(name: K, key: string, value: Contributions[K]): void;
      // Live view: contributors may start after the reader, so read it at call time.
      contributions<K extends ContributionName>(name: K): ReadonlyMap<string, Contributions[K]>;
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
