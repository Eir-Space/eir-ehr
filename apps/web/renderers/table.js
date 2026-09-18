import { escape as e, date, display, labels } from './shared.js';
export function render(target, records) {
  target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Tidpunkt</th><th>Typ</th><th>Innehåll</th><th>Status</th></tr></thead><tbody>${records.map((r) => `<tr><td>${e(date(r.createdAt))}</td><td>${e(labels[r.kind])}</td><td><p>${e(display(r))}</p></td><td>${e(r.data.status ?? '')}</td></tr>`).join('')}</tbody></table></div>`;
}
