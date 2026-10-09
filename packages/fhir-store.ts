import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Fault, type Actor, type Entity } from './contracts.ts';
import type { ContentStore, ProblemRow, VitalPoint } from './content.ts';
import {
  assertReversible,
  defaultCodeSystems,
  fromFhirSystem,
  toFhirSystem,
  type CodeSystemMap,
} from './code-systems.ts';

// FHIR R4 content provider (tested against HAPI). Clinical content goes into native FHIR elements,
// so any FHIR client can read it: vitals as Observation (LOINC, UCUM), diagnoses as a coded
// Condition, notes as DocumentReference. Eir's workflow fields travel in one extension. As with the
// openEHR provider, the native elements are canonical on read: the extension only preserves
// representation (for example a timestamp's notation) while the values agree, so an edit made in
// another FHIR system wins and is reported by reconcile.
//
// Tenancy: each (tenant, patient) is one Patient resource identified by a tenant-scoped system.
// Versions: FHIR's own versionId is the Eir version, so revise is an If-Match update.

const ENVELOPE = 'https://eir.space/fhir/StructureDefinition/envelope';
const ORIGIN = 'urn:eir:origin';
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
type Kind = 'observation' | 'condition' | 'note';
const OBS_STATUS = ['final', 'entered-in-error', 'amended', 'corrected', 'preliminary'];
const typeOf: Record<Kind, string> = {
  observation: 'Observation',
  condition: 'Condition',
  note: 'DocumentReference',
};
const kindOf: Record<string, Kind> = Object.fromEntries(
  Object.entries(typeOf).map(([k, v]) => [v, k as Kind]),
);
type Resource = Record<string, any>;

export const fhirOptions = z
  .object({
    key: z.string().min(1).default('fhir'),
    endpoint: z.url().default('http://127.0.0.1:8091/fhir'),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    passwordEnv: z.string().min(1).optional(),
    bearerTokenEnv: z.string().min(1).optional(),
    // Hosts the adapter may contact. Clinical data leaves the process, so this is explicit.
    allowedHosts: z.array(z.string().min(1)).default(['127.0.0.1', 'localhost', '[::1]']),
    timeoutMs: z.number().int().min(1000).max(120000).default(20000),
    // Internal code system identifier -> identifier on the FHIR wire (see code-systems.ts).
    codeSystems: z.record(z.string(), z.string()).default(defaultCodeSystems),
  })
  .strict();
export type FhirOptions = z.infer<typeof fhirOptions>;

const fault = (status: number, message: string) => new Fault(status, message);
const isUuid = (v: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const tenantSystem = (tenant: string) => `urn:eir:tenant:${encodeURIComponent(tenant)}`;
const sameInstant = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b);
const near = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9;

// ---- mapping (pure) --------------------------------------------------------------------------

export function toResource(
  kind: string,
  data: Record<string, any>,
  patientFhirId: string,
  // `rev` is the Eir version being written. FHIR servers treat an unchanged update as a no-op and
  // create no version, but the ledger needs one version per revision, so it is part of the resource.
  extra: { origin?: string; createdAt: string; rev: number; codeSystems?: CodeSystemMap },
): Resource {
  if (!(kind in typeOf)) throw fault(422, `Unsupported record type: ${kind}`);
  const k = kind as Kind;
  const base: Resource = {
    resourceType: typeOf[k],
    ...(extra.origin ? { identifier: [{ system: ORIGIN, value: extra.origin }] } : {}),
    extension: [
      {
        url: ENVELOPE,
        valueString: JSON.stringify({
          eir: 1,
          kind,
          data,
          createdAt: extra.createdAt,
          rev: extra.rev,
          ...(extra.origin ? { origin: extra.origin } : {}),
        }),
      },
    ],
  };
  const subject = { reference: `Patient/${patientFhirId}` };
  const who = typeof data.author === 'string' ? [{ display: data.author }] : undefined;
  if (k === 'observation') {
    if (
      typeof data.code !== 'string' ||
      typeof data.value !== 'number' ||
      typeof data.unit !== 'string' ||
      Number.isNaN(Date.parse(String(data.effectiveAt)))
    )
      throw fault(422, 'Invalid observation');
    return {
      ...base,
      status: OBS_STATUS.includes(data.status) ? data.status : 'final',
      category: [
        {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/observation-category',
              code: 'vital-signs',
            },
          ],
        },
      ],
      code: {
        coding: [
          { system: LOINC, code: data.code, ...(data.display ? { display: data.display } : {}) },
        ],
      },
      subject,
      effectiveDateTime: data.effectiveAt,
      valueQuantity: { value: data.value, unit: data.unit, system: UCUM, code: data.unit },
      ...(who ? { performer: who } : {}),
    };
  }
  if (k === 'condition') {
    const c = data.code;
    if (
      !c ||
      typeof c.code !== 'string' ||
      typeof c.display !== 'string' ||
      typeof c.system !== 'string'
    )
      throw fault(422, 'A coded diagnosis is required');
    const erroneous = data.status === 'entered-in-error';
    return {
      ...base,
      ...(erroneous
        ? {
            verificationStatus: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
                  code: 'entered-in-error',
                },
              ],
            },
          }
        : {
            clinicalStatus: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
                  code: data.status === 'resolved' ? 'resolved' : 'active',
                },
              ],
            },
          }),
      code: {
        coding: [
          {
            system: toFhirSystem(c.system, extra.codeSystems),
            ...(c.version ? { version: c.version } : {}),
            code: c.code,
            display: c.display,
          },
        ],
        text: c.display,
      },
      subject,
      ...(typeof data.onset === 'string' ? { onsetDateTime: data.onset } : {}),
      ...(who ? { recorder: who[0] } : {}),
    };
  }
  if (typeof data.text !== 'string' || !data.text) throw fault(422, 'Note text is required');
  return {
    ...base,
    status: 'current',
    docStatus: data.status === 'signed' ? 'final' : 'preliminary',
    subject,
    ...(who ? { author: who } : {}),
    content: [
      {
        attachment: {
          contentType: 'text/plain; charset=utf-8',
          language: 'sv',
          data: Buffer.from(data.text, 'utf8').toString('base64'),
        },
      },
    ],
  };
}

function envelopeOf(res: Resource) {
  const raw = (res.extension ?? []).find((e: Resource) => e.url === ENVELOPE)?.valueString;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function fromResource(
  res: Resource,
  codeSystems?: CodeSystemMap,
): {
  data: Record<string, any>;
  createdAt?: string;
  origin?: string;
} {
  const kind = kindOf[res.resourceType];
  const envelope = envelopeOf(res);
  const given =
    envelope.kind === kind && envelope.data && typeof envelope.data === 'object'
      ? envelope.data
      : {};
  const data: Record<string, any> = { ...given };
  if (kind === 'observation') {
    const coding = res.code?.coding?.find((c: Resource) => c.system === LOINC);
    if (coding?.code) data.code = coding.code;
    const q = res.valueQuantity;
    if (q && typeof q.value === 'number') {
      data.value = near(q.value, given.value) ? given.value : q.value;
      data.unit = q.code ?? q.unit ?? data.unit;
    }
    if (
      typeof res.effectiveDateTime === 'string' &&
      !sameInstant(res.effectiveDateTime, given.effectiveAt)
    )
      data.effectiveAt = res.effectiveDateTime;
    // FHIR's status is canonical; an Eir-only status (one FHIR has no word for) is kept from the extension.
    if (
      typeof res.status === 'string' &&
      !(res.status === 'final' && !OBS_STATUS.includes(given.status))
    )
      data.status = res.status;
  } else if (kind === 'condition') {
    const c = res.code?.coding?.[0];
    if (c?.code) {
      data.code = {
        ...(given.code ?? {}),
        ...(c.system ? { system: fromFhirSystem(c.system, codeSystems) } : {}),
        ...(c.version ? { version: c.version } : {}),
        code: c.code,
        ...(c.display ? { display: c.display } : {}),
      };
    }
    const onset = res.onsetDateTime ?? res.onsetDate;
    if (typeof onset === 'string') {
      if (!(typeof given.onset === 'string' && onset.startsWith(given.onset))) data.onset = onset;
    } else delete data.onset;
    const ver = res.verificationStatus?.coding?.[0]?.code;
    if (ver === 'entered-in-error') data.status = 'entered-in-error';
  } else if (kind === 'note') {
    const b64 = res.content?.[0]?.attachment?.data;
    if (typeof b64 === 'string') data.text = Buffer.from(b64, 'base64').toString('utf8');
    if (res.docStatus === 'final') data.status = 'signed';
    else if (given.status === 'signed') data.status = 'draft';
  }
  return { data, createdAt: envelope.createdAt, origin: envelope.origin };
}

// ---- client ----------------------------------------------------------------------------------

type Reply = { status: number; headers: Headers; json: Resource | undefined };
export function createFhirStore(raw: unknown): ContentStore & { options: FhirOptions } {
  const options = fhirOptions.parse(raw);
  assertReversible(options.codeSystems);
  const base = new URL(options.endpoint.replace(/\/+$/, '') + '/');
  if (
    !options.allowedHosts.includes(base.hostname === '::1' ? '[::1]' : base.hostname) ||
    base.username ||
    base.password
  )
    throw new Error(`FHIR endpoint host ${base.hostname} is not in allowedHosts`);
  const secret = (name?: string) => (name ? process.env[name] : undefined);
  const password = options.password ?? secret(options.passwordEnv);
  if (options.username && !password) throw new Error('A username needs password or passwordEnv');
  if (options.passwordEnv && !password)
    throw new Error(`Environment variable ${options.passwordEnv} is not set`);
  const bearer = secret(options.bearerTokenEnv);
  if (options.bearerTokenEnv && !bearer)
    throw new Error(`Environment variable ${options.bearerTokenEnv} is not set`);
  const authorization = bearer
    ? `Bearer ${bearer}`
    : options.username
      ? 'Basic ' + Buffer.from(`${options.username}:${password}`).toString('base64')
      : undefined;

  async function call(
    method: string,
    path: string,
    init: { body?: Resource; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    const response = await fetch(new URL(path.replace(/^\//, ''), base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        accept: 'application/fhir+json',
        ...(authorization ? { authorization } : {}),
        ...(init.body ? { 'content-type': 'application/fhir+json' } : {}),
        ...init.headers,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await response.text();
    let json: Resource | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, json };
  }
  // Server error bodies can echo submitted clinical content, so they never reach callers.
  const unexpected = (what: string, r: Reply) =>
    fault(502, `FHIR server ${what} failed (${r.status})`);
  const q = encodeURIComponent;

  // Patient resources: (tenant, patientId) <-> FHIR logical id.
  const patientIds = new Map<string, string>();
  const patientInfo = new Map<string, { tenant: string; patientId: string }>();
  async function patientFor(tenant: string, patientId: string, create: boolean) {
    const key = `${tenant}\u0000${patientId}`;
    const cached = patientIds.get(key);
    if (cached) return cached;
    const ident = `${tenantSystem(tenant)}|${patientId}`;
    let id: string | undefined;
    if (create) {
      const r = await call('POST', '/Patient', {
        headers: { 'if-none-exist': `identifier=${q(ident)}` },
        body: {
          resourceType: 'Patient',
          identifier: [{ system: tenantSystem(tenant), value: patientId }],
        },
      });
      if (r.status === 201) id = r.json?.id;
      else if (r.status === 200) id = r.json?.id;
      else if (r.status !== 412) throw unexpected('patient creation', r);
    }
    if (!id) {
      const r = await call('GET', `/Patient?identifier=${q(ident)}&_count=2`);
      if (r.status !== 200) throw unexpected('patient lookup', r);
      id = r.json?.entry?.[0]?.resource?.id;
    }
    if (id) {
      patientIds.set(key, id);
      patientInfo.set(id, { tenant, patientId });
    }
    return id;
  }
  async function ownerOf(res: Resource) {
    const ref = String(res.subject?.reference ?? res.subject?.reference ?? '');
    const fid = ref.startsWith('Patient/') ? ref.slice(8) : undefined;
    if (!fid) return undefined;
    const cached = patientInfo.get(fid);
    if (cached) return cached;
    const r = await call('GET', `/Patient/${fid}`);
    if (r.status !== 200) return undefined;
    const identifier = (r.json?.identifier ?? []).find((i: Resource) =>
      String(i.system).startsWith('urn:eir:tenant:'),
    );
    if (!identifier) return undefined;
    const info = {
      tenant: decodeURIComponent(String(identifier.system).slice('urn:eir:tenant:'.length)),
      patientId: String(identifier.value),
    };
    patientInfo.set(fid, info);
    return info;
  }

  async function entityOf(
    res: Resource,
    tenant: string,
    stamps?: { createdAt: string },
  ): Promise<Entity | undefined> {
    const kind = kindOf[res.resourceType];
    const owner = await ownerOf(res);
    if (!kind || !owner || owner.tenant !== tenant) return undefined;
    const parsed = fromResource(res, options.codeSystems);
    const updatedAt = String(res.meta?.lastUpdated ?? '');
    return {
      id: String(res.id),
      tenant,
      patientId: owner.patientId,
      kind,
      version: Number(res.meta?.versionId),
      createdAt: stamps?.createdAt ?? parsed.createdAt ?? updatedAt,
      updatedAt,
      data: parsed.data,
    };
  }
  async function read(
    tenant: string,
    id: string,
  ): Promise<{ res: Resource; entity: Entity } | undefined> {
    if (!isUuid(id)) return undefined;
    for (const type of Object.values(typeOf)) {
      const r = await call('GET', `/${type}/${id}`);
      if (r.status === 404 || r.status === 410) continue;
      if (r.status !== 200 || !r.json) throw unexpected('read', r);
      const entity = await entityOf(r.json, tenant);
      return entity ? { res: r.json, entity } : undefined;
    }
    return undefined;
  }
  async function search(path: string, cap = 5000): Promise<Resource[]> {
    const out: Resource[] = [];
    let next: string | undefined = path;
    while (next && out.length < cap) {
      const r: Reply = await call('GET', next);
      if (r.status !== 200) throw unexpected('search', r);
      for (const e of r.json?.entry ?? [])
        if (e.resource && e.search?.mode !== 'outcome') out.push(e.resource);
      const url = (r.json?.link ?? []).find((l: Resource) => l.relation === 'next')?.url as
        string | undefined;
      // The server reports its own host in paging links, so keep only the path and query.
      next = url
        ? new URL(url).pathname.slice(base.pathname.replace(/\/$/, '').length) + new URL(url).search
        : undefined;
    }
    return out.slice(0, cap);
  }

  const store: ContentStore & { options: FhirOptions } = {
    options,
    kinds: Object.keys(typeOf),
    async health() {
      const r = await call('GET', '/metadata?_summary=true');
      if (r.status !== 200 || r.json?.fhirVersion?.[0] !== '4') throw unexpected('health check', r);
    },
    async insert(actor, kind, patientId, data, origin) {
      if (origin !== undefined && !/^[A-Za-z0-9._:-]{8,100}$/.test(origin))
        throw fault(422, 'Invalid origin key');
      const createdAt = new Date().toISOString();
      if (!(kind in typeOf)) throw fault(422, `Unsupported record type: ${kind}`);
      const pid = (await patientFor(actor.tenant, patientId, true))!;
      const id = randomUUID();
      const resource = {
        ...toResource(kind, data, pid, {
          origin,
          createdAt,
          rev: 1,
          codeSystems: options.codeSystems,
        }),
        id,
      };
      const r = await call('PUT', `/${typeOf[kind as Kind]}/${id}`, { body: resource });
      if (r.status === 422 || r.status === 400)
        throw fault(422, 'Record not accepted by the FHIR server');
      if (r.status !== 201 || !r.json) throw unexpected('create', r);
      return (await entityOf(r.json, actor.tenant))!;
    },
    async findByOrigin(tenant, patientId, origin) {
      const pid = await patientFor(tenant, patientId, false);
      if (!pid) return undefined;
      for (const type of Object.values(typeOf)) {
        const [hit] = await search(
          `/${type}?patient=${pid}&identifier=${q(`${ORIGIN}|${origin}`)}&_count=2`,
        );
        if (hit) return await entityOf(hit, tenant);
      }
      return undefined;
    },
    async get(tenant, id) {
      return (await read(tenant, id))?.entity;
    },
    async list(tenant, patientId, kind) {
      if (kind !== undefined && !(kind in typeOf))
        throw fault(422, `Unsupported record type: ${kind}`);
      const pid = await patientFor(tenant, patientId, false);
      if (!pid) return [];
      const types = kind ? [typeOf[kind as Kind]] : Object.values(typeOf);
      const out: Entity[] = [];
      for (const type of types)
        for (const res of await search(`/${type}?patient=${pid}&_count=100`)) {
          const e = await entityOf(res, tenant);
          if (e) out.push(e);
        }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    async revise(actor, entity, version, data, action) {
      void action;
      if (actor.tenant !== entity.tenant) throw fault(403, 'Tenant does not match the record.');
      const stale = () => fault(409, 'Record changed. Reload before saving.');
      const found = await read(actor.tenant, entity.id);
      if (!found || !Number.isSafeInteger(version) || version < 1) throw stale();
      const { res, entity: current } = found;
      if (current.version !== version || entity.version !== version) throw stale();
      // FHIR has no per-version lock, so the adapter enforces the immutability Eir requires.
      if (current.kind === 'note' && current.data.status === 'signed')
        throw fault(409, 'Signed note is immutable');
      const pid = String(res.subject.reference).slice(8);
      const resource = {
        ...toResource(current.kind, data, pid, {
          origin: fromResource(res).origin,
          codeSystems: options.codeSystems,
          createdAt: current.createdAt,
          rev: version + 1,
        }),
        id: current.id,
      };
      const r = await call('PUT', `/${res.resourceType}/${current.id}`, {
        body: resource,
        headers: { 'if-match': `W/"${version}"` },
      });
      if (r.status === 409 || r.status === 412) throw stale();
      if (r.status === 422 || r.status === 400)
        throw fault(422, 'Record not accepted by the FHIR server');
      if (![200, 201].includes(r.status)) throw unexpected('update', r);
      // The update response body does not reliably carry the new version, so read the record back.
      const stored = await read(actor.tenant, current.id);
      if (!stored) throw unexpected('read-back', r);
      return stored.entity;
    },
    async history(tenant, id) {
      const found = await read(tenant, id);
      if (!found) return [];
      const entries = await search(`/${found.res.resourceType}/${id}/_history?_count=100`, 1000);
      const ordered = entries.sort((a, b) => Number(a.meta?.versionId) - Number(b.meta?.versionId));
      const out: Entity[] = [];
      for (const res of ordered) {
        const e = await entityOf(res, tenant, { createdAt: found.entity.createdAt });
        if (e) out.push(e);
      }
      return out;
    },
    async vitalSeries(tenant, patientId, code, cap) {
      const pid = await patientFor(tenant, patientId, false);
      if (!pid) return [];
      const rows = await search(
        `/Observation?patient=${pid}&code=${q(`${LOINC}|${code}`)}&_sort=-date&_count=${Math.min(cap, 100)}`,
        cap,
      );
      return rows
        .filter(
          (r) =>
            typeof r.valueQuantity?.value === 'number' && typeof r.effectiveDateTime === 'string',
        )
        .map((r): VitalPoint => ({
          id: String(r.id),
          version: Number(r.meta?.versionId),
          code,
          value: r.valueQuantity.value,
          unit: String(r.valueQuantity.code ?? r.valueQuantity.unit),
          effectiveAt: r.effectiveDateTime,
        }))
        .sort(
          (a, b) =>
            Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || a.id.localeCompare(b.id),
        )
        .slice(0, cap);
    },
    async problems(tenant, patientId, cap) {
      const pid = await patientFor(tenant, patientId, false);
      if (!pid) return [];
      const rows = await search(`/Condition?patient=${pid}&_count=100`, cap);
      return rows
        .filter((r) => r.code?.coding?.[0]?.display)
        .map((r): ProblemRow => {
          const c = r.code.coding[0];
          const onset = r.onsetDateTime ?? r.onsetDate;
          return {
            id: String(r.id),
            version: Number(r.meta?.versionId),
            display: c.display,
            ...(c.code ? { code: c.code } : {}),
            ...(c.system ? { system: fromFhirSystem(c.system, options.codeSystems) } : {}),
            ...(typeof onset === 'string' ? { onset } : {}),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, cap);
    },
  };
  return store;
}
