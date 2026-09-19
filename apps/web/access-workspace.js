import { escape as e, date } from './renderers/shared.js';
export const roleLabel = {
  clinician: 'Vårdpersonal',
  auditor: 'Logggranskare',
  administrator: 'Behörighetsadministratör',
};
export const permissionLabels = {
  'coordination.read': 'Läsa samverkansärenden',
  'coordination.write': 'Dokumentera samverkan',
  'coordination.manage': 'Hantera samtycke och parter',
  'coordination.export': 'Exportera samverkansunderlag',
  'coordination.billing': 'Beräkna betalningsunderlag',
  'coordination.discharge': 'Ansvara för utskrivningsprocess',
  'chart.read': 'Läsa journal',
  'chart.export': 'Exportera journal',
  'patient.register': 'Registrera patient',
  'record.write': 'Dokumentera',
  'note.sign': 'Signera',
  'medication.write': 'Dokumentera läkemedel',
  'medication.reconcile': 'Stämma av läkemedel',
  'lab.order': 'Beställa prover',
  'lab.receive': 'Registrera provsvar',
  'lab.review': 'Granska provsvar',
  'schedule.write': 'Hantera bokningar',
  'task.write': 'Hantera uppgifter',
  'ai.use': 'Använda AI',
  'access.manage': 'Tilldela patientåtkomst',
  'access.emergency': 'Tillfällig läsåtkomst',
  'patient.protected': 'Skyddad identitet',
  'workforce.manage': 'Administrera uppdrag',
  'integration.manage': 'Administrera integrationer',
  'modules.manage': 'Administrera tillvalsmoduler',
  'audit.review': 'Granska åtkomstlogg',
};
export function gateActions(root, permissions) {
  if (!permissions) return;
  const map = {
    export: 'chart.export',
    sign: 'note.sign',
    encounter: 'record.write',
    close: 'record.write',
    note: 'record.write',
    'edit-note': 'record.write',
    amend: 'record.write',
    condition: 'record.write',
    observation: 'record.write',
    allergy: 'record.write',
    correct: 'record.write',
    task: 'task.write',
    complete: 'task.write',
    propose: 'ai.use',
    accept: 'ai.use',
    reject: 'ai.use',
    'med-add': 'medication.write',
    'med-edit': 'medication.write',
    'med-reconcile': 'medication.reconcile',
    'lab-order': 'lab.order',
    'lab-cancel': 'lab.order',
    'lab-receive': 'lab.receive',
    'lab-correct': 'lab.receive',
    'lab-review': 'lab.review',
    protect: 'patient.protected',
    'grant-access': 'access.manage',
  };
  root.querySelectorAll('[data-action], [data-care-action]').forEach((b) => {
    const action = b.dataset.action ?? b.dataset.careAction;
    let required = map[action];
    if (
      [
        'book',
        'arrive',
        'no-show',
        'start-appointment',
        'cancel-appointment',
        'reschedule-appointment',
      ].includes(action)
    )
      required = 'schedule.write';
    if (
      [
        'new-task',
        'start-task',
        'complete-task',
        'assign-task',
        'reschedule-task',
        'cancel-task',
        'reopen-task',
      ].includes(action)
    )
      required = 'task.write';
    if (
      required &&
      (!permissions.includes(required) ||
        (action === 'accept' && !permissions.includes('record.write')))
    )
      b.hidden = true;
  });
}

export async function renderAccessReview(target, { api, modal, perform, actorId, filters }) {
  const params = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v !== '' && v !== null),
  );
  const result = await api('/access-review?' + params);
  target.innerHTML = `<div class="toolbar"><h2>Åtkomstlogg</h2><span class="badge ${result.verification.ok ? '' : 'critical'}">${result.verification.ok ? 'Hashkedja verifierad' : 'Verifiering misslyckades'}</span></div>
    <form id="audit-filter" class="access-filters"><label>Medarbetar-ID<input name="actorId" value="${e(filters.actorId ?? '')}" maxlength="200"></label><label>Utfall<select name="outcome" aria-label="Utfall"><option value="">Alla</option><option value="denied" ${filters.outcome === 'denied' ? 'selected' : ''}>Nekad</option><option value="success" ${filters.outcome === 'success' ? 'selected' : ''}>Tillåten</option></select></label><button title="Filtrera" aria-label="Filtrera"><i data-lucide="filter"></i></button><button type="button" id="audit-refresh" title="Uppdatera" aria-label="Uppdatera"><i data-lucide="refresh-cw"></i></button><button type="button" id="audit-export" title="Exportera denna sida" aria-label="Exportera denna sida"><i data-lucide="download"></i></button></form>
    <div class="access-log">${result.entries.map((row) => `<article class="audit-entry"><div class="audit-meta"><strong>${e(row.action)}</strong><span class="badge ${row.outcome === 'denied' ? 'draft' : ''}">${row.outcome === 'denied' ? 'Nekad' : 'Tillåten'}</span><time>${date(row.at)}</time></div><p>${e(row.actor)}</p><small>Patient-ID: ${e(row.patientId ?? '—')} · Händelse ${row.seq}</small><details><summary>Spårbarhet${row.reviews.length ? ` · ${row.reviews.length} granskningar` : ''}</summary><dl><dt>Uppdrag</dt><dd>${e(row.assignmentId ?? '—')}</dd><dt>Hash</dt><dd>${e(row.hash)}</dd><dt>Objekt</dt><dd>${e(row.entityId ?? '—')}</dd></dl>${row.reviews.map((r) => `<p><strong>${r.data.decision === 'follow-up' ? 'Utredning krävs' : 'Motiverad åtkomst'}</strong> · ${e(r.data.reviewer)} · ${date(r.createdAt)}<br>${e(r.data.note)}</p>`).join('')}</details>${row.actor !== actorId ? `<button data-review="${row.seq}"><i data-lucide="clipboard-check"></i>Granska</button>` : ''}</article>`).join('') || '<p class="empty">Inga händelser för valt filter.</p>'}</div><div class="toolbar"><span>${result.entries.length} händelser</span>${result.nextBefore ? '<button id="audit-more">Äldre händelser<i data-lucide="chevron-right"></i></button>' : ''}</div>`;
  const refresh = () => renderAccessReview(target, { api, modal, perform, actorId, filters });
  target.querySelector('#audit-filter').onsubmit = (event) => {
    event.preventDefault();
    Object.assign(filters, Object.fromEntries(new FormData(event.currentTarget)), { before: null });
    void perform(refresh);
  };
  target.querySelector('#audit-refresh').onclick = () => {
    filters.before = null;
    void perform(refresh);
  };
  target.querySelector('#audit-more')?.addEventListener('click', () => {
    filters.before = result.nextBefore;
    void perform(refresh);
  });
  target.querySelector('#audit-export').onclick = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'eir-access-log-page.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  target.querySelectorAll('[data-review]').forEach(
    (b) =>
      (b.onclick = () => {
        const row = result.entries.find((r) => r.seq === Number(b.dataset.review));
        modal(
          'Granska åtkomst',
          `<p>${e(row.actor)} · ${e(row.action)} · ${date(row.at)}</p><label>Bedömning<select name="decision"><option value="follow-up">Utredning krävs</option><option value="justified">Motiverad åtkomst</option></select></label><label>Bedömning och uppföljning<textarea name="note" required maxlength="2000"></textarea></label>`,
          (values) => api('/access-review', { seq: row.seq, hash: row.hash, ...values }),
          'Registrera granskning',
        );
      }),
  );
}

export async function renderWorkforce(target, { api, modal, actorId }) {
  const rows = await api('/workforce');
  target.innerHTML = `<div class="toolbar"><h2>Medarbetaruppdrag</h2></div>${rows.map((row) => `<article class="staff-row"><div><strong>${e(row.data.name)}</strong><p>${roleLabel[row.data.role]}</p><small>${e(row.data.actorId)} · Giltigt till ${date(row.data.validUntil)}</small></div><span class="badge ${row.data.enabled ? '' : 'draft'}">${row.data.enabled ? 'Aktivt' : 'Återkallat'}</span>${row.data.actorId !== actorId ? `<button data-assignment="${row.id}" title="Ändra uppdrag" aria-label="Ändra uppdrag för ${e(row.data.name)}"><i data-lucide="user-cog"></i></button>` : ''}<details><summary>${row.data.permissions.length} behörigheter</summary><p>${row.data.permissions.map((p) => e(permissionLabels[p])).join(' · ')}</p></details></article>`).join('')}`;
  target.querySelectorAll('[data-assignment]').forEach(
    (b) =>
      (b.onclick = () => {
        const row = rows.find((r) => r.id === b.dataset.assignment);
        const allowed =
          row.data.role === 'administrator'
            ? ['workforce.manage', 'integration.manage', 'modules.manage']
            : row.data.role === 'auditor'
              ? ['audit.review']
              : Object.keys(permissionLabels).filter(
                  (p) => !['workforce.manage', 'integration.manage', 'audit.review'].includes(p),
                );
        modal(
          'Ändra medarbetaruppdrag',
          `<p>${e(row.data.name)} · ${roleLabel[row.data.role]}</p><label>Status<select name="enabled" aria-label="Status"><option value="true" ${row.data.enabled ? 'selected' : ''}>Aktivt</option><option value="false" ${!row.data.enabled ? 'selected' : ''}>Återkallat</option></select></label><label>Giltigt till (UTC)<input type="datetime-local" name="validUntil" value="${e(row.data.validUntil.slice(0, 16))}" required></label><fieldset class="permission-list"><legend>Behörigheter</legend>${allowed.map((p) => `<label><input type="checkbox" data-permission="${p}" ${row.data.permissions.includes(p) ? 'checked' : ''}>${e(permissionLabels[p])}</label>`).join('')}</fieldset><label>Orsak<input name="reason" required maxlength="200"></label>`,
          (values) =>
            api('/workforce/' + row.id, {
              version: row.version,
              data: {
                ...values,
                enabled: values.enabled === 'true',
                validUntil: new Date(values.validUntil + 'Z').toISOString(),
                permissions: [...document.querySelectorAll('[data-permission]:checked')].map(
                  (c) => c.dataset.permission,
                ),
              },
            }),
        );
      }),
  );
}
