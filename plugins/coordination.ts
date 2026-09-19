import { z } from 'zod';
import { assert, Fault, type Actor, type Entity, type Plugin } from '../packages/contracts.ts';
import {
  caseInput,
  consentInput,
  messageInput,
  caseActionInput,
  reason,
  type Coordination,
  type CaseScope,
} from '../packages/coordination.ts';
import { entityQuery, type EntityQuery } from '../packages/entity-query.ts';

const now = () => new Date().toISOString();
const stageKinds = ['admission', 'discharge-ready', 'discharge', 'interruption'];
export default {
  id: 'eir.coordination',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['coordination'],
  requires: ['store', 'access', 'modules', 'coordinationDirectory', 'coordinationPayment'],
  setup(ctx) {
    const store = ctx.get('store'),
      access = ctx.get('access'),
      modules = ctx.get('modules'),
      directory = ctx.get('coordinationDirectory'),
      payment = ctx.get('coordinationPayment');
    assert(store.searchEntities, 503, 'Coordination requires bounded search');
    const search = store.searchEntities.bind(store);
    const all = async (tenant: string, kind: string, equals: Record<string, string | boolean>) => {
      const result: Entity[] = [];
      let after: EntityQuery['after'];
      while (true) {
        const batch = await search(tenant, kind, { equals, limit: 100, after });
        result.push(...batch);
        assert(
          result.length <= 1000,
          409,
          'Case exceeds the interactive record limit; archive/export tooling is required',
        );
        if (batch.length < 100) return result;
        after = { createdAt: batch.at(-1)!.createdAt, id: batch.at(-1)!.id };
      }
    };
    const unit = async (actor: Actor, write = false) => {
      assert(actor.role === 'clinician' && actor.unitId, 403, 'Active staff assignment required');
      await access.permit(actor, write ? 'coordination.write' : 'coordination.read');
      const u = directory.unit(actor.tenant, actor.unitId);
      assert(u, 403, 'Unit is not in this coordination network');
      if (write)
        assert(
          (await modules.state(actor.tenant, u.id, 'coordination')).enabled,
          409,
          'Enable Eir Samverkan for this unit first',
        );
      return u;
    };
    const consentFor = (r: Entity, id: string) =>
      r.data.consent?.granted &&
      r.data.consent.validUntil > now() &&
      r.data.consent.unitIds.includes(id);
    const service: Coordination = {
      async authorize(actor, id, write = false, requireConsent = true) {
        const u = await unit(actor, write),
          record = await store.get(actor.tenant, id);
        assert(record?.kind === 'samCase', 404, 'Case not found');
        const parties = await all(actor.tenant, 'samParty', { caseId: id, active: true });
        const party = parties.find((p) => p.data.unitId === u.id);
        assert(party, 403, 'Unit is not an active case participant');
        assert(!write || !party.data.readOnly, 403, 'Case access is read-only');
        const source = await store.get(actor.tenant, record.data.sourcePatientId);
        assert(
          source?.kind === 'patient' &&
            !source.data.protectedIdentity &&
            !(await store.isBlocked(actor.tenant, source.id)),
          403,
          'Patient sharing is restricted',
        );
        const consent = !!consentFor(record, u.id);
        assert(
          consent || (!requireConsent && record.data.ownerUnitId === u.id),
          403,
          'Active scoped consent is required for case sharing',
        );
        return { record, party, unit: u, parties, consent };
      },
      async event(actor, record, type, note) {
        return store.insert(actor, 'samEvent', null, {
          caseId: record.id,
          type,
          note,
          author: actor.id,
          unitId: actor.unitId,
          at: now(),
        });
      },
      async publish(actor, scope, data, recipients) {
        assert(
          recipients.length && new Set(recipients).size === recipients.length,
          422,
          'Choose distinct recipient units',
        );
        for (const id of recipients)
          assert(
            id !== actor.unitId &&
              scope.parties.some((p) => p.data.unitId === id) &&
              consentFor(scope.record, id),
            403,
            'Recipient is outside the consented case',
          );
        const message = await store.insert(actor, 'samMessage', null, {
          ...data,
          caseId: scope.record.id,
          caseVersion: scope.record.version,
          senderUnitId: actor.unitId,
          author: actor.id,
          sentAt: now(),
          recipients,
          status: 'sent',
        });
        for (const id of recipients) {
          await store.insert(actor, 'samReceipt', null, {
            caseId: scope.record.id,
            messageId: message.id,
            unitId: id,
            status: 'unread',
            acknowledgedAt: null,
            acknowledgedBy: null,
          });
          const recipient = directory.unit(actor.tenant, id)?.notificationRecipient;
          await store.insert(actor, 'samNotification', null, {
            caseId: scope.record.id,
            messageId: message.id,
            unitId: id,
            status: recipient ? 'pending' : 'not-configured',
            recipient: recipient ?? null,
            attempts: 0,
            availableAt: now(),
          });
        }
        await service.event(actor, scope.record, 'message.sent', data.type);
        return message;
      },
      async workspace(actor, input = {}) {
        const parsed = z
          .object({
            after: z.string().max(1000).optional(),
            status: z.enum(['open', 'closed']).default('open'),
          })
          .strict()
          .parse(input);
        const u = await unit(actor);
        let after: EntityQuery['after'];
        if (parsed.after) {
          try {
            after = entityQuery.shape.after
              .unwrap()
              .parse(JSON.parse(Buffer.from(parsed.after, 'base64url').toString()));
          } catch {
            assert(false, 422, 'Invalid case cursor');
          }
        }
        return store.transaction(async () => {
          await unit(actor);
          const links = await search(actor.tenant, 'samParty', {
            equals: { unitId: u.id, active: true },
            after,
            limit: 50,
          });
          const items = [];
          for (const link of links) {
            let scope: CaseScope;
            try {
              scope = await service.authorize(actor, link.data.caseId, false, false);
            } catch (error) {
              if (error instanceof Fault && [403, 404].includes(error.status)) continue;
              throw error;
            }
            if (scope.record.data.status !== parsed.status) continue;
            const receipts = scope.consent
              ? await all(actor.tenant, 'samReceipt', {
                  caseId: scope.record.id,
                  unitId: u.id,
                  status: 'unread',
                })
              : [];
            const { sourcePatientId, ...data } = scope.record.data;
            items.push({
              ...scope.record,
              data,
              unread: receipts.length,
              consentActive: scope.consent,
            });
          }
          await store.audit(actor, 'coordination.inbox');
          return {
            items,
            enabled: (await modules.state(actor.tenant, u.id, 'coordination')).enabled,
            unit: u.name,
            units: directory
              .units(actor.tenant)
              .map(({ notificationRecipient, ...value }) => value),
            nextCursor:
              links.length === 50
                ? Buffer.from(
                    JSON.stringify({ createdAt: links.at(-1)!.createdAt, id: links.at(-1)!.id }),
                  ).toString('base64url')
                : null,
          };
        });
      },
      async report(actor, query) {
        return store.transaction(async () => {
          await access.permit(actor, 'coordination.export');
          const page = await service.workspace(actor, query);
          const rows = [
            ['Patient', 'Ärende', 'Process', 'Status', 'Okvitterade'],
            ...page.items.map((r: any) => [
              r.data.patient.name,
              r.data.title,
              r.data.pathway,
              r.data.status,
              r.unread,
            ]),
          ];
          const csv = rows
            .map((row) =>
              row
                .map((value: unknown) => {
                  let cell = String(value);
                  if (/^[\s]*[=+@-]/u.test(cell) || /^[\t\r\n]/u.test(cell)) cell = "'" + cell;
                  return '"' + cell.replaceAll('"', '""') + '"';
                })
                .join(';'),
            )
            .join('\r\n');
          await store.audit(actor, 'coordination.inbox-export');
          return {
            name: 'samverkan-arenden-denna-sida.csv',
            contentType: 'text/csv;charset=utf-8',
            base64: Buffer.from('\uFEFF' + csv).toString('base64'),
          };
        });
      },
      async create(actor, input) {
        const parsed = caseInput.parse(input);
        return store.transaction(async () => {
          const u = await unit(actor, true);
          await access.permit(actor, 'chart.read', parsed.patientId);
          const patient = await store.get(actor.tenant, parsed.patientId);
          assert(
            patient?.kind === 'patient' && !patient.data.protectedIdentity,
            403,
            'Protected identities cannot be shared by this module',
          );
          const ids = [...new Set([u.id, ...parsed.participants])];
          assert(
            ids.length >= 2 && ids.every((id) => directory.unit(actor.tenant, id)),
            422,
            'Choose at least two configured units',
          );
          const row = await store.insert(actor, 'samCase', null, {
            sourcePatientId: patient.id,
            patient: {
              name: patient.data.name,
              identifier: patient.data.identifier,
              birthDate: patient.data.birthDate,
            },
            pathway: parsed.pathway,
            title: parsed.title,
            ownerUnitId: u.id,
            status: 'open',
            phase: 'open',
            consent: { granted: false, unitIds: [], validUntil: null },
            contact: null,
            outpatientAvailable: false,
            sipRequired: parsed.pathway !== 'outpatient',
          });
          for (const id of ids)
            await store.insert(actor, 'samParty', null, {
              caseId: row.id,
              unitId: id,
              active: true,
              readOnly: false,
            });
          await service.event(actor, row, 'case.created', parsed.title);
          return row;
        });
      },
      async detail(actor, id) {
        return store.transaction(async () => {
          const scope = await service.authorize(actor, id, false, false),
            record = scope.record;
          const messages = scope.consent
            ? (await all(actor.tenant, 'samMessage', { caseId: id })).filter(
                (m) =>
                  m.data.senderUnitId === actor.unitId || m.data.recipients.includes(actor.unitId),
              )
            : [];
          const visible = new Set(messages.map((m) => m.id));
          const receipts = scope.consent
            ? (await all(actor.tenant, 'samReceipt', { caseId: id })).filter((r) =>
                visible.has(r.data.messageId),
              )
            : [];
          const events = scope.consent ? await all(actor.tenant, 'samEvent', { caseId: id }) : [];
          const attachments = scope.consent
            ? (await all(actor.tenant, 'samAttachment', { caseId: id })).map(({ data, ...r }) => ({
                ...r,
                data: {
                  name: data.name,
                  contentType: data.contentType,
                  size: data.size,
                  sha256: data.sha256,
                  state: data.state,
                },
              }))
            : [];
          const notifications = scope.consent
            ? (await all(actor.tenant, 'samNotification', { caseId: id }))
                .filter((r) => visible.has(r.data.messageId))
                .map(({ data, ...r }) => ({
                  ...r,
                  data: { unitId: data.unitId, status: data.status, attempts: data.attempts },
                }))
            : [];
          const { sourcePatientId, ...data } = record.data;
          await store.audit(actor, 'coordination.case-read', undefined, id);
          const billing = await access.context?.(actor);
          return {
            record: { ...record, data },
            parties: scope.parties,
            messages,
            receipts,
            events,
            attachments,
            notifications,
            consentActive: scope.consent,
            readOnly: scope.party.data.readOnly,
            enabled: (await modules.state(actor.tenant, actor.unitId!, 'coordination')).enabled,
            payment:
              scope.consent && billing?.permissions.includes('coordination.billing')
                ? payment.calculate({
                    admissionAt: data.admissionAt,
                    readyAt: data.readyAt,
                    dischargedAt: data.dischargedAt,
                    asOf: now(),
                    invitedAt: data.invitedAt,
                    sipRequired: data.sipRequired,
                    outpatientAvailable: data.outpatientAvailable,
                    interrupted: data.phase === 'interrupted',
                  })
                : null,
          };
        });
      },
      async consent(actor, id, input) {
        const parsed = consentInput.parse(input);
        return store.transaction(async () => {
          const scope = await service.authorize(actor, id, false, false);
          await access.permit(actor, 'coordination.manage');
          assert(!scope.party.data.readOnly, 403, 'Case access is read-only');
          if (parsed.granted) await unit(actor, true);
          assert(
            scope.record.data.ownerUnitId === actor.unitId,
            403,
            'Only the originating unit can record consent',
          );
          assert(
            parsed.unitIds.every((id) => scope.parties.some((p) => p.data.unitId === id)) &&
              parsed.unitIds.includes(actor.unitId!),
            422,
            'Consent scope must contain the originating unit and only active parties',
          );
          if (parsed.granted)
            assert(
              parsed.validUntil &&
                Date.parse(parsed.validUntil) > Date.now() &&
                Date.parse(parsed.validUntil) <= Date.now() + 366 * 86400000,
              422,
              'Consent must expire within one year',
            );
          const row = await store.revise(
            actor,
            scope.record,
            parsed.version,
            {
              ...scope.record.data,
              consent: {
                granted: parsed.granted,
                unitIds: parsed.unitIds,
                validUntil: parsed.validUntil ?? null,
                note: parsed.note,
                recordedBy: actor.id,
                at: now(),
              },
            },
            'coordination.consent',
          );
          await service.event(
            actor,
            row,
            parsed.granted ? 'consent.granted' : 'consent.withdrawn',
            parsed.note,
          );
          return row;
        });
      },
      async action(actor, id, input) {
        const parsed = caseActionInput.parse(input);
        return store.transaction(async () => {
          const scope = await service.authorize(actor, id, true),
            row = scope.record;
          const data = { ...row.data };
          if (parsed.action === 'close') {
            assert(
              row.data.ownerUnitId === actor.unitId || scope.unit.kind === 'municipality',
              403,
              'Originating unit or municipality required',
            );
            assert(
              data.status === 'open' &&
                (data.pathway !== 'inpatient' ||
                  ['discharged', 'interrupted'].includes(data.phase)),
              409,
              'Finish or interrupt the discharge process before closing',
            );
            const outstanding = await all(actor.tenant, 'samReceipt', {
              caseId: id,
              status: 'unread',
            });
            assert(
              !outstanding.some((r) =>
                scope.parties.some((p) => p.data.unitId === r.data.unitId && !p.data.readOnly),
              ),
              409,
              'Unacknowledged messages remain',
            );
            data.status = 'closed';
            data.closedAt = now();
          } else if (parsed.action === 'contact' || parsed.action === 'availability') {
            assert(
              scope.unit.kind === 'primary-care',
              403,
              'The primary-care unit must confirm its own responsibility',
            );
            if (parsed.action === 'contact')
              data.contact = { name: parsed.name, unitId: actor.unitId, recordedAt: now() };
            else data.outpatientAvailable = parsed.available;
          } else {
            await access.permit(actor, 'coordination.manage');
            assert(
              row.data.ownerUnitId === actor.unitId &&
                parsed.unitId !== actor.unitId &&
                directory.unit(actor.tenant, parsed.unitId),
              403,
              'Only the originating unit can change other participants',
            );
            const old = (
              await all(actor.tenant, 'samParty', { caseId: id, unitId: parsed.unitId })
            )[0];
            const next = {
              caseId: id,
              unitId: parsed.unitId,
              active: parsed.active,
              readOnly: parsed.readOnly,
            };
            const plan = (await all(actor.tenant, 'samSip', { caseId: id }))[0];
            if (plan && plan.data.status !== 'closed') {
              assert(
                (parsed.active && !parsed.readOnly) ||
                  (plan.data.coordinatorUnitId !== parsed.unitId &&
                    !plan.data.fields.goals.some(
                      (g: any) => g.responsibleUnitId === parsed.unitId && g.status !== 'completed',
                    )),
                409,
                'Reassign open SIP responsibilities before removing a contributing unit',
              );
              await store.revise(
                actor,
                plan,
                plan.version,
                { ...plan.data, status: 'draft', confirmations: {}, finalizedAt: null },
                'coordination.sip-participants-changed',
              );
            }
            if ((!parsed.active || parsed.readOnly) && data.contact?.unitId === parsed.unitId) {
              data.contact = null;
              data.outpatientAvailable = false;
            }
            if (old) await store.revise(actor, old, old.version, next, 'coordination.participant');
            else await store.insert(actor, 'samParty', null, next);
            if (parsed.active && (!old || !old.data.active))
              data.consent = { ...data.consent, granted: false };
          }
          const updated = await store.revise(
            actor,
            row,
            parsed.version,
            data,
            'coordination.' + parsed.action,
          );
          await service.event(
            actor,
            updated,
            'case.' + parsed.action,
            'reason' in parsed ? parsed.reason : parsed.name,
          );
          return updated;
        });
      },
      async send(actor, id, input) {
        const parsed = messageInput.parse(input);
        return store.transaction(async () => {
          const scope = await service.authorize(actor, id, true),
            row = scope.record,
            data = { ...row.data };
          assert(data.status === 'open', 409, 'Case is closed');
          if (parsed.replyTo) {
            const original = await store.get(actor.tenant, parsed.replyTo);
            assert(
              original?.kind === 'samMessage' &&
                original.data.caseId === id &&
                original.data.status === 'sent' &&
                (original.data.senderUnitId === actor.unitId ||
                  original.data.recipients.includes(actor.unitId)),
              403,
              'Reply target is unavailable',
            );
          }
          if (parsed.effectiveAt)
            assert(
              Date.parse(parsed.effectiveAt) <= Date.now(),
              422,
              'Clinical event time cannot be in the future',
            );
          if (stageKinds.includes(parsed.type)) {
            await access.permit(actor, 'coordination.discharge');
            assert(
              data.pathway === 'inpatient' && scope.unit.kind === 'hospital',
              403,
              'Inpatient messages require the hospital assignment',
            );
            assert(
              scope.parties
                .filter((p) => p.data.unitId !== actor.unitId)
                .every((p) => parsed.recipients.includes(p.data.unitId)),
              422,
              'Send discharge-process events to every other participating unit',
            );
            if (parsed.type === 'admission') {
              assert(
                data.phase === 'open' && parsed.expectedDischargeAt,
                409,
                'Admission requires an open case and expected discharge time',
              );
              data.phase = 'admitted';
              data.admissionAt = now();
              data.expectedDischargeAt = parsed.expectedDischargeAt;
            }
            if (parsed.type === 'discharge-ready') {
              assert(data.phase === 'admitted', 409, 'Patient must be admitted first');
              data.phase = 'ready';
              data.readyAt = now();
            }
            if (parsed.type === 'discharge') {
              assert(
                data.phase === 'ready' && data.contact && data.outpatientAvailable,
                409,
                'Confirm readiness, fixed care contact and outpatient availability',
              );
              data.phase = 'discharged';
              data.dischargedAt = now();
            }
            if (parsed.type === 'interruption') {
              assert(
                ['admitted', 'ready'].includes(data.phase),
                409,
                'No active admission to interrupt',
              );
              data.phase = 'interrupted';
              data.readyAt = null;
            }
          }
          const { version, ...message } = parsed;
          const sent = await service.publish(
            actor,
            scope,
            {
              ...message,
              previousPhase: row.data.phase,
              previousReadyAt: row.data.readyAt ?? null,
            },
            parsed.recipients,
          );
          await store.revise(actor, row, version, data, 'coordination.message-sent');
          return sent;
        });
      },
      async receipt(actor, id, version) {
        return store.transaction(async () => {
          const message = await store.get(actor.tenant, id);
          assert(
            message?.kind === 'samMessage' && message.data.status === 'sent',
            404,
            'Message not found',
          );
          await service.authorize(actor, message.data.caseId, true);
          const receipt = (
            await all(actor.tenant, 'samReceipt', { messageId: id, unitId: actor.unitId! })
          )[0];
          assert(receipt, 403, 'Only a recipient can acknowledge');
          assert(receipt.data.status === 'unread', 409, 'Message is already acknowledged');
          return store.revise(
            actor,
            receipt,
            version,
            {
              ...receipt.data,
              status: 'acknowledged',
              acknowledgedAt: now(),
              acknowledgedBy: actor.id,
            },
            'coordination.acknowledged',
          );
        });
      },
      async voidMessage(actor, id, version, note) {
        reason.parse(note);
        return store.transaction(async () => {
          const message = await store.get(actor.tenant, id);
          assert(
            message?.kind === 'samMessage' && message.data.status === 'sent',
            404,
            'Message not found',
          );
          const scope = await service.authorize(actor, message.data.caseId, true);
          assert(
            message.data.senderUnitId === actor.unitId,
            403,
            'Only the sending unit may retract',
          );
          assert(scope.record.data.status === 'open', 409, 'Case is closed');
          if (stageKinds.includes(message.data.type)) {
            await access.permit(actor, 'coordination.discharge');
            const stages = (
              await all(actor.tenant, 'samMessage', { caseId: scope.record.id, status: 'sent' })
            )
              .filter((m) => stageKinds.includes(m.data.type))
              .sort((a, b) => a.data.caseVersion - b.data.caseVersion);
            assert(stages.at(-1)?.id === id, 409, 'Retract later process events first');
            const data: Record<string, any> = {
              ...scope.record.data,
              phase: message.data.previousPhase,
              readyAt: message.data.previousReadyAt,
            };
            if (message.data.type === 'admission') {
              data.admissionAt = null;
              data.expectedDischargeAt = null;
            }
            if (message.data.type === 'discharge') data.dischargedAt = null;
            await store.revise(
              actor,
              scope.record,
              scope.record.version,
              data,
              'coordination.process-corrected',
            );
          }
          for (const r of await all(actor.tenant, 'samReceipt', {
            messageId: id,
            status: 'unread',
          }))
            await store.revise(
              actor,
              r,
              r.version,
              { ...r.data, status: 'withdrawn' },
              'coordination.receipt-withdrawn',
            );
          await service.event(actor, scope.record, 'message.withdrawn', message.data.type);
          return store.revise(
            actor,
            message,
            version,
            {
              ...message.data,
              status: 'withdrawn',
              reason: note,
              withdrawnAt: now(),
              withdrawnBy: actor.id,
            },
            'coordination.message-withdrawn',
          );
        });
      },
    };
    ctx.provide('coordination', service);
  },
} satisfies Plugin;
