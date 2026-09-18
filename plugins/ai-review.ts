import { z } from 'zod';
import { assert, type Entity, type Plugin } from '../packages/contracts.ts';

export function evidenceFor(chart: Entity[], encounterId: string) {
  const currentReports = new Set(
    chart.filter((r) => r.kind === 'labOrder').map((r) => r.data.reportId),
  );
  return chart
    .filter(
      (e) =>
        [
          'condition',
          'allergy',
          'observation',
          'note',
          'encounter',
          'medication',
          'labReport',
          'labOrder',
        ].includes(e.kind) &&
        e.data.status !== 'entered-in-error' &&
        (e.kind !== 'labReport' || currentReports.has(e.id)) &&
        (['condition', 'allergy', 'medication'].includes(e.kind) ||
          e.id === encounterId ||
          e.data.encounterId === encounterId),
    )
    .map((e) => ({
      ref: `${e.id}@${e.version}`,
      text:
        e.kind === 'medication'
          ? `Dokumenterad läkemedelsanvändning: ${e.data.name}. Status: ${e.data.status}. Dosering: ${e.data.dosageText ?? 'okänd'}. Källa: ${e.data.source} (${e.data.sourceDetail}). Inte ett recept eller expedieringsbevis.`
          : e.kind === 'labOrder'
            ? `Provbeställning: ${e.data.test}. Status: ${e.data.status}. Frågeställning: ${e.data.question}.`
            : e.kind === 'labReport'
              ? `Provsvar från ${e.data.source}, ${e.data.reportedAt}: ${e.data.results.map((r: any) => `${r.name}: ${r.value} ${r.unit}; referens: ${r.reference || 'saknas'}; markering från källan: ${r.flag}`).join('. ')}. Svarsversion: ${e.data.messageId}.`
              : e.kind === 'note'
                ? String(e.data.text)
                : e.kind === 'observation'
                  ? `${e.data.display}: ${e.data.value} ${e.data.unit} (${e.data.effectiveAt})`
                  : e.kind === 'condition'
                    ? `${e.data.code.display} (${e.data.code.system}|${e.data.code.code})`
                    : e.kind === 'allergy'
                      ? `Allergi: ${e.data.substance}. Reaktion: ${e.data.reaction}.`
                      : `Kontaktorsak: ${e.data.reason}`,
    }));
}
const outputSchema = z
  .object({
    text: z.string().trim().min(1).max(20000),
    model: z.string().min(1),
    mode: z.enum(['extractive', 'model']),
    citations: z
      .array(z.object({ ref: z.string(), text: z.string().min(1) }))
      .min(1)
      .max(100),
  })
  .strict();
export default {
  id: 'eir.ai.review',
  version: '1.0.0',
  apiVersion: 1,
  provides: ['aiReview'],
  requires: ['store', 'access', 'clinical', 'aiProvider'],
  setup(ctx) {
    const store = ctx.get('store'),
      access = ctx.get('access'),
      clinical = ctx.get('clinical'),
      provider = ctx.get('aiProvider');
    ctx.provide('aiReview', {
      async propose(actor, patientId, encounterId) {
        access.check(actor, patientId, true);
        const encounter = store.get(actor.tenant, encounterId);
        assert(
          encounter?.kind === 'encounter' &&
            encounter.patientId === patientId &&
            encounter.data.status === 'in-progress',
          409,
          'Open encounter required',
        );
        const evidence = evidenceFor(clinical.chart(actor, patientId), encounterId);
        assert(
          JSON.stringify(evidence).length < 60000,
          422,
          'Evidence exceeds model context limit',
        );
        store.audit(actor, 'ai.requested', patientId, encounterId);
        const output = outputSchema.parse(await provider.generate(structuredClone(evidence)));
        assert(
          output.citations.every((c) =>
            evidence.some((e) => e.ref === c.ref && e.text.includes(c.text)),
          ),
          422,
          'AI returned an invalid source reference or quotation',
        );
        access.check(actor, patientId, true);
        return store.transaction(() =>
          store.insert(actor, 'proposal', patientId, {
            ...output,
            evidence,
            encounterId,
            provider: provider.id,
            status: 'pending',
            requestedBy: actor.id,
          }),
        );
      },
      review(actor, id, version, decision, text) {
        const proposal = store.get(actor.tenant, id);
        assert(proposal?.kind === 'proposal', 404, 'Proposal not found');
        access.check(actor, proposal.patientId, true);
        assert(
          proposal.version === version && proposal.data.status === 'pending',
          409,
          'Proposal already reviewed or changed',
        );
        assert(['accept', 'reject'].includes(decision), 422, 'Invalid review decision');
        return store.transaction(() => {
          let note: Entity | undefined;
          if (decision === 'accept') {
            const encounter = store.get(actor.tenant, proposal.data.encounterId);
            assert(encounter?.data.status === 'in-progress', 409, 'Encounter closed');
            const current = evidenceFor(
              store.list(actor.tenant, proposal.patientId),
              proposal.data.encounterId,
            );
            assert(
              JSON.stringify(current) === JSON.stringify(proposal.data.evidence),
              409,
              'Clinical context changed; regenerate the proposal',
            );
            const reviewedText = z
              .string()
              .trim()
              .min(1)
              .max(20000)
              .parse(text ?? proposal.data.text);
            note = store.insert(actor, 'note', proposal.patientId, {
              text: reviewedText,
              encounterId: proposal.data.encounterId,
              status: 'draft',
              author: actor.id,
              proposalId: proposal.id,
            });
          }
          return store.revise(
            actor,
            proposal,
            version,
            {
              ...proposal.data,
              status: decision === 'accept' ? 'accepted' : 'rejected',
              reviewedBy: actor.id,
              reviewedAt: new Date().toISOString(),
              noteId: note?.id ?? null,
            },
            `ai.${decision}`,
          );
        });
      },
    });
  },
} satisfies Plugin;
