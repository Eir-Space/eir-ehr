import { z } from 'zod';
import { Fault, type Actor, type Entity } from './contracts.ts';
import type { ContentStore, ProblemRow, VitalPoint } from './content.ts';
import { openEhrVitalBindings } from './clinical-models.ts';

// openEHR content provider. Clinical facts live in archetyped compositions in an openEHR
// server (tested against EHRbase). One EHR per (tenant, patient) via the EHR subject. Eir's
// workflow fields (author, status, encounter link, ...) travel in the composition's
// feeder_audit original_content, which is what that field is for. On read, the archetyped
// paths are canonical: the envelope only preserves representation (for example the exact
// timestamp string) while the instants agree, so an edit made in another openEHR system wins.

export const templates = {
  observation: 'IDCR - Vital Signs Encounter.v1',
  condition: 'IDCR - Problem List.v1',
  note: 'RIPPLE - Clinical Notes.v1',
} as const;
type Kind = keyof typeof templates;
const roots: Record<Kind, string> = {
  observation: 'vital_signs_observations',
  condition: 'problem_list',
  note: 'clinical_notes',
};
const kindOfTemplate = Object.fromEntries(
  Object.entries(templates).map(([k, v]) => [v, k as Kind]),
);
const FLAT = 'application/openehr.wt.flat.schema+json';
type Flat = Record<string, unknown>;

// The adapter and capture layer share one pinned binding table. The model registry verifies the
// corresponding OPT digest before the application starts.
type VitalBinding = {
  label: string;
  eirUnit: string;
  unit: string;
  min: number;
  max: number;
  obs: string;
  field: string;
  proportion?: true;
  aql: {
    archetype: string;
    data: string;
    events: string;
    items: string;
    item: string;
    numerator?: true;
  };
};
export const vitalMap: Record<string, VitalBinding> = openEhrVitalBindings;

// Where each vital lives for AQL, taken from the template's web-template aqlPath metadata.
// Queries are assembled only from this table and bound parameters, never from caller text.
const vitalAql = Object.fromEntries(
  Object.entries(openEhrVitalBindings).map(([code, binding]) => [code, binding.aql]),
) as Record<
  string,
  { archetype: string; data: string; events: string; items: string; item: string; numerator?: true }
>;

export const openEhrOptions = z
  .object({
    key: z.string().min(1).default('openehr'),
    endpoint: z.url().default('http://127.0.0.1:8090/ehrbase'),
    username: z.string().min(1),
    password: z.string().min(1).optional(),
    passwordEnv: z.string().min(1).optional(),
    // Hosts the adapter may contact. Clinical text leaves the process, so this is explicit.
    allowedHosts: z.array(z.string().min(1)).default(['127.0.0.1', 'localhost', '[::1]']),
    // System part of version UIDs (uuid::system::n). EHRbase's default is local.ehrbase.org.
    systemId: z.string().min(1).default('local.ehrbase.org'),
    timeoutMs: z.number().int().min(1000).max(120000).default(20000),
  })
  .strict()
  .refine((o) => o.password || o.passwordEnv, 'Set password or passwordEnv');
export type OpenEhrOptions = z.infer<typeof openEhrOptions>;

const fault = (status: number, message: string) => new Fault(status, message);
const isUuid = (v: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const ns = (tenant: string) => `eir:${tenant}`;
const sameInstant = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b);
const near = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9;
const workflowEnvelope = (kind: Kind, data: Record<string, any>, origin?: string) => {
  const workflow: Record<string, unknown> = {};
  for (const key of [
    'encounterId',
    'status',
    'author',
    'clientId',
    'signedBy',
    'signedAt',
    'signedUnder',
    'amends',
    'proposalId',
    'correctionReason',
  ])
    if (data[key] !== undefined) workflow[key] = data[key];
  if (kind === 'condition' && data.code?.version) workflow.terminologyVersion = data.code.version;
  return { eir: 2, kind, workflow, ...(origin ? { origin } : {}) };
};

// ---- mapping (pure) --------------------------------------------------------------------------

export function toFlat(
  kind: string,
  data: Record<string, any>,
  actor: Actor,
  startTime: string,
  origin?: string,
): Flat {
  if (!(kind in templates)) throw fault(422, `Unsupported record type: ${kind}`);
  const k = kind as Kind;
  const root = roots[k];
  const flat: Flat = {
    [`${root}/category|code`]: '433',
    [`${root}/category|value`]: 'event',
    [`${root}/category|terminology`]: 'openehr',
    [`${root}/language|code`]: 'sv',
    [`${root}/language|terminology`]: 'ISO_639-1',
    [`${root}/territory|code`]: 'SE',
    [`${root}/territory|terminology`]: 'ISO_3166-1',
    [`${root}/composer|name`]: String(data.author ?? actor.id),
    [`${root}/composer|id`]: String(data.author ?? actor.id),
    [`${root}/composer|id_scheme`]: 'eir:actor',
    [`${root}/composer|id_namespace`]: ns(actor.tenant),
    [`${root}/context/start_time`]: startTime,
    [`${root}/context/setting|code`]: '228',
    [`${root}/context/setting|value`]: 'primary medical care',
    [`${root}/context/setting|terminology`]: 'openehr',
    [`${root}/_feeder_audit/originating_system_audit|system_id`]: 'eir-ehr',
    [`${root}/_feeder_audit/original_content|formalism`]: 'application/json',
    // Clinical values live only on archetyped paths. This envelope carries the workflow and
    // provenance fields that the imported templates do not model.
    [`${root}/_feeder_audit/original_content|value`]: JSON.stringify(
      workflowEnvelope(k, data, origin),
    ),
  };
  if (k === 'observation') {
    if (Number.isNaN(Date.parse(String(data.effectiveAt))))
      throw fault(422, 'Invalid observation time');
    const write = (code: string, value: unknown, unit: unknown) => {
      const def = vitalMap[code as keyof typeof vitalMap];
      if (!def) throw fault(422, `Observation ${code} has no mapping in ${templates.observation}`);
      if (unit !== def.eirUnit || typeof value !== 'number')
        throw fault(422, 'Invalid observation unit or value');
      const p = `${root}/vital_signs/${def.obs}`;
      flat[`${p}/time`] = data.effectiveAt;
      if ('proportion' in def && def.proportion) {
        flat[`${p}/${def.field}|numerator`] = value;
        flat[`${p}/${def.field}|denominator`] = 100;
        flat[`${p}/${def.field}|type`] = 2;
      } else {
        flat[`${p}/${def.field}|magnitude`] = value;
        flat[`${p}/${def.field}|unit`] = def.unit;
      }
    };
    if (data.code === '85354-9') {
      if (!Array.isArray(data.components) || data.components.length !== 2)
        throw fault(422, 'Blood pressure requires systolic and diastolic components');
      for (const component of data.components)
        write(String(component.code), component.value, component.unit);
    } else write(String(data.code), data.value, data.unit);
    flat[`${root}/context/start_time`] = data.effectiveAt;
  } else if (k === 'condition') {
    const c = data.code;
    if (
      !c ||
      typeof c.code !== 'string' ||
      typeof c.display !== 'string' ||
      typeof c.system !== 'string'
    )
      throw fault(422, 'A coded diagnosis is required');
    const p = `${root}/problems_and_issues/problem_diagnosis:0`;
    flat[`${p}/problem_diagnosis_name|value`] = c.display;
    flat[`${p}/problem_diagnosis_name|code`] = c.code;
    flat[`${p}/problem_diagnosis_name|terminology`] = c.system;
    if (data.onset !== undefined) flat[`${p}/date_time_of_onset`] = data.onset;
  } else {
    if (typeof data.text !== 'string' || !data.text) throw fault(422, 'Note text is required');
    flat[`${root}/clinical_synopsis:0/notes`] = data.text;
  }
  return flat;
}

function originOf(kind: Kind, flat: Flat): string | undefined {
  const root = roots[kind];
  const raw =
    flat[`${root}/_feeder_audit/original_content`] ??
    flat[`${root}/_feeder_audit/original_content|value`];
  try {
    const origin = typeof raw === 'string' ? JSON.parse(raw)?.origin : undefined;
    return typeof origin === 'string' ? origin : undefined;
  } catch {
    return undefined;
  }
}

// Rebuild Eir data. Envelope = what Eir wrote; paths = canonical clinical content.
export function fromFlat(kind: Kind, flat: Flat): Record<string, any> {
  const root = roots[kind];
  const raw =
    flat[`${root}/_feeder_audit/original_content`] ??
    flat[`${root}/_feeder_audit/original_content|value`];
  let envelope: Record<string, any> = {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.kind === kind) {
        if (parsed.eir === 2 && parsed.workflow && typeof parsed.workflow === 'object')
          envelope = parsed.workflow;
        else if (parsed.data && typeof parsed.data === 'object') envelope = parsed.data;
      }
    } catch {
      /* A foreign or damaged envelope is ignored; the archetyped paths still describe the fact. */
    }
  }
  const data: Record<string, any> = { ...envelope };
  if (kind === 'observation') {
    const values = new Map<
      string,
      { code: string; value: number; unit: string; display: string; time?: string }
    >();
    for (const [code, def] of Object.entries(vitalMap)) {
      const p = `${root}/vital_signs/${def.obs}/${def.field}`;
      const value =
        'proportion' in def && def.proportion ? flat[`${p}|numerator`] : flat[`${p}|magnitude`];
      if (typeof value !== 'number') continue;
      const time = flat[`${root}/vital_signs/${def.obs}/time`];
      values.set(code, {
        code,
        value,
        unit: def.eirUnit,
        display: def.label,
        ...(typeof time === 'string' ? { time } : {}),
      });
    }
    const systolic = values.get('8480-6');
    const diastolic = values.get('8462-4');
    if (systolic && diastolic) {
      data.code = '85354-9';
      data.display = 'Blodtryck';
      data.unit = 'mm[Hg]';
      data.components = [systolic, diastolic].map(({ code, value, unit, display }) => ({
        code,
        value,
        unit,
        display,
      }));
      delete data.value;
      const time = systolic.time ?? diastolic.time;
      if (time && !sameInstant(time, envelope.effectiveAt)) data.effectiveAt = time;
    } else {
      const point = values.values().next().value;
      if (point) {
        data.code = point.code;
        data.unit = point.unit;
        data.display = point.display;
        data.value = near(point.value, envelope.value) ? envelope.value : point.value;
        if (point.time && !sameInstant(point.time, envelope.effectiveAt))
          data.effectiveAt = point.time;
      }
    }
  } else if (kind === 'condition') {
    const p = `${root}/problems_and_issues/problem_diagnosis:0`;
    const code = flat[`${p}/problem_diagnosis_name|code`];
    const display =
      flat[`${p}/problem_diagnosis_name|value`] ?? flat[`${p}/problem_diagnosis_name`];
    const system = flat[`${p}/problem_diagnosis_name|terminology`];
    if (typeof display === 'string') {
      data.code = { ...(envelope.code ?? {}) };
      if (typeof system === 'string') data.code.system = system;
      if (typeof code === 'string') data.code.code = code;
      data.code.display = display;
      if (typeof envelope.terminologyVersion === 'string')
        data.code.version = envelope.terminologyVersion;
      delete data.terminologyVersion;
    }
    const onset = flat[`${p}/date_time_of_onset`];
    if (typeof onset === 'string') {
      if (
        !(typeof envelope.onset === 'string' && onset.startsWith(envelope.onset)) &&
        onset !== envelope.onset
      )
        data.onset = onset;
    } else delete data.onset;
  } else {
    const text = flat[`${root}/clinical_synopsis:0/notes`];
    if (typeof text === 'string') data.text = text;
  }
  return data;
}

// ---- client ----------------------------------------------------------------------------------

type Reply = { status: number; headers: Headers; text: string };
export function createOpenEhrStore(raw: unknown): ContentStore & { options: OpenEhrOptions } {
  const options = openEhrOptions.parse(raw);
  const base = new URL(options.endpoint.replace(/\/+$/, '') + '/');
  if (
    !options.allowedHosts.includes(base.hostname === '::1' ? '[::1]' : base.hostname) ||
    base.username ||
    base.password
  )
    throw new Error(`openEHR endpoint host ${base.hostname} is not in allowedHosts`);
  const password = options.password ?? process.env[options.passwordEnv!];
  if (!password) throw new Error(`Environment variable ${options.passwordEnv} is not set`);
  const auth = 'Basic ' + Buffer.from(`${options.username}:${password}`).toString('base64');

  async function call(
    method: string,
    path: string,
    init: {
      body?: unknown;
      contentType?: string;
      accept?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Reply> {
    const response = await fetch(new URL('rest/openehr/v1' + path, base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        authorization: auth,
        accept: init.accept ?? 'application/json',
        ...(init.body !== undefined
          ? { 'content-type': init.contentType ?? 'application/json' }
          : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }
  // Server error bodies can echo submitted clinical content, so they never reach callers.
  const unexpected = (what: string, r: Reply) =>
    fault(502, `openEHR server ${what} failed (${r.status})`);
  const json = (r: Reply) => JSON.parse(r.text);
  const aql = async (q: string, parameters: Record<string, string> = {}) => {
    const r = await call('POST', '/query/aql', { body: { q, query_parameters: parameters } });
    if (r.status !== 200) throw unexpected('query', r);
    return (json(r).rows ?? []) as unknown[][];
  };

  const ehrCache = new Map<string, string>();
  const located = new Map<string, { ehr: string; kind: Kind }>();
  const subject = (tenant: string, patientId: string) => ({
    _type: 'PARTY_SELF',
    external_ref: {
      _type: 'PARTY_REF',
      namespace: ns(tenant),
      type: 'PERSON',
      id: { _type: 'GENERIC_ID', value: patientId, scheme: 'eir:patient' },
    },
  });
  async function ehrFor(tenant: string, patientId: string, create: boolean) {
    const key = `${tenant}\u0000${patientId}`;
    const cached = ehrCache.get(key);
    if (cached) return cached;
    const lookup = async () => {
      const r = await call(
        'GET',
        `/ehr?subject_id=${encodeURIComponent(patientId)}&subject_namespace=${encodeURIComponent(ns(tenant))}`,
      );
      if (r.status === 404) return undefined;
      if (r.status !== 200) throw unexpected('EHR lookup', r);
      return String(json(r).ehr_id.value);
    };
    let id = await lookup();
    if (!id && create) {
      const r = await call('POST', '/ehr', {
        body: {
          _type: 'EHR_STATUS',
          archetype_node_id: 'openEHR-EHR-EHR_STATUS.generic.v1',
          name: { _type: 'DV_TEXT', value: 'EHR Status' },
          subject: subject(tenant, patientId),
          is_modifiable: true,
          is_queryable: true,
        },
      });
      if (r.status === 201 || r.status === 204 || r.status === 200)
        id = (r.headers.get('etag') ?? '').replaceAll('"', '') || (await lookup());
      else if (r.status === 409) id = await lookup();
      else throw unexpected('EHR creation', r);
    }
    if (id) ehrCache.set(key, id);
    return id;
  }
  // A composition id alone does not say which EHR holds it. Probe the version uids (AQL has no
  // prefix match), then confirm the EHR belongs to the caller's tenant.
  async function locate(tenant: string, id: string) {
    if (!isUuid(id)) return undefined;
    const hit = located.get(`${tenant}\u0000${id}`);
    if (hit) return hit;
    const uids = Array.from(
      { length: 64 },
      (_, i) => `'${id}::${options.systemId}::${i + 1}'`,
    ).join(',');
    const rows = await aql(
      `SELECT e/ehr_id/value, c/archetype_details/template_id/value FROM EHR e CONTAINS COMPOSITION c WHERE c/uid/value MATCHES {${uids}}`,
    );
    if (!rows.length) return undefined;
    const [ehr, template] = rows[0] as [string, string];
    const kind = kindOfTemplate[template];
    if (!kind) return undefined;
    const r = await call('GET', `/ehr/${ehr}/ehr_status`);
    if (r.status !== 200) throw unexpected('EHR status', r);
    if (json(r).subject?.external_ref?.namespace !== ns(tenant)) return undefined;
    const found = { ehr, kind };
    located.set(`${tenant}\u0000${id}`, found);
    return found;
  }

  const versionNumber = (uid: string) => Number(uid.split('::')[2]);
  async function entityFrom(
    tenant: string,
    patientId: string | undefined,
    where: { ehr: string; kind: Kind },
    id: string,
    uidOrId: string,
    times?: { createdAt: string; updatedAt: string },
    meta?: { origin?: string },
  ): Promise<Entity> {
    const r = await call('GET', `/ehr/${where.ehr}/composition/${uidOrId}`, { accept: FLAT });
    if (r.status !== 200) throw unexpected('read', r);
    const flat = json(r) as Flat;
    const uid = String(flat[`${roots[where.kind]}/_uid`] ?? '');
    let pid = patientId;
    if (!pid) {
      const s = await call('GET', `/ehr/${where.ehr}/ehr_status`);
      if (s.status !== 200) throw unexpected('EHR status', s);
      pid = String(json(s).subject.external_ref.id.value);
    }
    if (meta) meta.origin = originOf(where.kind, flat);
    const version = versionNumber(uid);
    const stamps = times ?? (await commitTimes(where.ehr, id, version));
    return {
      id,
      tenant,
      patientId: pid,
      kind: where.kind,
      version,
      createdAt: stamps.createdAt,
      updatedAt: stamps.updatedAt,
      data: fromFlat(where.kind, flat),
    };
  }
  async function commitTimes(ehr: string, id: string, version?: number) {
    const items = await revisions(ehr, id);
    const at = (i: any) => String(i.audits?.[0]?.time_committed?.value ?? '');
    const target = version
      ? items.find((i) => versionNumber(i.version_id.value) === version)
      : undefined;
    return { createdAt: at(items[0]), updatedAt: at(target ?? items[items.length - 1]) };
  }
  async function revisions(ehr: string, id: string) {
    const r = await call('GET', `/ehr/${ehr}/versioned_composition/${id}/revision_history`);
    if (r.status !== 200) throw unexpected('history', r);
    return (json(r).items ?? []) as any[];
  }
  const iso = (s: string) => new Date(s).toISOString();

  const store: ContentStore & { options: OpenEhrOptions } = {
    options,
    kinds: Object.keys(templates),
    async health() {
      const r = await call('GET', '/definition/template/adl1.4');
      if (r.status !== 200) throw unexpected('health check', r);
      const have = new Set((json(r) as { template_id: string }[]).map((t) => t.template_id));
      const missing = Object.values(templates).filter((t) => !have.has(t));
      if (missing.length) throw new Error(`openEHR templates not uploaded: ${missing.join(', ')}`);
    },
    async insert(actor, kind, patientId, data, origin) {
      if (origin !== undefined && !/^[A-Za-z0-9._:-]{8,100}$/.test(origin))
        throw fault(422, 'Invalid origin key');
      const now = new Date().toISOString();
      const flat = toFlat(kind, data, actor, now, origin);
      const ehr = (await ehrFor(actor.tenant, patientId, true))!;
      const r = await call(
        'POST',
        `/ehr/${ehr}/composition?templateId=${encodeURIComponent(templates[kind as Kind])}`,
        { body: flat, contentType: FLAT, accept: FLAT, headers: { prefer: 'return=minimal' } },
      );
      if (r.status === 422 || r.status === 400)
        throw fault(422, 'Record not accepted by the openEHR template');
      if (![200, 201, 204].includes(r.status)) throw unexpected('create', r);
      const uid = (r.headers.get('etag') ?? '').replaceAll('"', '');
      const id = uid.split('::')[0];
      if (!isUuid(id)) throw unexpected('create', r);
      const where = { ehr, kind: kind as Kind };
      located.set(`${actor.tenant}\u0000${id}`, where);
      return await entityFrom(actor.tenant, patientId, where, id, id);
    },
    async vitalSeries(tenant, patientId, code, cap) {
      const def = vitalAql[code];
      const def2 = vitalMap[code];
      if (!def || !def2)
        throw fault(422, `Observation ${code} has no mapping in ${templates.observation}`);
      const ehr = await ehrFor(tenant, patientId, false);
      if (!ehr) return [];
      const at = `o/data[${def.data}]/events[${def.events}]`;
      const rows = await aql(
        `SELECT c/uid/value, ${at}/time/value, ${at}/data[${def.items}]/items[${def.item}]/value/${def.numerator ? 'numerator' : 'magnitude'} FROM EHR e CONTAINS COMPOSITION c CONTAINS OBSERVATION o[openEHR-EHR-OBSERVATION.${def.archetype}.v1] WHERE e/ehr_id/value = $ehr`,
        { ehr },
      );
      return rows
        .filter((r) => typeof r[2] === 'number' && typeof r[1] === 'string')
        .map((r): VitalPoint => ({
          id: String(r[0]).split('::')[0],
          version: versionNumber(String(r[0])),
          code,
          value: r[2] as number,
          unit: def2.eirUnit,
          effectiveAt: r[1] as string,
        }))
        .sort(
          (a, b) =>
            Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || a.id.localeCompare(b.id),
        )
        .slice(0, cap);
    },
    async problems(tenant, patientId, cap) {
      const ehr = await ehrFor(tenant, patientId, false);
      if (!ehr) return [];
      const name = 'p/data[at0001]/items[at0002]/value';
      const rows = await aql(
        `SELECT c/uid/value, ${name}/value, ${name}/defining_code/code_string, ${name}/defining_code/terminology_id/value, p/data[at0001]/items[at0077]/value/value FROM EHR e CONTAINS COMPOSITION c CONTAINS EVALUATION p[openEHR-EHR-EVALUATION.problem_diagnosis.v1] WHERE e/ehr_id/value = $ehr`,
        { ehr },
      );
      return rows
        .filter((r) => typeof r[1] === 'string')
        .map((r): ProblemRow => ({
          id: String(r[0]).split('::')[0],
          version: versionNumber(String(r[0])),
          display: r[1] as string,
          ...(typeof r[2] === 'string' ? { code: r[2] } : {}),
          ...(typeof r[3] === 'string' ? { system: r[3] } : {}),
          ...(typeof r[4] === 'string' ? { onset: r[4] } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, cap);
    },
    async findByOrigin(tenant, patientId, origin) {
      const ehr = await ehrFor(tenant, patientId, false);
      if (!ehr) return undefined;
      const rows = await aql(
        'SELECT c/uid/value, c/archetype_details/template_id/value FROM EHR e CONTAINS COMPOSITION c WHERE e/ehr_id/value = $ehr',
        { ehr },
      );
      for (const [uid, template] of rows) {
        const kind = kindOfTemplate[String(template)];
        if (!kind) continue;
        const id = String(uid).split('::')[0];
        const meta: { origin?: string } = {};
        const entity = await entityFrom(tenant, patientId, { ehr, kind }, id, id, undefined, meta);
        if (meta.origin === origin) return entity;
      }
      return undefined;
    },
    async get(tenant, id) {
      const where = await locate(tenant, id);
      return where ? await entityFrom(tenant, undefined, where, id, id) : undefined;
    },
    async list(tenant, patientId, kind) {
      if (kind !== undefined && !(kind in templates))
        throw fault(422, `Unsupported record type: ${kind}`);
      const ehr = await ehrFor(tenant, patientId, false);
      if (!ehr) return [];
      const rows = await aql(
        'SELECT c/uid/value, c/archetype_details/template_id/value FROM EHR e CONTAINS COMPOSITION c WHERE e/ehr_id/value = $ehr',
        { ehr },
      );
      const wanted = rows
        .map(([uid, template]) => ({
          id: String(uid).split('::')[0],
          kind: kindOfTemplate[String(template)],
        }))
        .filter((r): r is { id: string; kind: Kind } => !!r.kind && (!kind || r.kind === kind));
      const out: Entity[] = [];
      for (let i = 0; i < wanted.length; i += 8)
        out.push(
          ...(await Promise.all(
            wanted
              .slice(i, i + 8)
              .map((w) => entityFrom(tenant, patientId, { ehr, kind: w.kind }, w.id, w.id)),
          )),
        );
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    async revise(actor, entity, version, data, action) {
      void action;
      if (actor.tenant !== entity.tenant) throw fault(403, 'Tenant does not match the record.');
      const where = await locate(actor.tenant, entity.id);
      const stale = () => fault(409, 'Record changed. Reload before saving.');
      if (!where || !Number.isSafeInteger(version) || version < 1) throw stale();
      const meta: { origin?: string } = {};
      const current = await entityFrom(
        actor.tenant,
        entity.patientId,
        where,
        entity.id,
        entity.id,
        undefined,
        meta,
      );
      if (current.version !== version || entity.version !== version) throw stale();
      // openEHR has no per-version lock, so the adapter enforces the immutability Eir requires.
      if (where.kind === 'note' && current.data.status === 'signed')
        throw fault(409, 'Signed note is immutable');
      const start = current.createdAt ? iso(current.createdAt) : new Date().toISOString();
      const flat = toFlat(where.kind, data, actor, start, meta.origin);
      const r = await call(
        'PUT',
        `/ehr/${where.ehr}/composition/${entity.id}?templateId=${encodeURIComponent(templates[where.kind])}`,
        {
          body: flat,
          contentType: FLAT,
          accept: FLAT,
          headers: {
            prefer: 'return=minimal',
            'if-match': `${entity.id}::${options.systemId}::${version}`,
          },
        },
      );
      if (r.status === 412) throw stale();
      if (r.status === 422 || r.status === 400)
        throw fault(422, 'Record not accepted by the openEHR template');
      if (![200, 204].includes(r.status)) throw unexpected('update', r);
      return await entityFrom(actor.tenant, entity.patientId, where, entity.id, entity.id);
    },
    async history(tenant, id) {
      const where = await locate(tenant, id);
      if (!where) return [];
      const items = await revisions(where.ehr, id);
      const createdAt = String(items[0]?.audits?.[0]?.time_committed?.value ?? '');
      const out: Entity[] = [];
      for (const item of items) {
        const uid = String(item.version_id.value);
        out.push(
          await entityFrom(tenant, undefined, where, id, uid, {
            createdAt,
            updatedAt: String(item.audits?.[0]?.time_committed?.value ?? ''),
          }),
        );
      }
      return out;
    },
  };
  return store;
}
