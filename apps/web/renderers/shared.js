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
  appointment: 'Bokning',
  proposal: 'AI-förslag',
  medication: 'Läkemedelsuppgift',
  medicationReview: 'Läkemedelsavstämning',
  labOrder: 'Provbeställning',
  labReport: 'Provsvar',
  labReview: 'Svarsgranskning',
};
export function display(e) {
  const d = e.data;
  if (e.kind === 'medication')
    return `${d.name} · ${d.dosageText ?? 'Dosering okänd'} · ${d.status} · ${d.sourceDetail}${d.reason ? ' · ' + d.reason : ''}`;
  if (e.kind === 'medicationReview') return d.note;
  if (e.kind === 'labOrder') return `${d.test}: ${d.question}`;
  if (e.kind === 'labReport')
    return `${d.source}: ${d.results.map((r) => `${r.name} ${r.value} ${r.unit} (${r.flag})`).join('; ')}`;
  if (e.kind === 'labReview') return `${d.assessment}. ${d.action}`;
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
export function recordStatus(record, records) {
  if (
    record.kind === 'labReport' &&
    records.some(
      (r) => r.kind === 'labOrder' && r.id === record.data.orderId && r.data.reportId !== record.id,
    )
  )
    return 'Ersatt';
  return record.data.status ?? '';
}
