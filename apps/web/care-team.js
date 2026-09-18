import { escape as e } from './renderers/shared.js';

export const taskOpen = (r) => ['requested', 'in-progress'].includes(r.data.status);
export const statusLabel = {
  booked: 'Bokad',
  arrived: 'Anlänt',
  'in-progress': 'Pågår',
  completed: 'Klar',
  cancelled: 'Avbokad',
  'no-show': 'Utebliven',
  requested: 'Öppen',
};
export const clinicDay = (timeZone, at = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
export const moveDay = (day, amount) => {
  const at = new Date(day + 'T12:00:00Z');
  at.setUTCDate(at.getUTCDate() + amount);
  return at.toISOString().slice(0, 10);
};
const icon = (name) => `<i data-lucide="${name}"></i>`;
const command = (action, label, name, id = '', primary = false) =>
  `<button data-care-action="${action}" data-id="${e(id)}" title="${e(label)}" aria-label="${e(label)}" ${primary ? 'class="primary"' : ''}>${icon(name)}${primary ? e(label) : ''}</button>`;

export function renderCareTeam(
  target,
  {
    mode,
    day,
    today,
    timeZone,
    data,
    patients,
    members,
    actorId,
    owner,
    filter,
    onAction,
    onDay,
    onOwner,
    onFilter,
  },
) {
  const patient = (id) => patients.find((p) => p.id === id);
  const member = (id) => members.find((m) => m.id === id)?.name ?? id;
  const patientLink = (r) =>
    `<button class="text-link" data-care-action="chart" data-id="${r.patientId}">${e(patient(r.patientId)?.data.name ?? 'Patient')}</button><small>${e(patient(r.patientId)?.data.identifier.value ?? '')}</small>`;
  const ownerField = `<label>Ansvarig<select id="team-owner" aria-label="Ansvarig"><option value="">Hela teamet</option>${members.map((m) => `<option value="${e(m.id)}" ${owner === m.id ? 'selected' : ''}>${e(m.name)}</option>`).join('')}</select></label>`;
  const heading = mode === 'schedule' ? 'Arbetslista' : 'Inkorg';
  target.innerHTML = `<div class="workspace-heading"><div><p class="eyebrow">Vårdteam</p><h1>${heading}</h1></div><div class="actions">${command('refresh', 'Uppdatera', 'refresh-cw')}${command(mode === 'schedule' ? 'book' : 'new-task', mode === 'schedule' ? 'Boka besök' : 'Ny uppgift', 'plus', '', true)}</div></div>`;
  if (mode === 'schedule') {
    const rows = data.appointments.filter((r) => !owner || r.data.practitionerId === owner);
    const time = (value) =>
      new Intl.DateTimeFormat('sv-SE', { timeZone, hour: '2-digit', minute: '2-digit' }).format(
        new Date(value),
      );
    target.innerHTML += `<div class="team-filters"><div class="day-picker">${command('previous-day', 'Föregående dag', 'chevron-left')}<label>Datum<input type="date" id="team-day" value="${e(day)}" required></label>${command('next-day', 'Nästa dag', 'chevron-right')}<button data-care-action="today">Idag</button></div>${ownerField}<span class="quiet">${e(timeZone)} · ${rows.length} bokningar</span></div>
      <div class="work-list">${rows.map((r) => `<article class="work-row appointment-row" data-record-id="${r.id}"><div class="slot-time"><strong>${time(r.data.startsAt)}</strong><small>${time(r.data.endsAt)}</small></div><div class="work-patient">${patientLink(r)}</div><div class="work-detail"><strong>${e(r.data.reason)}</strong><small>${e(member(r.data.practitionerId))} · ${{ visit: 'Mottagning', phone: 'Telefon', video: 'Video' }[r.data.type]}</small></div><span class="badge ${r.data.status === 'arrived' ? 'arrived' : ''}">${statusLabel[r.data.status]}</span><div class="row-actions">${r.data.status === 'booked' ? command('arrive', 'Markera ankomst', 'user-check', r.id) + command('reschedule-appointment', 'Boka om', 'calendar-clock', r.id) : ''}${['booked', 'arrived'].includes(r.data.status) ? (r.data.practitionerId === actorId ? command('start-appointment', 'Öppna vårdkontakt', 'play', r.id) : '') + command('cancel-appointment', 'Avboka', 'x', r.id) : ''}${r.data.status === 'booked' && Date.parse(r.data.startsAt) <= Date.now() ? command('no-show', 'Markera utebliven', 'user-x', r.id) : ''}${r.data.status === 'in-progress' ? command('chart', 'Öppna journal', 'arrow-right', r.patientId) : ''}</div>${r.data.resolution ? `<p class="work-resolution">${e(r.data.resolution)}</p>` : ''}</article>`).join('') || '<p class="empty">Inga bokningar för vald dag och ansvarig.</p>'}</div>`;
    target.querySelector('#team-day').onchange = (event) => {
      if (event.target.value) onDay(event.target.value);
    };
  } else {
    const rows = data.tasks.filter(
      (r) =>
        (!owner || (r.data.assigneeId ?? r.data.author) === owner) &&
        (filter === 'closed'
          ? !taskOpen(r)
          : taskOpen(r) && (filter !== 'overdue' || r.data.due < today)),
    );
    target.innerHTML += `<div class="team-filters">${ownerField}<label>Status<select id="task-filter"><option value="open" ${filter === 'open' ? 'selected' : ''}>Öppna</option><option value="overdue" ${filter === 'overdue' ? 'selected' : ''}>Försenade</option><option value="closed" ${filter === 'closed' ? 'selected' : ''}>Avslutade</option></select></label><span class="quiet">${rows.length} uppgifter</span></div><div class="work-list">${
      rows
        .map((r) => {
          const isOwner = (r.data.assigneeId ?? r.data.author) === actorId;
          const overdue = taskOpen(r) && r.data.due < today;
          const linkedActions =
            command('lab-task', 'Öppna provbeställning', 'flask-conical', r.id) +
            (taskOpen(r) ? command('assign-task', 'Byt ansvarig', 'user-round-cog', r.id) : '');
          const ordinaryActions = taskOpen(r)
            ? (isOwner
                ? (r.data.status === 'requested'
                    ? command('start-task', 'Påbörja uppgift', 'play', r.id)
                    : '') +
                  command('complete-task', 'Slutför uppgift', 'check', r.id) +
                  command('cancel-task', 'Avbryt uppgift', 'x', r.id)
                : '') +
              command('assign-task', 'Byt ansvarig', 'user-round-cog', r.id) +
              command('reschedule-task', 'Ändra förfallodatum', 'calendar-clock', r.id)
            : command('reopen-task', 'Öppna uppgift igen', 'rotate-ccw', r.id);
          return `<article class="work-row task-row" data-record-id="${r.id}"><div class="task-due ${overdue ? 'overdue' : ''}"><strong>${e(r.data.due)}</strong><small>${overdue ? 'Försenad' : 'Senast'}</small></div><div class="work-patient">${patientLink(r)}</div><div class="work-detail"><strong>${e(r.data.title)}</strong><small>${e(member(r.data.assigneeId ?? r.data.author))}${r.data.priority === 'urgent' ? ' · Hög prioritet' : ''}</small></div><span class="badge ${overdue ? 'draft' : ''}">${statusLabel[r.data.status]}</span><div class="row-actions">${r.data.linkedOrderId ? linkedActions : ordinaryActions}${command('task-history', 'Uppgiftens historik', 'history', r.id)}</div>${r.data.resolution ? `<p class="work-resolution">${e(r.data.resolution)}</p>` : ''}</article>`;
        })
        .join('') || '<p class="empty">Inga uppgifter i denna vy.</p>'
    }</div>`;
    target.querySelector('#task-filter').setAttribute('aria-label', 'Status');
    target.querySelector('#task-filter').onchange = (event) => onFilter(event.target.value);
  }
  target.querySelector('#team-owner').onchange = (event) => onOwner(event.target.value);
  target.querySelectorAll('[data-care-action]').forEach((b) => {
    b.onclick = () => onAction(b.dataset.careAction, b.dataset.id);
  });
}
