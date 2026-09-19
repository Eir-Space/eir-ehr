import { escape as e, date } from './renderers/shared.js';

const stages = {
  'awaiting-result': 'Inväntar svar',
  'awaiting-review': 'Ej granskat',
  'action-required': 'Åtgärd kvarstår',
  completed: 'Avslutad',
};
const deliveries = {
  pending: 'I kö',
  sending: 'Skickas',
  retry: 'Nytt försök väntar',
  failed: 'Leverans misslyckad',
  delivered: 'Levererat till aviseringstjänst',
  cancelled: 'Inaktuell avisering',
};
const blockers = {
  owner_ineligible: 'Ansvarig saknar behörighet',
  coverage_ineligible: 'Ersättaren saknar patientåtkomst',
  notification_route_missing: 'Aviseringskanal saknas',
  escalation_recipient_missing: 'Eskalering saknar mottagare',
  coverage_cycle: 'Överlämningskedjan kräver manuell kontroll',
};
const tool = (name, label, icon, id) =>
  `<button class="icon" data-${name}="${e(id)}" title="${e(label)}" aria-label="${e(label)}"><i data-lucide="${icon}"></i></button>`;
const note =
  '<label>Dokumentation<textarea name="note" minlength="5" maxlength="2000" required></textarea></label>';
const views = new WeakMap();
const updateFreshness = () => {
  const badge = document.querySelector('[data-follow-up-freshness]');
  if (!badge) return;
  if (
    !badge.dataset.followUpFreshness ||
    Date.now() - Date.parse(badge.dataset.followUpFreshness) > 120000
  ) {
    badge.classList.add('draft');
    badge.textContent = 'Automatisk bevakning ej bekräftad';
  }
};
setInterval(updateFreshness, 5000);
document.addEventListener('visibilitychange', updateFreshness);

export async function renderFollowUp(target, options, after, status) {
  const { api, modal, perform, actorId, memberName, memberSelect, openChart } = options;
  const saved = views.get(target);
  after ??= saved?.scope === options.scope ? saved.after : '';
  status ??= saved?.scope === options.scope ? saved.status : 'open';
  views.set(target, { scope: options.scope, after, status });
  const data = await api(
    `/follow-up?status=${status}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
  );
  const refresh = () => renderFollowUp(target, options, after, status);
  const stale = !data.lastFullScanAt || Date.now() - Date.parse(data.lastFullScanAt) > 120000;
  target.innerHTML = `<div class="toolbar"><h2>Bevakning</h2><div class="actions"><button data-coverage><i data-lucide="users"></i>Min ersättare</button>${tool('refresh', 'Uppdatera bevakning', 'refresh-cw', '')}</div></div>
    <div class="follow-up-status"><span data-follow-up-freshness="${e(data.lastFullScanAt ?? '')}" class="badge ${stale ? 'draft' : ''}">${stale ? 'Automatisk bevakning ej bekräftad' : 'Bevakning aktiv'}</span><small>Senaste körning: ${data.lastCycleAt ? date(data.lastCycleAt) : 'Ingen'}</small><small>Policy: ${e(data.policy?.version ?? 'Ej konfigurerad')}</small></div>
    <label class="follow-up-filter">Uppgiftsstatus<select data-status><option value="open" ${status === 'open' ? 'selected' : ''}>Öppna</option><option value="closed" ${status === 'closed' ? 'selected' : ''}>Avslutade</option></select></label>
    <div class="follow-up-table"><table><thead><tr><th>Patient / uppgift</th><th>Status</th><th>Senast</th><th>Ansvarig</th><th>Avisering</th><th>Åtgärder</th></tr></thead><tbody>${data.items
      .map((item) => {
        const { task, state, notification } = item;
        const canAct =
          !task.data.deteriorationAlertId &&
          task.data.assigneeId === actorId &&
          state?.stage === 'action-required';
        return `<tr data-follow-up-row="${e(task.id)}"><td><strong>${e(item.patientName)}</strong><span>${e(task.data.title)}</span></td><td><span class="badge ${state?.critical ? 'critical' : item.overdue ? 'draft' : ''}">${state?.critical ? 'Kritiskt · ' : ''}${e(stages[state?.stage] ?? 'Policy saknas')}</span>${item.overdue ? '<small>Försenad</small>' : ''}${task.data.followUp?.blocker ? `<small class="follow-up-warning">${e(blockers[task.data.followUp.blocker] ?? task.data.followUp.blocker)}</small>` : ''}</td><td>${state ? date(state.deadlineAt) : e(task.data.due)}</td><td>${e(memberName(task.data.assigneeId))}</td><td>${e(deliveries[notification?.state] ?? 'Ej aviserad')}${notification ? `<small>${notification.attempts} försök</small>` : ''}</td><td><div class="actions">${tool('chart', 'Öppna journal', 'folder-open', task.id)}${tool('history', 'Uppföljningshistorik', 'history', task.id)}${tool('assign', 'Överlämna ansvar', 'user-round-cog', task.id)}${canAct ? tool('act', 'Dokumentera uppföljning', 'notebook-pen', task.id) : ''}${notification?.state === 'failed' && task.data.assigneeId === actorId ? tool('replay', 'Försök avisera igen', 'rotate-cw', task.id) : ''}</div></td></tr>`;
      })
      .join(
        '',
      )}</tbody></table></div>${data.items.length ? '' : '<p class="empty">Inga uppgifter i detta urval.</p>'}
    <div class="actions">${after ? '<button data-first><i data-lucide="chevrons-left"></i>Första sidan</button>' : ''}${data.nextCursor ? '<button data-next>Nästa sida<i data-lucide="chevron-right"></i></button>' : ''}</div>
    <section class="band"><h3>Mina täckningsperioder</h3>${data.coverage.map((r) => `<div class="section-title"><div><strong>${e(memberName(r.data.coverId))}</strong><small>${date(r.data.startsAt)} – ${date(r.data.endsAt)}</small></div>${tool('cancel-coverage', 'Avsluta täckningsperiod', 'x', r.id)}</div>`).join('') || '<p class="quiet">Ingen ersättare registrerad.</p>'}</section>`;
  target.querySelector('[data-refresh]').onclick = () => perform(refresh);
  target.querySelector('[data-status]').onchange = (event) =>
    perform(() => renderFollowUp(target, options, '', event.target.value));
  target
    .querySelector('[data-first]')
    ?.addEventListener('click', () => perform(() => renderFollowUp(target, options, '')));
  target
    .querySelector('[data-next]')
    ?.addEventListener('click', () =>
      perform(() => renderFollowUp(target, options, data.nextCursor)),
    );
  target.querySelector('[data-coverage]').onclick = () => {
    modal(
      'Min ersättare',
      memberSelect('coverId', 'Ersättare', '') +
        '<label>Från (UTC)<input name="startsAt" type="datetime-local" required></label><label>Till (UTC)<input name="endsAt" type="datetime-local" required></label><label>Orsak<textarea name="reason" minlength="5" maxlength="500" required></textarea></label>',
      (values) =>
        api('/follow-up/coverage', {
          ...values,
          startsAt: new Date(values.startsAt + 'Z').toISOString(),
          endsAt: new Date(values.endsAt + 'Z').toISOString(),
        }),
    );
  };
  target.querySelectorAll('[data-cancel-coverage]').forEach(
    (button) =>
      (button.onclick = () => {
        const row = data.coverage.find((r) => r.id === button.dataset.cancelCoverage);
        modal(
          'Avsluta täckningsperiod',
          '<label>Orsak<textarea name="reason" minlength="5" required></textarea></label>',
          (values) =>
            api(`/follow-up/coverage/${row.id}/cancel`, { version: row.version, ...values }),
        );
      }),
  );
  for (const item of data.items) {
    const row = target.querySelector(`[data-follow-up-row="${item.task.id}"]`),
      task = item.task;
    row.querySelector('[data-chart]').onclick = () =>
      perform(() =>
        openChart(
          task.patientId,
          task.data.deteriorationAlertId ? 'monitoring' : item.orderId ? 'labs' : 'tasks',
        ),
      );
    row.querySelector('[data-assign]').hidden = !['requested', 'in-progress'].includes(
      task.data.status,
    );
    row.querySelector('[data-assign]').onclick = () =>
      modal(
        'Överlämna ansvar',
        memberSelect('assigneeId', 'Ny ansvarig', task.data.assigneeId) +
          '<label>Orsak<textarea name="reason" maxlength="200" required></textarea></label>',
        (values) => api(`/records/${task.id}/assign`, { version: task.version, data: values }),
      );
    row
      .querySelector('[data-act]')
      ?.addEventListener('click', () =>
        modal(
          'Dokumentera uppföljning',
          `<label>Händelse<select name="type"><option value="contact-attempt">Kontaktförsök</option><option value="action">Utförd åtgärd</option><option value="complete">Alla åtgärder slutförda</option></select></label>${note}`,
          (values) => api(`/follow-up/${task.id}/action`, { version: task.version, data: values }),
        ),
      );
    row.querySelector('[data-replay]')?.addEventListener('click', () =>
      modal(
        'Försök avisera igen',
        '<label>Orsak<textarea name="reason" minlength="5" required></textarea></label>',
        (values) =>
          api(`/follow-up/notifications/${item.notification.id}/replay`, {
            version: item.notification.version,
            ...values,
          }),
      ),
    );
    const history = async (after = '') => {
      const current = (
        await api(
          `/follow-up?taskId=${task.id}${after ? `&eventAfter=${encodeURIComponent(after)}` : ''}`,
        )
      ).items[0];
      modal(
        'Uppföljningshistorik',
        (current.events
          .map(
            (event) =>
              `<div class="history-row"><strong>${date(event.createdAt)} · ${e(event.data.type)}</strong><p>${e(event.data.note ?? blockers[event.data.blocker] ?? '')}</p><small>${e(memberName(event.data.author ?? event.data.ownerId))}</small></div>`,
          )
          .join('') || '<p>Inga händelser registrerade.</p>') +
          (current.nextEventCursor
            ? '<button type="button" id="follow-up-events-next">Fler händelser<i data-lucide="chevron-right"></i></button>'
            : ''),
        async () => {},
        'Stäng',
      );
      document
        .querySelector('#follow-up-events-next')
        ?.addEventListener('click', () => perform(() => history(current.nextEventCursor)));
    };
    row.querySelector('[data-history]').onclick = () => perform(() => history());
  }
  globalThis.lucide?.createIcons();
}
