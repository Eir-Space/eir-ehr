import { z } from 'zod';
import type { Actor, Entity } from './contracts.ts';

export const text = z.string().trim().min(1).max(2000);
export const reason = z.string().trim().min(5).max(1000);
export const revision = z.number().int().positive();
export const unitId = z.string().min(1).max(200);
export const instant = z.iso.datetime({ offset: true });
export const caseInput = z
  .object({
    patientId: z.uuid(),
    pathway: z.enum(['inpatient', 'outpatient', 'sip']),
    title: text.max(160),
    participants: z.array(unitId).min(1).max(10),
  })
  .strict();
export const consentInput = z
  .object({
    version: revision,
    granted: z.boolean(),
    validUntil: instant.optional(),
    unitIds: z.array(unitId).min(1).max(10),
    note: reason,
  })
  .strict();
export const messageKinds = [
  'care-request',
  'admission',
  'planning',
  'discharge-ready',
  'discharge',
  'care-transfer',
  'administrative',
  'referral',
  'interruption',
] as const;
export const messageInput = z
  .object({
    version: revision,
    type: z.enum(messageKinds),
    body: text.max(8000),
    recipients: z.array(unitId).min(1).max(10),
    replyTo: z.uuid().optional(),
    expectedDischargeAt: instant.optional(),
    effectiveAt: instant.optional(),
  })
  .strict();
export const caseActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('close'), version: revision, reason }).strict(),
  z.object({ action: z.literal('contact'), version: revision, name: text.max(200) }).strict(),
  z
    .object({
      action: z.literal('availability'),
      version: revision,
      available: z.boolean(),
      reason,
    })
    .strict(),
  z
    .object({
      action: z.literal('participant'),
      version: revision,
      unitId,
      active: z.boolean(),
      readOnly: z.boolean(),
      reason,
    })
    .strict(),
]);
export const sipFields = z
  .object({
    patientPriorities: text,
    participation: text,
    meetingAt: instant,
    location: text.max(300),
    followUpOn: z.iso.date(),
    participants: z
      .array(
        z
          .object({
            name: text.max(200),
            role: z.enum(['patient', 'relative', 'staff']),
            unitId: unitId.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    goals: z
      .array(
        z
          .object({
            need: text,
            goal: text,
            intervention: text,
            responsibleUnitId: unitId,
            dueOn: z.iso.date(),
            status: z.enum(['planned', 'ongoing', 'completed']),
            followUp: z.string().trim().max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export const sipSaveInput = z
  .object({ version: z.number().int().nonnegative(), fields: sipFields, reason })
  .strict();
export const sipActionInput = z
  .object({
    version: revision,
    action: z.enum(['invite', 'accept', 'finalize', 'reopen', 'close']),
    reason,
  })
  .strict();
export type CoordinationUnit = {
  id: string;
  tenant: string;
  name: string;
  organisationId: string;
  organisationName: string;
  kind: 'hospital' | 'primary-care' | 'municipality';
  notificationRecipient?: string;
};
export interface CoordinationDirectory {
  units(tenant: string): CoordinationUnit[];
  unit(tenant: string, id: string): CoordinationUnit | undefined;
}
export type CaseScope = {
  record: Entity;
  party: Entity;
  unit: CoordinationUnit;
  parties: Entity[];
  consent: boolean;
};
export interface Coordination {
  workspace(actor: Actor, query?: unknown): Promise<Record<string, any>>;
  report(
    actor: Actor,
    query?: unknown,
  ): Promise<{ name: string; contentType: string; base64: string }>;
  create(actor: Actor, input: unknown): Promise<Entity>;
  detail(actor: Actor, id: string): Promise<Record<string, any>>;
  authorize(
    actor: Actor,
    id: string,
    write?: boolean,
    requireConsent?: boolean,
  ): Promise<CaseScope>;
  consent(actor: Actor, id: string, input: unknown): Promise<Entity>;
  action(actor: Actor, id: string, input: unknown): Promise<Entity>;
  send(actor: Actor, id: string, input: unknown): Promise<Entity>;
  receipt(actor: Actor, id: string, version: number): Promise<Entity>;
  voidMessage(actor: Actor, id: string, version: number, reason: string): Promise<Entity>;
  publish(
    actor: Actor,
    scope: CaseScope,
    data: Record<string, any>,
    recipients: string[],
  ): Promise<Entity>;
  event(actor: Actor, record: Entity, type: string, note: string): Promise<Entity>;
}
export interface SipPlans {
  get(actor: Actor, caseId: string): Promise<Entity | null>;
  save(actor: Actor, caseId: string, input: unknown): Promise<Entity>;
  action(actor: Actor, caseId: string, input: unknown): Promise<Entity>;
}
export type PaymentFacts = {
  admissionAt?: string;
  readyAt?: string;
  dischargedAt?: string;
  asOf: string;
  invitedAt?: string;
  sipRequired: boolean;
  outpatientAvailable: boolean;
  interrupted: boolean;
};
export interface CoordinationPayment {
  calculate(facts: PaymentFacts): {
    policyVersion: string;
    status: 'blocked' | 'estimate';
    reasons: string[];
    startOn: string | null;
    endOn: string | null;
    days: number;
    amountOre: number;
    currency: 'SEK';
    developmentOnly: boolean;
  };
}
export interface CoordinationDocuments {
  upload(actor: Actor, caseId: string, input: unknown): Promise<Entity>;
  download(
    actor: Actor,
    id: string,
  ): Promise<{ name: string; contentType: string; bytes: Uint8Array }>;
  export(
    actor: Actor,
    caseId: string,
  ): Promise<{ name: string; contentType: string; bytes: Uint8Array }>;
}
export interface CoordinationNotifications {
  runOnce(): Promise<{ delivered: number }>;
}
