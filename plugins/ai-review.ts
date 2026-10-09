import { z } from 'zod';
import { assert, type Actor, type Entity, type Plugin } from '../packages/contracts.ts';
import { vitals } from './clinical.ts';

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
    .map(evidenceItem);
}
export function evidenceItem(e: Entity) {
  const canonicalVersion = e.data._canonical?.version;
  return {
    ref: `${e.id}@${e.version}${Number.isInteger(canonicalVersion) ? `#canonical-${canonicalVersion}` : ''}`,
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
                ? e.data.code === '85354-9'
                  ? `${e.data.display}: ${e.data.components.map((item: any) => item.value).join('/')} ${e.data.unit} (${e.data.effectiveAt})`
                  : `${e.data.display}: ${e.data.value} ${e.data.unit} (${e.data.effectiveAt})`
                : e.kind === 'condition'
                  ? `${e.data.code.display} (${e.data.code.system}|${e.data.code.code})`
                  : e.kind === 'allergy'
                    ? `Allergi: ${e.data.substance}. Reaktion: ${e.data.reaction}.`
                    : `Kontaktorsak: ${e.data.reason}`,
  };
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
// Optional longitudinal context: earlier readings from other encounters, selected by the verified
// clinical query service. Evidence comes from the authority-resolved chart and is re-resolved before
// storage and acceptance. A canonical repository revision changes both the reference and evidence.
const reviewOptions = z
  .object({
    history: z
      .object({
        codes: z
          .array(z.string().regex(/^\d{1,7}-\d$/))
          .min(1)
          .default(Object.keys(vitals)),
        perCode: z.number().int().min(1).max(20).default(5),
        lookbackDays: z.number().int().min(1).max(3650).default(365),
      })
      .strict()
      .optional(),
  })
  .strict();
type HistorySummary = {
  code: string;
  status: 'ok' | 'unavailable';
  ledger: number;
  served: number;
};
type Candidate = { code: string; entityId: string; version: number };

export default {
  id: 'eir.ai.review',
  version: '1.0.0',
  apiVersion: 2,
  provides: ['aiReview'],
  requires: ['store', 'access', 'clinical', 'aiProvider'],
  optionalRequires: ['clinicalQuery'],
  setup(ctx, config) {
    const options = reviewOptions.parse(config);
    const store = ctx.get('store'),
      access = ctx.get('access'),
      clinical = ctx.get('clinical'),
      provider = ctx.get('aiProvider');
    // Best effort and outside any transaction: an unavailable content store never blocks a proposal.
    const gatherHistory = async (actor: Actor, patientId: string) => {
      const history = options.history;
      if (!history || !ctx.has('clinicalQuery')) return undefined;
      const query = ctx.get('clinicalQuery');
      const from = new Date(Date.now() - history.lookbackDays * 86400000).toISOString();
      const candidates: Candidate[] = [];
      const summary: HistorySummary[] = [];
      for (const code of history.codes) {
        try {
          const answer = await query.vitals(actor, patientId, { code, from, limit: 50 });
          summary.push({
            code,
            status: 'ok',
            ledger: answer.coverage.ledger,
            served: answer.coverage.served,
          });
          for (const p of answer.points)
            candidates.push({ code, entityId: p.entityId, version: p.version });
        } catch {
          summary.push({ code, status: 'unavailable', ledger: 0, served: 0 });
        }
      }
      return { candidates, summary };
    };
    const historyCurrent = (chart: Entity[], items: { ref: string; text: string }[]) => {
      for (const item of items) {
        const entity = chart.find((row) => row.id === item.ref.split('@')[0]);
        if (
          !entity ||
          evidenceItem(entity).ref !== item.ref ||
          entity.data.status === 'entered-in-error' ||
          evidenceItem(entity).text !== item.text
        )
          return false;
      }
      return true;
    };
    const split = (evidence: { ref: string; text: string }[], refs: string[] | undefined) => ({
      base: evidence.filter((e) => !refs?.includes(e.ref)),
      history: evidence.filter((e) => refs?.includes(e.ref)),
    });
    ctx.provide('aiReview', {
      async propose(actor, patientId, encounterId) {
        await access.permit(actor, 'ai.use', patientId);
        const gathered = await gatherHistory(actor, patientId);
        const initialChart = await clinical.chart(actor, patientId);
        const { evidence, historyRefs } = await store.transaction(async () => {
          await access.permit(actor, 'ai.use', patientId);
          const encounter = await store.get(actor.tenant, encounterId);
          assert(
            encounter?.kind === 'encounter' &&
              encounter.patientId === patientId &&
              encounter.data.status === 'in-progress',
            409,
            'Open encounter required',
          );
          const base = evidenceFor(initialChart, encounterId);
          const seen = new Set(base.map((e) => e.ref));
          const perCode = new Map<string, number>();
          const pinned: { ref: string; text: string }[] = [];
          for (const c of gathered?.candidates ?? []) {
            const entity = initialChart.find((row) => row.id === c.entityId);
            if (
              !entity ||
              entity.kind !== 'observation' ||
              entity.patientId !== patientId ||
              entity.version !== c.version ||
              entity.data.status === 'entered-in-error' ||
              entity.data.encounterId === encounterId ||
              (perCode.get(c.code) ?? 0) >= (options.history?.perCode ?? 0)
            )
              continue;
            const item = evidenceItem(entity);
            if (seen.has(item.ref)) continue;
            seen.add(item.ref);
            perCode.set(c.code, (perCode.get(c.code) ?? 0) + 1);
            pinned.push(item);
          }
          const evidence = [...base, ...pinned];
          assert(
            JSON.stringify(evidence).length < 60000,
            422,
            'Evidence exceeds model context limit',
          );
          await store.audit(actor, 'ai.requested', patientId, encounterId);
          return { evidence, historyRefs: pinned.map((e) => e.ref) };
        });
        const output = outputSchema.parse(await provider.generate(structuredClone(evidence)));
        assert(
          output.citations.every((c) =>
            evidence.some((e) => e.ref === c.ref && e.text.includes(c.text)),
          ),
          422,
          'AI returned an invalid source reference or quotation',
        );
        await access.permit(actor, 'ai.use', patientId);
        const currentChart = await clinical.chart(actor, patientId);
        return await store.transaction(async () => {
          await access.permit(actor, 'ai.use', patientId);
          const encounter = await store.get(actor.tenant, encounterId);
          assert(
            encounter?.kind === 'encounter' &&
              encounter.patientId === patientId &&
              encounter.data.status === 'in-progress',
            409,
            'Open encounter required',
          );
          const current = evidenceFor(currentChart, encounterId);
          const parts = split(evidence, historyRefs);
          assert(
            JSON.stringify(current) === JSON.stringify(parts.base) &&
              historyCurrent(currentChart, parts.history),
            409,
            'Clinical context changed; regenerate the proposal',
          );
          return await store.insert(actor, 'proposal', patientId, {
            ...output,
            evidence,
            ...(gathered
              ? {
                  historyRefs,
                  historyContext: {
                    codes: gathered.summary,
                    complete: gathered.summary.every(
                      (c) => c.status === 'ok' && c.served === c.ledger,
                    ),
                  },
                }
              : {}),
            encounterId,
            provider: provider.id,
            status: 'pending',
            requestedBy: actor.id,
          });
        });
      },
      async review(actor, id, version, decision, text) {
        const proposal = await store.get(actor.tenant, id);
        assert(proposal?.kind === 'proposal', 404, 'Proposal not found');
        await access.permit(actor, 'ai.use', proposal.patientId);
        if (decision === 'accept') await access.permit(actor, 'record.write', proposal.patientId);
        assert(['accept', 'reject'].includes(decision), 422, 'Invalid review decision');
        const currentChart =
          decision === 'accept' ? await clinical.chart(actor, proposal.patientId) : undefined;
        return await store.transaction(async () => {
          const proposal = await store.get(actor.tenant, id);
          assert(proposal?.kind === 'proposal', 404, 'Proposal not found');
          await access.permit(actor, 'ai.use', proposal.patientId);
          if (decision === 'accept') await access.permit(actor, 'record.write', proposal.patientId);
          assert(
            proposal.version === version && proposal.data.status === 'pending',
            409,
            'Proposal already reviewed or changed',
          );
          let note: Entity | undefined;
          if (decision === 'accept') {
            const encounter = await store.get(actor.tenant, proposal.data.encounterId);
            assert(encounter?.data.status === 'in-progress', 409, 'Encounter closed');
            const current = evidenceFor(currentChart!, proposal.data.encounterId);
            const parts = split(proposal.data.evidence, proposal.data.historyRefs);
            assert(
              JSON.stringify(current) === JSON.stringify(parts.base) &&
                historyCurrent(currentChart!, parts.history),
              409,
              'Clinical context changed; regenerate the proposal',
            );
            const reviewedText = z
              .string()
              .trim()
              .min(1)
              .max(20000)
              .parse(text ?? proposal.data.text);
            note = await store.insert(actor, 'note', proposal.patientId, {
              text: reviewedText,
              encounterId: proposal.data.encounterId,
              status: 'draft',
              author: actor.id,
              proposalId: proposal.id,
            });
          }
          return await store.revise(
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
