import { z } from 'zod';
import { patientInput, inputs } from '../plugins/clinical.ts';
import { bookingInput } from './care-team.ts';
import { medicationInput, medicationUpdate, reconciliationInput } from './medications.ts';
import { labOrderInput, labReportInput, labReviewInput, labCancelInput } from './laboratories.ts';
import {
  assignmentInput,
  assignmentChange,
  auditReviewInput,
  protectionInput,
  reasonInput,
} from './workforce.ts';
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
export function openApi(clinic = false, secureCookie = false) {
  const paths: Record<string, any> = {};
  function route(
    path: string,
    method: string,
    description: string,
    body?: Record<string, unknown>,
    success = '200',
  ) {
    paths[path] ??= {};
    paths[path][method] = {
      summary: description,
      security: [{ bearerAuth: [] }, ...(clinic ? [{ staffCookie: [] }] : [])],
      parameters: [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
        in: 'path',
        name,
        required: true,
        schema: name === 'id' ? { type: 'string', format: 'uuid' } : { type: 'string' },
      })),
      ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
      responses: {
        [success]: {
          description: 'Success; entity schema and workflows in docs/API.md',
          content: json({}),
        },
        '401': { description: 'Authentication required' },
        '403': { description: 'Access denied' },
        '409': { description: 'Revision or state conflict' },
        '422': { description: 'Invalid input' },
      },
    };
  }
  const schema = (value: z.ZodType) => z.toJSONSchema(value);
  route('/session', 'get', 'Authenticated context');
  route('/logout', 'post', 'Revoke local session', { type: 'object' });
  route('/plugins', 'get', 'Active plugin manifests');
  route('/care-team', 'get', 'Authorized day worklist and patient-scoped task inbox');
  paths['/care-team'].get.parameters = [
    { in: 'query', name: 'day', required: true, schema: { type: 'string', format: 'date' } },
  ];
  route(
    '/patients/{id}/appointments',
    'post',
    'Book a non-overlapping clinic-local appointment',
    schema(bookingInput),
    '201',
  );
  route(
    '/appointments/{id}/{action}',
    'post',
    'Expected-version appointment transition',
    schema(
      z
        .object({
          version: z.number().int().positive(),
          data: z.union([
            bookingInput,
            z.object({ reason: z.string().min(1).max(200) }).strict(),
            z.object({}).strict(),
          ]),
        })
        .strict(),
    ),
  );
  paths['/appointments/{id}/{action}'].post.parameters[1].schema = {
    type: 'string',
    enum: ['arrive', 'start', 'reschedule', 'cancel', 'no-show'],
  };
  route('/terminology/diagnoses', 'get', 'Search the configured diagnosis catalogue');
  paths['/terminology/diagnoses'].get.parameters = [
    { in: 'query', name: 'q', schema: { type: 'string', maxLength: 100, default: '' } },
    {
      in: 'query',
      name: 'limit',
      schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  ];
  route('/patients', 'get', 'Authorized patient directory');
  route('/patients', 'post', 'Register a patient', schema(patientInput), '201');
  route('/patients/{id}/chart', 'get', 'Authorized chart');
  route(
    '/patients/{id}/medications',
    'get',
    'Clinician-only statements and versioned reconciliation snapshot',
  );
  route(
    '/patients/{id}/medications',
    'post',
    'Document medication use; not prescribing or dispensing',
    schema(medicationInput),
    '201',
  );
  route(
    '/patients/{id}/medication-reviews',
    'post',
    'Reconcile exact medication and allergy versions',
    schema(reconciliationInput),
    '201',
  );
  const expected = (data: z.ZodType) =>
    schema(z.object({ version: z.number().int().positive(), data }).strict());
  route(
    '/patients/{id}/permissions',
    'get',
    'Effective patient permissions in the current assignment, or null for legacy policy',
  );
  if (clinic) {
    route(
      '/session/assignment',
      'post',
      'Select an active assignment belonging to this identity',
      schema(z.object({ assignmentId: z.uuid() }).strict()),
    );
    route('/workforce', 'get', 'Staff assignments in the administrative unit');
    route(
      '/workforce',
      'post',
      'Provision an explicitly mapped identity assignment in the current unit',
      schema(assignmentInput),
      '201',
    );
    route(
      '/workforce/{id}',
      'post',
      'Change or revoke another staff assignment with a reason',
      expected(assignmentChange),
    );
    route('/access-review', 'get', 'Unit-scoped audit page with immutable review history');
    paths['/access-review'].get.parameters = [
      { in: 'query', name: 'before', schema: { type: 'integer', minimum: 1 } },
      {
        in: 'query',
        name: 'limit',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
      ...['actorId', 'patientId', 'outcome'].map((name) => ({
        in: 'query',
        name,
        schema: { type: 'string', ...(name === 'outcome' ? { enum: ['success', 'denied'] } : {}) },
      })),
    ];
    route(
      '/access-review',
      'post',
      'Record a hash-bound assessment; no self-review',
      schema(auditReviewInput),
      '201',
    );
    route(
      '/patients/{id}/emergency-access',
      'post',
      'Reasoned 15-minute read-only exception; never overrides protection or restrictions',
      schema(reasonInput),
      '201',
    );
    route(
      '/patients/{id}/protection',
      'post',
      'Update protected identity status with version and reason',
      expected(protectionInput),
    );
  }
  route(
    '/medications/{id}',
    'post',
    'Reasoned medication correction or status change',
    expected(medicationUpdate),
  );
  route(
    '/patients/{id}/lab-orders',
    'post',
    'Create local lab order and owned result follow-up',
    schema(labOrderInput),
    '201',
  );
  route(
    '/lab-orders/{id}/receive',
    'post',
    'Record source-identified result; idempotent source/message ID',
    expected(labReportInput),
  );
  route(
    '/lab-orders/{id}/review',
    'post',
    'Review exact current report and close owned follow-up',
    expected(labReviewInput),
  );
  route(
    '/lab-orders/{id}/cancel',
    'post',
    'Cancel an order before results arrive',
    expected(labCancelInput),
  );
  route(
    '/patients/{id}/records/{kind}',
    'post',
    'Create a clinical record',
    { oneOf: Object.values(inputs).map(schema) },
    '201',
  );
  paths['/patients/{id}/records/{kind}'].post.parameters[1].schema = {
    type: 'string',
    enum: Object.keys(inputs),
  };
  route(
    '/records/{id}/{action}',
    'post',
    'Apply an expected-version transition',
    schema(
      z
        .object({
          version: z.number().int().positive(),
          data: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
    ),
  );
  paths['/records/{id}/{action}'].post.parameters[1].schema = {
    type: 'string',
    enum: [
      'save',
      'sign',
      'amend',
      'close',
      'complete',
      'correct',
      'start',
      'assign',
      'reschedule',
      'cancel',
      'reopen',
    ],
  };
  route('/records/{id}/history', 'get', 'Authorized record versions');
  route('/patients/{id}/changes', 'get', 'Patient-scoped durable changes');
  paths['/patients/{id}/changes'].get.parameters.push({
    in: 'query',
    name: 'after',
    schema: { type: 'integer', minimum: 0, default: 0 },
  });
  route('/patients/{id}/export/fhir', 'get', 'FHIR R4 collection projection');
  paths['/patients/{id}/export/fhir'].get.responses['200'].content = {
    'application/fhir+json': { schema: { type: 'object' } },
  };
  route(
    '/patients/{id}/ai',
    'post',
    'Generate an evidence-linked proposal',
    schema(z.object({ encounterId: z.uuid() }).strict()),
  );
  route(
    '/proposals/{id}/review',
    'post',
    'Review a proposal into a draft or reject',
    schema(
      z
        .object({
          version: z.number().int().positive(),
          decision: z.enum(['accept', 'reject']),
          text: z.string().max(20000).optional(),
        })
        .strict(),
    ),
  );
  route(
    '/patients/{id}/access',
    'post',
    'Grant expiring care relationship; clinic policy requires reason and verified staff assignment',
    schema(
      z
        .object({
          actorId: z.string().min(1).max(100),
          role: z.enum(['clinician', 'proxy']),
          expires: z.iso.datetime({ offset: true }),
          reason: z.string().trim().min(1).max(200).optional(),
        })
        .strict(),
    ),
  );
  route(
    '/patients/{id}/restriction',
    'post',
    'Set patient self-service restriction',
    schema(z.object({ blocked: z.boolean() }).strict()),
  );
  if (!clinic) route('/audit', 'get', 'Authorized access audit (legacy policy)');
  return {
    openapi: '3.1.0',
    info: { title: 'Eir EHR clinical API', version: '0.2.0' },
    servers: [{ url: '/api' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        ...(clinic
          ? {
              staffCookie: {
                type: 'apiKey',
                in: 'cookie',
                name: secureCookie ? '__Host-eir-session' : 'eir-session',
                description:
                  'OIDC profile only; unsafe requests also require the configured Origin',
              },
            }
          : {}),
      },
    },
    paths,
  };
}
