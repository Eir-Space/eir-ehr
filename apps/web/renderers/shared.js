export const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const date = (value) =>
  new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
export const labels = {
  patient: 'Patient',
  encounter: 'Vårdkontakt',
  note: 'Journalanteckning',
  observation: 'Mätvärde',
  condition: 'Diagnos',
  allergy: 'Överkänslighet',
  task: 'Uppgift',
  proposal: 'AI-förslag',
};
export function display(e) {
  const d = e.data;
  return (
    d.text ??
    d.reason ??
    d.title ??
    d.code?.display ??
    (d.substance
      ? `${d.substance}: ${d.reaction}`
      : d.display
        ? `${d.display}: ${d.value} ${d.unit}`
        : (d.name ?? ''))
  );
}
