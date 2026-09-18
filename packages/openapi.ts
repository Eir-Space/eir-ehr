import { z } from 'zod';
import { patientInput, inputs } from '../plugins/clinical.ts';
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
export function openApi() {
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
      security: [{ bearerAuth: [] }],
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
  route('/patients', 'get', 'Authorized patient directory');
  route('/patients', 'post', 'Register a patient', schema(patientInput), '201');
  route('/patients/{id}/chart', 'get', 'Authorized chart');
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
    enum: ['save', 'sign', 'amend', 'close', 'complete', 'correct'],
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
    'Grant expiring development-policy access',
    schema(
      z
        .object({
          actorId: z.string().min(1).max(100),
          role: z.enum(['clinician', 'proxy']),
          expires: z.iso.datetime({ offset: true }),
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
  route('/audit', 'get', 'Authorized access audit');
  return {
    openapi: '3.1.0',
    info: { title: 'Eir EHR clinical API', version: '0.1.0' },
    servers: [{ url: '/api' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}
