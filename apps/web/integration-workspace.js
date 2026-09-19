import { escape as e, date } from './renderers/shared.js';

export const deliveryStates = {
  pending: 'I kö',
  sending: 'Pågår',
  retry: 'Nytt försök väntar',
  acknowledged: 'Mottagen av labb',
  rejected: 'Avvisad av labb',
  quarantined: 'Kräver åtgärd',
  applied: 'Journalfört',
};
const failures = {
  order_patient_mismatch: 'Patient och beställning matchar inte',
  identifier_mismatch: 'Patientidentifierare matchar inte',
  identifier_changed: 'Patientidentifierare har ändrats',
  patient_restricted: 'Patientuppgifter är skyddade eller spärrade',
  patient_scope_mismatch: 'Patient utanför anslutningens vårdenhet',
  order_not_acknowledged: 'Labbets mottagningskvitto saknas',
  predecessor_pending: 'Tidigare svar inväntas',
  correction_conflict: 'Rättningen avser inte det senaste svaret',
  correction_reason_required: 'Orsak till rättning saknas',
  correction_predecessor_required: 'Referens till tidigare svar krävs',
  review_owner_missing: 'Svarsansvarig saknas',
  review_owner_inactive: 'Svarsansvarig saknar aktivt uppdrag',
  review_owner_access_expired: 'Svarsansvarig saknar aktuell vårdrelation',
  invalid_report_times: 'Ogiltiga prov- eller svarstider',
  invalid_acknowledgement: 'Ogiltigt mottagningskvitto',
  attempts_exhausted: 'Antal automatiska försök uppnått',
  result_application_failed: 'Journalföringen misslyckades',
  delivery_timeout: 'Tidsgräns överskriden',
  delivery_unconfirmed: 'Leverans inte bekräftad',
  connector_disabled: 'Anslutning pausad',
};
const views = new WeakMap();
export async function renderIntegrations(target, options, selected) {
  const saved = views.get(target);
  const filters = selected ?? (saved?.scope === options.scope ? saved.filters : {});
  views.set(target, { scope: options.scope, filters });
  const { api, modal, perform } = options;
  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  const data = await api(`/integrations?${params}`);
  const refresh = () => renderIntegrations(target, options, filters);
  target.innerHTML = `<div class="toolbar"><h2>Integrationer</h2><button class="icon" data-refresh title="Uppdatera" aria-label="Uppdatera"><i data-lucide="refresh-cw"></i></button></div>
    <div class="integration-connections">${data.connectors.map((c) => `<div class="section-title"><div><strong>${e(c.name)}</strong><small>${e(c.id)}</small></div><label class="check-label"><input type="checkbox" data-connection="${e(c.recordId)}" ${c.enabled ? 'checked' : ''}>Aktiv</label></div>`).join('') || '<p class="empty">Inga laboratorier anslutna.</p>'}</div>
    <form class="access-filters" data-integration-filters>
      <label>Riktning<select name="direction" aria-label="Riktning"><option value="outbox" ${filters.direction !== 'inbox' ? 'selected' : ''}>Beställningar</option><option value="inbox" ${filters.direction === 'inbox' ? 'selected' : ''}>Provsvar</option></select></label>
      <label>Anslutning<select name="connectorId" aria-label="Anslutning"><option value="">Alla</option>${data.connectors.map((c) => `<option value="${e(c.id)}" ${filters.connectorId === c.id ? 'selected' : ''}>${e(c.name)}</option>`).join('')}</select></label>
      <label>Status<select name="state" aria-label="Status"><option value="">Alla</option>${Object.entries(
        deliveryStates,
      )
        .map(
          ([key, name]) =>
            `<option value="${key}" ${filters.state === key ? 'selected' : ''}>${name}</option>`,
        )
        .join('')}</select></label>
      <button type="submit"><i data-lucide="filter"></i>Filtrera</button>
    </form>
    <div class="integration-table"><table><thead><tr><th>Mottaget</th><th>Anslutning / beställning</th><th>Status</th><th>Försök</th><th>Åtgärd</th></tr></thead><tbody>${data.items.map((r) => `<tr><td>${date(r.createdAt)}</td><td>${e(r.connectorId)}<small class="integration-id">${e(r.orderId)}</small></td><td><span class="badge ${r.state === 'quarantined' || r.state === 'rejected' ? 'critical' : ''}">${e(deliveryStates[r.state] ?? r.state)}</span>${r.code ? `<small>${e(failures[r.code] ?? r.code)}</small>` : ''}</td><td>${r.attempts}</td><td><button class="icon" data-inspect="${e(r.id)}" title="Meddelandedetaljer" aria-label="Meddelandedetaljer"><i data-lucide="list"></i></button>${['quarantined', 'retry'].includes(r.state) ? `<button class="icon" data-replay="${e(r.id)}" title="Försök igen" aria-label="Försök igen"><i data-lucide="rotate-cw"></i></button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${!data.items.length ? '<p class="empty">Inga meddelanden för valt urval.</p>' : ''}
    <div class="actions">${filters.after ? '<button data-first><i data-lucide="chevrons-left"></i>Första sidan</button>' : ''}${data.nextCursor ? '<button data-next>Nästa sida<i data-lucide="chevron-right"></i></button>' : ''}</div>`;
  target.querySelector('[data-refresh]').onclick = () => perform(refresh);
  target.querySelector('[data-integration-filters]').onsubmit = (event) => {
    event.preventDefault();
    const selected = Object.fromEntries(new FormData(event.target));
    perform(() => renderIntegrations(target, options, selected));
  };
  target
    .querySelector('[data-next]')
    ?.addEventListener('click', () =>
      perform(() => renderIntegrations(target, options, { ...filters, after: data.nextCursor })),
    );
  target
    .querySelector('[data-first]')
    ?.addEventListener('click', () =>
      perform(() => renderIntegrations(target, options, { ...filters, after: '' })),
    );
  target.querySelectorAll('[data-connection]').forEach((input) => {
    input.onchange = () => {
      const c = data.connectors.find((row) => row.recordId === input.dataset.connection);
      const enabled = input.checked;
      input.checked = c.enabled;
      modal(
        enabled ? 'Aktivera anslutning' : 'Pausa anslutning',
        `<p>${e(c.name)}</p><label>Orsak<textarea name="reason" minlength="5" maxlength="500" required></textarea></label>`,
        async ({ reason }) => {
          await api(`/integrations/${c.recordId}/connection`, {
            version: c.version,
            enabled,
            reason,
          });
          await refresh();
        },
        'Bekräfta',
      );
    };
  });
  target.querySelectorAll('[data-replay]').forEach((button) => {
    button.onclick = () => {
      const r = data.items.find((row) => row.id === button.dataset.replay);
      modal(
        'Nytt leveransförsök',
        `<p>${e(failures[r.code] ?? r.code ?? deliveryStates[r.state])}</p><label>Åtgärd och orsak<textarea name="reason" minlength="5" maxlength="500" required></textarea></label>`,
        async ({ reason }) => {
          await api(`/integrations/${r.id}/replay`, { version: r.version, reason });
          await refresh();
        },
        'Försök igen',
      );
    };
  });
  target.querySelectorAll('[data-inspect]').forEach((button) => {
    button.onclick = () => {
      const r = data.items.find((row) => row.id === button.dataset.inspect);
      modal(
        'Meddelandedetaljer',
        `<dl class="integration-detail"><dt>Meddelande-ID</dt><dd>${e(r.messageId)}</dd><dt>Beställning</dt><dd>${e(r.orderId)}</dd><dt>Version</dt><dd>${r.version}</dd><dt>Försök</dt><dd>${r.attempts}</dd><dt>Tidigast nästa försök / reservation</dt><dd>${date(r.availableAt)}</dd><dt>Felkod</dt><dd>${e(r.code ?? 'Ingen')}</dd></dl>`,
        async () => {},
        'Stäng',
      );
    };
  });
  globalThis.lucide?.createIcons();
}
