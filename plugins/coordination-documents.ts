import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { z } from 'zod';
import { assert, type Plugin } from '../packages/contracts.ts';

async function inspectPdf(bytes: Uint8Array) {
  const worker = new Worker(new URL('../packages/pdf-inspector.mjs', import.meta.url), {
    workerData: bytes,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 2000);
      worker.once('message', (result) => resolve(result === true));
      worker.once('error', () => resolve(false));
      worker.once('exit', () => resolve(false));
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

export default {
  id: 'eir.coordination.documents',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['coordinationDocuments'],
  requires: ['store', 'access', 'coordination', 'sipPlans'],
  setup(ctx, config) {
    const settings = z
      .object({
        maxBytes: z.number().int().min(1024).max(65536).default(16384),
        developmentPdfDownloads: z.boolean().default(false),
      })
      .strict()
      .parse(config);
    const store = ctx.get('store'),
      access = ctx.get('access'),
      coordination = ctx.get('coordination'),
      sip = ctx.get('sipPlans');
    ctx.provide('coordinationDocuments', {
      async upload(actor, caseId, input) {
        const parsed = z
          .object({
            name: z.string().regex(/^[\p{L}\p{N} _().-]{1,120}$/u),
            contentType: z.enum(['application/pdf', 'text/plain']),
            base64: z
              .string()
              .min(1)
              .max(Math.ceil(settings.maxBytes / 3) * 4),
          })
          .strict()
          .parse(input);
        await coordination.authorize(actor, caseId, true);
        const bytes = Buffer.from(parsed.base64, 'base64');
        assert(
          bytes.length > 0 &&
            bytes.length <= settings.maxBytes &&
            bytes.toString('base64') === parsed.base64,
          422,
          'Invalid attachment encoding or size',
        );
        if (parsed.contentType === 'text/plain') {
          assert(
            parsed.name.toLowerCase().endsWith('.txt'),
            422,
            'Text attachment must have a .txt extension',
          );
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            assert(false, 422, 'Text attachment must be UTF-8');
          }
          assert(!bytes.includes(0), 422, 'Binary text attachment rejected');
        } else {
          assert(
            parsed.name.toLowerCase().endsWith('.pdf') &&
              bytes.subarray(0, 5).toString() === '%PDF-',
            422,
            'PDF content required',
          );
          assert(await inspectPdf(bytes), 422, 'Invalid, encrypted or over-limit PDF');
        }
        return store.transaction(async () => {
          const scope = await coordination.authorize(actor, caseId, true);
          const state =
            parsed.contentType === 'application/pdf' && !settings.developmentPdfDownloads
              ? 'quarantined'
              : 'available';
          const row = await store.insert(actor, 'samAttachment', null, {
            caseId,
            ...parsed,
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            state,
            uploadedBy: actor.id,
            unitId: actor.unitId,
          });
          await coordination.event(actor, scope.record, 'attachment.added', parsed.name);
          const { base64, ...data } = row.data;
          return { ...row, data };
        });
      },
      async download(actor, id) {
        return store.transaction(async () => {
          await access.permit(actor, 'coordination.export');
          const row = await store.get(actor.tenant, id);
          assert(row?.kind === 'samAttachment', 404, 'Attachment not found');
          await coordination.authorize(actor, row.data.caseId);
          assert(
            row.data.state === 'available',
            409,
            'Attachment is quarantined pending malware review',
          );
          const bytes = Buffer.from(row.data.base64, 'base64');
          assert(
            createHash('sha256').update(bytes).digest('hex') === row.data.sha256,
            503,
            'Attachment integrity check failed',
          );
          await store.audit(actor, 'coordination.attachment-downloaded', undefined, id);
          return { name: row.data.name, contentType: row.data.contentType, bytes };
        });
      },
      async export(actor, caseId) {
        const snapshot = await store.transaction(async () => {
          await access.permit(actor, 'coordination.export');
          const detail = await coordination.detail(actor, caseId);
          assert(detail.consentActive, 403, 'Active consent required');
          const plan = await sip.get(actor, caseId);
          await store.audit(actor, 'coordination.pdf-export', undefined, caseId);
          return { detail, plan };
        });
        const doc = await PDFDocument.create(),
          font = await doc.embedFont(StandardFonts.Helvetica);
        let page = doc.addPage([595, 842]),
          y = 797;
        const line = (value: string) => {
          // Standard Helvetica supports Swedish; unsupported glyphs are explicitly replaced.
          const safe = Array.from(value)
            .map((c) => {
              if (c === '\n') return c;
              try {
                font.encodeText(c);
                return c;
              } catch {
                return '?';
              }
            })
            .join('');
          for (const paragraph of safe.split('\n')) {
            let part = '';
            for (const char of paragraph) {
              if (font.widthOfTextAtSize(part + char, 10) > 505) {
                draw(part);
                part = '';
              }
              part += char;
            }
            draw(part);
          }
        };
        const draw = (value: string) => {
          if (y < 45) {
            page = doc.addPage([595, 842]);
            y = 797;
          }
          page.drawText(value, { x: 45, y, size: 10, font });
          y -= 15;
        };
        const { detail, plan } = snapshot,
          r = detail.record;
        line('Eir Samverkan - ärendeutdrag');
        line(r.data.patient.name);
        line(r.data.patient.identifier.value);
        line(r.data.title);
        line(`Ärende ${caseId} | Version ${r.version} | ${new Date().toISOString()}`);
        line('');
        for (const m of detail.messages) {
          line(`${m.data.sentAt} | ${m.data.type} | ${m.data.status}`);
          line(m.data.body);
          line(`Från: ${m.data.senderUnitId} | Till: ${m.data.recipients.join(', ')}`);
          if (m.data.status === 'withdrawn') line(`Makulerat: ${m.data.reason}`);
          line('');
        }
        if (plan) {
          line(`SIP | ${plan.data.status} | Version ${plan.version}`);
          const f = plan.data.fields;
          line(f.patientPriorities);
          line(f.participation);
          line(`${f.meetingAt} | ${f.location}`);
          for (const p of f.participants) line(`${p.name} | ${p.role}`);
          for (const g of f.goals) {
            line(`Behov: ${g.need}`);
            line(`Mål: ${g.goal}`);
            line(`Insats: ${g.intervention}`);
            line(`Ansvar: ${g.responsibleUnitId} | ${g.dueOn} | ${g.status}`);
            line(g.followUp);
            line('');
          }
          line(`Uppföljning: ${f.followUpOn}`);
          for (const [unit, confirmation] of Object.entries(plan.data.confirmations)) {
            const c = confirmation as { actorId: string; at: string };
            line(`Bekräftat: ${unit} | ${c.actorId} | ${c.at}`);
          }
        }
        if (detail.payment) {
          const payment = detail.payment;
          line(`Preliminär betalningsberäkning | ${payment.policyVersion}`);
          line(
            payment.status === 'estimate'
              ? `${payment.startOn} till ${payment.endOn} | ${payment.days} dagar | ${payment.amountOre / 100} SEK`
              : payment.reasons.join('; '),
          );
          line(
            payment.developmentOnly
              ? 'Exempelavtal. Inte faktureringsunderlag.'
              : 'Preliminär beräkning. Kräver behörig granskning.',
          );
        }
        line('Utdraget omfattar endast information som den exporterande enheten har åtkomst till.');
        return {
          name: `eir-samverkan-${caseId}.pdf`,
          contentType: 'application/pdf',
          bytes: await doc.save(),
        };
      },
    });
  },
} satisfies Plugin;
