import { escape as e, date, display, labels } from './shared.js';
export function render(target, records) {
  target.innerHTML =
    records
      .map(
        (r) =>
          `<article class="timeline-entry"><time>${e(date(r.createdAt))}</time><div><strong>${e(labels[r.kind])}</strong> <span class="badge ${r.data.status === 'draft' ? 'draft' : ''}">${e(r.data.status ?? '')}</span><p>${e(display(r))}</p></div></article>`,
      )
      .join('') || '<p class="empty">Inga journalhändelser.</p>';
}
