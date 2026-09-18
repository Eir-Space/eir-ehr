import { escape as e, date } from './renderers/shared.js';

const status = {
  active: 'Pågående',
  'on-hold': 'Pausad',
  stopped: 'Avslutad',
  'entered-in-error': 'Felregistrerad',
  requested: 'Inväntar svar',
  received: 'Ej granskat',
  reviewed: 'Granskat',
  cancelled: 'Avbruten',
};
const source = {
  patient: 'Patientuppgift',
  record: 'Journalunderlag',
  caregiver: 'Närstående / omsorg',
};
const flag = {
  unknown: 'Ej bedömt',
  normal: 'Inom referens',
  high: 'Högt',
  low: 'Lågt',
  critical: 'Kritiskt',
};
const icon = (name) => `<i data-lucide="${name}"></i>`;
const cmd = (action, label, glyph, id = '') =>
  `<button data-action="${action}" data-id="${e(id)}">${icon(glyph)}${label}</button>`;
const input = (name, label, value = '', type = 'text', required = true, max = 200) =>
  `<label>${label}<input aria-label="${label}" name="${name}" type="${type}" value="${e(value)}" ${type === 'datetime-local' ? 'step="1"' : ''} ${required ? 'required' : ''} maxlength="${max}"></label>`;
const text = (name, label, value = '', required = true, max = 2000) =>
  `<label>${label}<textarea aria-label="${label}" name="${name}" ${required ? 'required' : ''} maxlength="${max}">${e(value)}</textarea></label>`;
const select = (name, label, options, value) =>
  `<label>${label}<select name="${name}" aria-label="${label}">${Object.entries(options)
    .map(
      ([id, label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${label}</option>`,
    )
    .join('')}</select></label>`;
const check = (name, label, required = false) =>
  `<label class="workflow-check"><input type="checkbox" name="${name}" ${required ? 'required' : ''}>${label}</label>`;
const snapshot = (chart) =>
  chart
    .filter((r) => ['medication', 'allergy'].includes(r.kind))
    .map((r) => `${r.id}@${r.version}`)
    .sort();
const results = (report) =>
  `<div class="lab-values">${report.data.results.map((r) => `<div class="lab-value"><div><strong>${e(r.name)}</strong><small>Referens: ${e(r.reference || 'Ej angiven')}</small></div><strong>${e(r.value)} <span class="quiet">${e(r.unit)}</span></strong><span class="badge ${r.flag === 'critical' ? 'critical' : ['high', 'low'].includes(r.flag) ? 'draft' : ''}">${flag[r.flag]}</span></div>`).join('')}</div>`;

export function renderMedications(target, chart, memberName) {
  const meds = chart.filter((r) => r.kind === 'medication');
  const review = chart
    .filter((r) => r.kind === 'medicationReview')
    .sort((a, b) => b.data.reviewNumber - a.data.reviewNumber)[0];
  const current =
    review && JSON.stringify(review.data.snapshot) === JSON.stringify(snapshot(chart));
  target.innerHTML = `<div class="toolbar"><h2>Läkemedel</h2><div class="actions">${cmd('med-add', 'Dokumentera läkemedel', 'plus')}${cmd('med-reconcile', 'Stäm av listan', 'clipboard-check')}</div></div>
    <div class="workflow-summary"><div><strong>${current ? 'Listan avstämd' : review ? 'Listan har ändrats efter avstämning' : 'Inte avstämd'}</strong>${review ? `<small>${date(review.createdAt)} · ${e(memberName(review.data.author))}</small>` : ''}</div><span class="badge ${current ? '' : 'draft'}">${current ? 'Avstämd' : 'Avstämning behövs'}</span></div>
    <p class="quiet workflow-caption">Dokumenterad användning · NLL ej ansluten</p>
    ${meds.map((r) => `<article class="medication-row" data-record-id="${r.id}"><div><strong>${e(r.data.name)}</strong><p>${e(r.data.dosageText ?? 'Dosering okänd')}</p><small>${e(r.data.indication || 'Indikation ej angiven')}</small><small>${source[r.data.source]} · ${e(r.data.sourceDetail)}</small></div><span class="badge ${r.data.dosageText === null ? 'draft' : ''}">${status[r.data.status]}</span><div class="actions">${r.data.status !== 'entered-in-error' ? cmd('med-edit', 'Ändra', 'pencil', r.id) : ''}${cmd('history', 'Historik', 'history', r.id)}</div></article>`).join('') || `<p class="empty">${current && review.data.noCurrentMedicines ? 'Inga aktuella läkemedel bekräftat vid avstämningen.' : 'Ingen läkemedelsuppgift registrerad. Aktuell behandling är inte bekräftad.'}</p>`}
    ${review ? `<section class="band medication-review"><h3>Senaste avstämning</h3><p>${e(review.data.note)}</p><small>Underlag: ${e(review.data.source)}</small><small>${review.data.noCurrentMedicines ? 'Inga aktuella läkemedel bekräftades.' : 'Listan inkluderar pågående eller pausad behandling.'}</small></section>` : ''}`;
}

export function renderLabs(target, chart, actorId, memberName, hasEncounter) {
  const orders = chart.filter((r) => r.kind === 'labOrder');
  target.innerHTML = `<div class="toolbar"><h2>Prover och svar</h2>${hasEncounter ? cmd('lab-order', 'Ny provbeställning', 'plus') : ''}</div><p class="quiet workflow-caption">Lokala beställningar · Manuell svarsregistrering</p>${
    orders
      .map((order) => {
        const d = order.data,
          report = chart.find((r) => r.id === d.reportId),
          review = chart.find((r) => r.id === d.reviewId && r.data.reportId === d.reportId);
        const task = chart.find((r) => r.kind === 'task' && r.data.linkedOrderId === order.id);
        const owner = task?.data.assigneeId === actorId;
        const oldReports = chart.filter(
          (r) => r.kind === 'labReport' && r.data.orderId === order.id && r.id !== d.reportId,
        );
        return `<section class="lab-order band" data-record-id="${order.id}"><div class="section-title"><div><h3>${e(d.test)}</h3><small>${e(d.specimen)} · ${e(memberName(task?.data.assigneeId))} · Senast ${e(task?.data.due ?? d.due)}</small></div><span class="badge ${d.critical && d.status === 'received' ? 'critical' : d.status === 'received' ? 'draft' : ''}">${d.critical && d.status === 'received' ? 'Kritiskt · ej granskat' : status[d.status]}</span></div><p>${e(d.question)}</p>
      ${report ? `${results(report)}<small>${e(report.data.source)} · Svar ${e(report.data.messageId)} · Prov taget ${date(report.data.collectedAt)}</small>${report.data.correctionReason ? `<p class="correction-note">Rättat svar: ${e(report.data.correctionReason)}</p>` : ''}` : '<p class="empty">Inget svar registrerat.</p>'}
      ${d.status === 'reviewed' && review ? `<div class="review-note"><strong>Granskat ${date(review.createdAt)} · ${e(memberName(review.data.author))}</strong><p>${e(review.data.assessment)}</p><p>Åtgärd: ${e(review.data.action)}</p><p>Kommunikation: ${e(review.data.communication)}</p></div>` : ''}
      <div class="actions">${d.status !== 'cancelled' ? cmd('lab-receive', report ? 'Registrera rättat svar' : 'Registrera provsvar', 'flask-conical', order.id) : ''}${d.status === 'received' && owner ? cmd('lab-review', 'Granska och åtgärda', 'check-check', order.id) : ''}${d.status === 'requested' && owner ? cmd('lab-cancel', 'Avbryt beställning', 'x', order.id) : ''}${cmd('lab-history', 'Historik', 'history', order.id)}</div>
      ${oldReports.length ? `<details class="evidence"><summary>${oldReports.length} ersatta svar</summary>${oldReports.map((r) => `<div class="history-row"><strong>Ersatt · ${e(r.data.messageId)}</strong>${results(r)}</div>`).join('')}</details>` : ''}</section>`;
      })
      .join('') || '<p class="empty">Inga provbeställningar.</p>'
  }`;
}

export async function workflowAction(name, id, ctx) {
  const { chart, patientId, encounterId, actorId, memberName, memberSelect, api, modal } = ctx;
  const row = chart.find((r) => r.id === id);
  const clientId = crypto.randomUUID();
  if (name === 'med-add' || name === 'med-edit') {
    const d = row?.data ?? { status: 'active', source: 'patient' };
    modal(
      name === 'med-add' ? 'Dokumentera läkemedel' : 'Ändra läkemedelsuppgift',
      input('name', 'Läkemedel och styrka', d.name) +
        text('dosageText', 'Dosering enligt underlag', d.dosageText ?? '', false, 500) +
        input('indication', 'Indikation', d.indication, 'text', false, 500) +
        select(
          'status',
          'Användning',
          Object.fromEntries(Object.entries(status).slice(0, 4)),
          d.status,
        ) +
        select('source', 'Uppgiftskälla', source, d.source) +
        text('sourceDetail', 'Underlag / uppgiftslämnare', d.sourceDetail, true, 500) +
        (row ? text('reason', 'Orsak till ändring', '', true, 500) : '') +
        check('confirmed', 'Jag har kontrollerat uppgiften mot underlaget', true),
      (values) => {
        const { confirmed, ...data } = values;
        return row
          ? api(`/medications/${id}`, {
              version: row.version,
              data: { ...data, dosageText: data.dosageText.trim() || null },
            })
          : api(`/patients/${patientId}/medications`, {
              ...data,
              dosageText: data.dosageText.trim() || null,
              clientId,
            });
      },
    );
  } else if (name === 'med-reconcile') {
    const meds = chart.filter(
      (r) => r.kind === 'medication' && ['active', 'on-hold'].includes(r.data.status),
    );
    const allergies = chart.filter((r) => r.kind === 'allergy' && r.data.status === 'active');
    modal(
      'Stäm av läkemedelslistan',
      `<div class="reconciliation-list">${meds.map((r) => `<p><strong>${e(r.data.name)}</strong> · ${status[r.data.status]}<br>${e(r.data.dosageText ?? 'Dosering okänd')}</p>`).join('') || '<p>Inga aktuella läkemedel dokumenterade.</p>'}<h3>Överkänslighet</h3>${allergies.map((r) => `<p>${e(r.data.substance)}: ${e(r.data.reaction)}</p>`).join('') || '<p>Uppgift saknas. Allergifrihet är inte bekräftad.</p>'}</div>` +
        text('source', 'Underlag för avstämning', '', true, 500) +
        text('note', 'Avstämning och kvarstående frågor') +
        (!meds.length
          ? check(
              'noCurrentMedicines',
              'Jag bekräftar att patienten inte har några aktuella läkemedel',
              true,
            )
          : '') +
        check('confirmed', 'Jag har gått igenom läkemedel och överkänslighet', true),
      (values) =>
        api(`/patients/${patientId}/medication-reviews`, {
          ...values,
          clientId,
          snapshot: snapshot(chart),
          confirmed: values.confirmed === 'on',
          noCurrentMedicines: values.noCurrentMedicines === 'on',
        }),
      'Bekräfta avstämning',
    );
  } else if (name === 'lab-order') {
    modal(
      'Ny provbeställning',
      input('test', 'Analys / undersökning') +
        text('question', 'Frågeställning') +
        input('specimen', 'Provmaterial') +
        memberSelect('assigneeId', 'Svarsansvarig', actorId) +
        input('due', 'Svar bevakas senast', '', 'date') +
        select('priority', 'Prioritet', { routine: 'Normal', urgent: 'Hög' }, 'routine'),
      (values) => api(`/patients/${patientId}/lab-orders`, { ...values, clientId, encounterId }),
      'Skapa beställning',
    );
  } else if (name === 'lab-cancel') {
    modal('Avbryt provbeställning', text('reason', 'Orsak', '', true, 500), (values) =>
      api(`/lab-orders/${id}/cancel`, { version: row.version, data: values }),
    );
  } else if (name === 'lab-receive') {
    const previous = chart.find((r) => r.id === row.data.reportId);
    const now = new Date().toISOString().slice(0, 19);
    modal(
      previous ? 'Registrera rättat svar' : 'Registrera provsvar',
      `<p><strong>${e(row.data.test)}</strong> · ${e(row.data.specimen)}</p>` +
        input('source', 'Svarskälla / laboratorium', previous?.data.source) +
        input('messageId', 'Svar-ID från källan') +
        input(
          'collectedAt',
          'Provtagning (UTC)',
          previous ? new Date(previous.data.collectedAt).toISOString().slice(0, 19) : now,
          'datetime-local',
        ) +
        input('reportedAt', 'Svarstid (UTC)', now, 'datetime-local') +
        (previous ? text('correctionReason', 'Orsak till rättat svar', '', true, 500) : '') +
        '<div id="result-inputs"></div><button type="button" id="add-result">' +
        icon('plus') +
        'Lägg till analys</button>' +
        check(
          'sourceConfirmed',
          'Värden, enheter, referenser och avvikelsemarkeringar är kontrollerade mot svaret',
          true,
        ),
      (values) => {
        const resultRows = [...document.querySelectorAll('.result-input')].map((node) =>
          Object.fromEntries(
            [...node.querySelectorAll('[data-result-field]')].map((el) => [
              el.dataset.resultField,
              el.value.trim(),
            ]),
          ),
        );
        const data = {
          source: values.source,
          messageId: values.messageId,
          collectedAt: new Date(values.collectedAt + 'Z').toISOString(),
          reportedAt: new Date(values.reportedAt + 'Z').toISOString(),
          results: resultRows,
          ...(previous ? { correctionReason: values.correctionReason } : {}),
        };
        return api(`/lab-orders/${id}/receive`, { version: row.version, data });
      },
      'Registrera svar',
    );
    let sequence = 0;
    const add = (value = {}) => {
      if (document.querySelectorAll('.result-input').length >= 30) return;
      const number = ++sequence;
      const node = document.createElement('fieldset');
      node.className = 'result-input';
      node.innerHTML =
        `<legend>Analys ${number}</legend>` +
        input('name', `Analysnamn ${number}`, value.name) +
        input('value', `Resultat ${number}`, value.value, 'text', true, 500) +
        input('unit', `Enhet ${number}`, value.unit, 'text', false, 80) +
        input('reference', `Referensintervall ${number}`, value.reference, 'text', false) +
        select('flag', `Avvikelse ${number}`, flag, value.flag ?? 'unknown') +
        `<button type="button" title="Ta bort analys ${number}" aria-label="Ta bort analys ${number}">${icon('trash-2')}</button>`;
      node.querySelectorAll('[name]').forEach((el) => {
        el.dataset.resultField = el.name;
        el.removeAttribute('name');
      });
      node.querySelector('button').onclick = () => {
        if (document.querySelectorAll('.result-input').length > 1) node.remove();
      };
      document.querySelector('#result-inputs').append(node);
      globalThis.lucide?.createIcons();
    };
    for (const r of previous?.data.results ?? [{}]) add(r);
    document.querySelector('#add-result').onclick = () => add();
  } else if (name === 'lab-review') {
    const report = chart.find((r) => r.id === row.data.reportId);
    const task = chart.find((r) => r.kind === 'task' && r.data.linkedOrderId === id);
    modal(
      'Granska provsvar',
      `<h3>${e(row.data.test)}</h3>${results(report)}<small>${e(report.data.source)} · ${e(report.data.messageId)}</small>` +
        text('assessment', 'Bedömning') +
        text('action', 'Åtgärd / uppföljningsplan') +
        text('communication', 'Patientkontakt / kommunikationsplan', '', true, 1000) +
        (row.data.critical
          ? check(
              'criticalAcknowledged',
              'Jag har uppmärksammat det kritiska svaret och dokumenterat åtgärden',
              true,
            )
          : ''),
      (values) =>
        api(`/lab-orders/${id}/review`, {
          version: row.version,
          data: {
            ...values,
            reportId: report.id,
            taskVersion: task.version,
            criticalAcknowledged: values.criticalAcknowledged === 'on',
          },
        }),
      'Signera granskning',
    );
  } else if (name === 'lab-history') {
    const versions = await api(`/records/${id}/history`);
    const reviews = chart.filter((r) => r.kind === 'labReview' && r.data.orderId === id);
    modal(
      'Provbeställningens historik',
      versions
        .map(
          (r) =>
            `<div class="history-row"><strong>Version ${r.version} · ${status[r.data.status]}</strong><small>${date(r.updatedAt)}</small><p>${e(r.data.cancelReason ?? '')}</p></div>`,
        )
        .join('') +
        reviews
          .map(
            (r) =>
              `<div class="history-row"><strong>Granskning · ${date(r.createdAt)} · ${e(memberName(r.data.author))}</strong><p>${e(r.data.assessment)}</p><p>${e(r.data.action)}</p><p>${e(r.data.communication)}</p><small>Svar: ${e(r.data.reportId)}</small></div>`,
          )
          .join(''),
      async () => {},
      'Stäng',
    );
  }
}
