import { escape as e, date } from './renderers/shared.js';
const status = {
  alert: 'Avvikelse att bedöma',
  'no-trigger': 'Ingen regel utlöst',
  'insufficient-data': 'Otillräckligt underlag',
  unavailable: 'Beräkning otillgänglig',
};
const actionLabels = {
  acknowledge: 'Mottaget',
  reassess: 'Klinisk bedömning',
  resolve: 'Avslutat',
};
const views = new WeakMap();
const icon = (name, label, attrs = '') =>
  `<button ${attrs} title="${e(label)}" aria-label="${e(label)}"><i data-lucide="${name}"></i></button>`;
export async function renderDeterioration(target, ctx, after) {
  const saved = views.get(target);
  after ??= saved?.scope === ctx.scope ? saved.after : '';
  views.set(target, { scope: ctx.scope, after });
  const { api, modal, perform, patientSelect, actorId, openChart, vitals } = ctx;
  const data = await api('/deterioration' + (after ? `?after=${encodeURIComponent(after)}` : ''));
  target.innerHTML = `<div class="toolbar"><h2>Vitalövervakning</h2><div class="actions">${data.enabled ? icon('user-plus', 'Starta patientövervakning', 'data-monitor-add') : ''}${icon('refresh-cw', 'Uppdatera övervakning', 'data-monitor-refresh')}</div></div>
    <div class="monitor-meta"><span class="badge ${data.enabled ? '' : 'draft'}">${data.enabled ? (data.worker ? 'Automatisk kontroll aktiv' : 'Manuell kontroll') : 'Modulen avstängd'}</span><span>${e(data.engine.label)} · ${e(data.engine.version)}</span><small>${e(data.engine.intendedUse)}</small></div>
    ${
      data.items
        .map((item) => {
          const { monitor: m, assessment: a, alerts, tasks, events } = item;
          const stale =
            !m.data.checkedAt ||
            Date.now() - Date.parse(m.data.checkedAt) > Math.max(data.pollMs * 3, 60000);
          const label = !m.data.active
            ? 'Övervakning avslutad'
            : m.data.failure
              ? 'Kontroll misslyckades'
              : !data.enabled
                ? 'Kontroll avstängd'
                : stale
                  ? 'Ny kontroll behövs'
                  : (status[a?.data.status] ?? 'Inväntar första kontroll');
          return `<section class="monitor-patient" data-monitor-row="${m.id}"><header><div><h3>${e(item.patientName)}</h3><small>Senast kontrollerad: ${m.data.checkedAt ? date(m.data.checkedAt) : 'Aldrig'}</small></div><div class="actions"><span class="badge ${alerts.length ? 'risk-alert' : 'draft'}">${e(label)}</span>${icon('folder-open', 'Öppna patientjournal', `data-monitor-chart="${m.patientId}"`)}${data.enabled && m.data.active ? icon('activity', 'Kontrollera nu', `data-monitor-evaluate="${m.id}"`) : ''}${m.data.active ? icon('pause', 'Stoppa patientövervakning', `data-monitor-stop="${m.id}"`) : ''}</div></header>
        ${a ? `<p class="quiet">Underlag bedömt: ${date(a.data.evaluatedAt)}</p>${a.data.findings.map((f) => `<p class="risk-finding"><i data-lucide="triangle-alert"></i>${e(f.text)}</p>`).join('')}${a.data.missing.length ? `<p class="risk-missing">Saknat, inaktuellt eller ej bedömbart: ${e(a.data.missing.join(', '))}</p>` : ''}<details><summary>Mätunderlag (${a.data.readings.length + a.data.labs.length})</summary><div class="monitor-readings">${a.data.readings.map((r) => `<div><span>${e(vitals?.[r.code]?.label ?? r.code)} <code>${e(r.code)}</code></span><strong>${e(r.value)} ${e(r.unit)}</strong><small>${date(r.effectiveAt)}</small></div>`).join('')}${a.data.labs.map((r) => `<div><span>${e(r.name)}</span><strong>${e(r.value)} ${e(r.unit)}</strong><small>${date(r.effectiveAt)}</small></div>`).join('')}</div></details>` : ''}
        ${alerts
          .map((alert) => {
            const task = tasks.find((t) => t.id === alert.data.taskId);
            return `<div class="monitor-alert"><div><strong>Öppet larm</strong><small>${alert.data.status === 'reassessed' ? 'Bedömt, uppföljning kvarstår' : alert.data.status === 'acknowledged' ? 'Mottaget, bedömning kvarstår' : 'Ny bedömning krävs'} · Senast ${date(task?.data.dueAt)}</small></div>${task?.data.assigneeId === actorId ? `<button data-risk-respond="${alert.id}"><i data-lucide="clipboard-check"></i>Dokumentera bedömning</button>` : '<span class="quiet">Tilldelat annan medarbetare</span>'}</div>`;
          })
          .join('')}
        ${events.length ? `<details><summary>Bedömningshistorik (${events.length}${events.length === 100 ? '+' : ''})</summary>${events.map((ev) => `<div class="history-row"><strong>${e(actionLabels[ev.data.action])} · ${date(ev.createdAt)}</strong><p>${e(ev.data.note)}</p>${ev.data.plan ? `<p>${e(ev.data.plan)}</p>` : ''}</div>`).join('')}</details>` : ''}</section>`;
        })
        .join('') || '<p class="empty">Inga patienter under övervakning.</p>'
    }
    <div class="actions">${after ? '<button data-monitor-first>Första sidan</button>' : ''}${data.nextCursor ? '<button data-monitor-next>Nästa sida</button>' : ''}</div>`;
  const refresh = () => perform(() => renderDeterioration(target, ctx, after));
  target.querySelector('[data-monitor-refresh]').onclick = refresh;
  target
    .querySelector('[data-monitor-first]')
    ?.addEventListener('click', () => perform(() => renderDeterioration(target, ctx, '')));
  target
    .querySelector('[data-monitor-next]')
    ?.addEventListener('click', () =>
      perform(() => renderDeterioration(target, ctx, data.nextCursor)),
    );
  target.querySelector('[data-monitor-add]')?.addEventListener('click', () =>
    modal(
      'Starta patientövervakning',
      patientSelect() +
        '<label>Orsak<textarea name="reason" required minlength="5" maxlength="2000"></textarea></label>',
      async (values) => {
        const chart = await api(`/patients/${values.patientId}/chart`),
          encounter = chart.find((r) => r.kind === 'encounter' && r.data.status === 'in-progress');
        if (!encounter) throw new Error('Patienten behöver en pågående vårdkontakt.');
        const monitor = await api(`/patients/${values.patientId}/monitoring`, {
          encounterId: encounter.id,
          reason: values.reason,
        });
        await api(`/monitoring/${monitor.id}/evaluate`, {});
      },
      'Starta',
    ),
  );
  target
    .querySelectorAll('[data-monitor-chart]')
    .forEach((b) => (b.onclick = () => perform(() => openChart(b.dataset.monitorChart))));
  target.querySelectorAll('[data-monitor-evaluate]').forEach(
    (b) =>
      (b.onclick = () =>
        perform(async () => {
          await api(`/monitoring/${b.dataset.monitorEvaluate}/evaluate`, {});
          await renderDeterioration(target, ctx, after);
        })),
  );
  target.querySelectorAll('[data-monitor-stop]').forEach(
    (b) =>
      (b.onclick = () => {
        const monitor = data.items.find((i) => i.monitor.id === b.dataset.monitorStop).monitor;
        modal(
          'Stoppa patientövervakning',
          '<label>Orsak<textarea name="reason" required minlength="5" maxlength="2000"></textarea></label>',
          (values) =>
            api(`/monitoring/${monitor.id}/stop`, {
              version: monitor.version,
              reason: values.reason,
            }),
          'Stoppa',
        );
      }),
  );
  target.querySelectorAll('[data-risk-respond]').forEach(
    (b) =>
      (b.onclick = () => {
        const alert = data.items
          .flatMap((i) => i.alerts)
          .find((a) => a.id === b.dataset.riskRespond);
        modal(
          'Bedöm larm',
          `<label>Händelse<select name="action" aria-label="Händelse"><option value="acknowledge">Bekräfta mottaget</option><option value="reassess">Dokumentera klinisk bedömning</option>${alert.data.reassessedId === alert.data.assessmentId ? '<option value="resolve">Avsluta efter bedömning</option>' : ''}</select></label><label>Bedömning<textarea name="note" required minlength="5" maxlength="2000"></textarea></label><label>Fortsatt plan<textarea name="plan" required minlength="5" maxlength="2000"></textarea></label>`,
          (values) =>
            api(`/deterioration-alerts/${alert.id}/respond`, {
              ...values,
              version: alert.version,
              assessmentId: alert.data.assessmentId,
            }),
        );
      }),
  );
  globalThis.lucide?.createIcons();
}
