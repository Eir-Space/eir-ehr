import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Entity } from './contracts.ts';
import { labOrderInput, labReportInput } from './laboratories.ts';

export const protocol = 'eir.lab.v1' as const;
export const connectorId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const connectedOrderInput = labOrderInput.extend({ connectorId });
export const resultMessage = z
  .object({
    protocol: z.literal(protocol),
    messageId: z.uuid(),
    orderMessageId: z.uuid(),
    orderId: z.uuid(),
    patientId: z.uuid(),
    patientIdentifier: z
      .object({ system: z.string().min(1).max(300), value: z.string().min(1).max(100) })
      .strict(),
    supersedesMessageId: z.uuid().nullable(),
    report: labReportInput.omit({ messageId: true, source: true }),
  })
  .strict();
export type ResultMessage = z.infer<typeof resultMessage>;
export const orderAcknowledgement = z
  .object({
    protocol: z.literal(protocol),
    messageId: z.uuid(),
    orderId: z.uuid(),
    patientId: z.uuid(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['accepted', 'rejected']),
    reasonCode: z
      .enum([
        'unsupported_test',
        'invalid_specimen',
        'invalid_patient',
        'not_authorized',
        'duplicate_order',
        'other',
      ])
      .optional(),
  })
  .strict();
export type OrderAcknowledgement = z.infer<typeof orderAcknowledgement>;
export const orderMessage = z
  .object({
    protocol: z.literal(protocol),
    type: z.literal('lab.order'),
    connectorId,
    messageId: z.uuid(),
    orderId: z.uuid(),
    patientId: z.uuid(),
    patient: z
      .object({
        name: z.string().min(1).max(200),
        birthDate: z.iso.date(),
        identifier: z
          .object({ system: z.string().min(1).max(300), value: z.string().min(1).max(100) })
          .strict(),
      })
      .strict(),
    order: z
      .object({
        test: z.string().min(1).max(200),
        question: z.string().min(1).max(2000),
        specimen: z.string().min(1).max(200),
        priority: z.enum(['routine', 'urgent']),
        orderedAt: z.iso.datetime(),
        requester: z
          .object({ id: z.string().min(1).max(200), unitId: z.string().min(1).max(100) })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type OrderMessage = z.infer<typeof orderMessage>;

// Canonical object-key order makes retries insensitive to JSON property ordering.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const payloadHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const connectorConfig = z
  .object({
    id: connectorId,
    name: z.string().trim().min(1).max(150),
    tenant: z.string().min(1).max(100),
    unitId: z.string().min(1).max(100),
    adapter: z.literal(protocol),
    endpoint: z.url(),
    outboundTokenEnv: envName,
    inboundTokenEnv: envName,
    localDevelopmentOnly: z.boolean().default(false),
  })
  .strict();
export type LabConnector = z.infer<typeof connectorConfig>;
export type DeliveryOutcome =
  | { kind: 'acknowledged'; acknowledgement: OrderAcknowledgement }
  | { kind: 'retry' | 'quarantine'; code: string };
export interface LabTransport {
  readonly protocol: typeof protocol;
  validate(connector: LabConnector): void;
  send(
    connector: LabConnector,
    message: OrderMessage,
    signal: AbortSignal,
  ): Promise<DeliveryOutcome>;
}
export const operationQuery = z
  .object({
    direction: z.enum(['outbox', 'inbox']).default('outbox'),
    connectorId: connectorId.optional(),
    state: z
      .enum(['pending', 'sending', 'retry', 'acknowledged', 'rejected', 'quarantined', 'applied'])
      .optional(),
    after: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const operatorAction = z
  .object({ version: z.number().int().positive(), reason: z.string().trim().min(5).max(500) })
  .strict();
export type IntegrationRow = {
  id: string;
  version: number;
  createdAt: string;
  connectorId: string;
  state: string;
  messageId: string;
  orderId: string;
  attempts: number;
  availableAt: string;
  code: string | null;
};
export interface Integrations {
  delivery(actor: Actor, orderId: string): Promise<IntegrationRow>;
  connectors(actor: Actor): Promise<{ id: string; name: string }[]>;
  order(actor: Actor, patientId: string, input: unknown): Promise<Entity>;
  receive(
    connectorId: string,
    authorization: string,
    input: unknown,
  ): Promise<{
    receiptId: string;
    messageId: string;
    status: 'received';
    payloadHash: string;
  }>;
  receipt(
    connectorId: string,
    authorization: string,
    messageId: string,
  ): Promise<{
    messageId: string;
    state: string;
    code: string | null;
  }>;
  operations(
    actor: Actor,
    query: unknown,
  ): Promise<{
    connectors: { id: string; name: string; recordId: string; version: number; enabled: boolean }[];
    items: IntegrationRow[];
    nextCursor: string | null;
  }>;
  replay(actor: Actor, id: string, input: unknown): Promise<IntegrationRow>;
  connection(actor: Actor, id: string, input: unknown): Promise<void>;
  runOnce(signal?: AbortSignal): Promise<{ attempted: number; applied: number }>;
}
