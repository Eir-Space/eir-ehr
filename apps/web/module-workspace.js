import { escape as e } from './renderers/shared.js';

export async function renderModules(target, { api, modal, perform }) {
  const [catalogue, installed] = await Promise.all([api('/modules'), api('/plugins')]);
  target.innerHTML = `<div class="toolbar"><h2>Moduler för vårdenheten</h2><span class="quiet">${catalogue.items.filter((m) => m.enabled).length} tillval aktiva</span></div>
    ${catalogue.items.map((m) => `<section class="module-setting"><div><h3>${e(m.name)}</h3><small>${e(m.id)} · v${e(m.moduleVersion)}</small><p class="quiet">${e(m.restriction)}</p></div><label class="module-switch"><input type="checkbox" role="switch" aria-label="${e(m.name)}" data-module="${e(m.id)}" ${m.enabled ? 'checked' : ''} ${!catalogue.canManage || (!m.canEnable && !m.enabled) ? 'disabled' : ''}><span>${m.enabled ? 'Aktiv' : 'Avstängd'}</span></label></section>`).join('')}
    <details class="module-installed"><summary>Installerade komponenter (${installed.length})</summary>${installed.map((p) => `<div class="plugin"><strong>${e(p.id)}</strong><code>${e(p.provides.join(', '))}</code><span class="badge">v${e(p.version)}</span></div>`).join('')}</details>`;
  target.querySelectorAll('[data-module]').forEach((control) => {
    control.onchange = () => {
      const module = catalogue.items.find((m) => m.id === control.dataset.module),
        enabled = control.checked;
      control.checked = module.enabled;
      modal(
        enabled ? `Aktivera ${module.name}` : `Stäng av ${module.name}`,
        `<p>${enabled ? e(module.restriction) : 'Nya beräkningar stoppas. Öppna larm och uppgifter finns kvar.'}</p><label>Orsak<textarea name="reason" required minlength="5" maxlength="500"></textarea></label>`,
        async (values) => {
          await api(`/modules/${module.id}`, {
            enabled,
            version: module.version,
            reason: values.reason,
          });
        },
        enabled ? 'Aktivera' : 'Stäng av',
      );
    };
  });
}
