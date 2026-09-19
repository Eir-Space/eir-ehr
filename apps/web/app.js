import { escape as e, date, display } from './renderers/shared.js';
import { diagnosisFields, diagnosisPicker } from './diagnosis-picker.js';
import { renderCareTeam, clinicDay, moveDay, taskOpen, statusLabel } from './care-team.js';
import { draftEditor } from './draft-editor.js';
import { renderMedications, renderLabs, workflowAction } from './clinical-workflows.js';
const $ = (s) => document.querySelector(s);
const state = {
  token: '',
  session: null,
  patients: [],
  chart: [],
  patient: null,
  tab: 'overview',
  renderer: 'timeline',
  publicDemo: false,
  view: 'chart',
  team: { appointments: [], tasks: [] },
  day: '',
  owner: '',
  taskFilter: 'open',
};
const icons = () => globalThis.lucide?.createIcons();
const icon = (name) => `<i data-lucide="${name}"></i>`;
const button = (action, label, ico, extra = '') =>
  `<button data-action="${action}" ${extra}>${ico ? icon(ico) : ''}${label}</button>`;
const field = (name, label, type = 'text', value = '', extra = '') =>
  `<label>${label}<input name="${name}" type="${type}" value="${e(value)}" ${extra} required></label>`;
const textField = (value = '') =>
  `<label>Journaltext<textarea name="text" required maxlength="20000">${e(value)}</textarea></label>`;
const kinds = (kind) => state.chart.filter((r) => r.kind === kind);
const encounter = () => kinds('encounter').find((r) => r.data.status === 'in-progress');
const canWrite = () => state.session?.actor.role === 'clinician';
let submitDialog;
let disposeDialog;
let activeDraft;
let dirtyDraft = false;
let busy = false;
window.addEventListener('beforeunload', (event) => {
  if (dirtyDraft) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('DOMContentLoaded', icons);
async function api(path, body, signal) {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(
      data.error +
        (data.fields ? ' · ' + data.fields.map((f) => f.path + ': ' + f.message).join('; ') : ''),
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
async function perform(fn) {
  if (busy) return;
  busy = true;
  $('#error').hidden = true;
  const inputs = [...document.querySelectorAll('#shell input, #shell select')].map((control) => ({
    control,
    disabled: control.disabled,
  }));
  inputs.forEach(({ control }) => {
    control.disabled = true;
  });
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    if ($('#dialog').open) $('#dialog-error').textContent = err.message;
    else {
      $('#error').textContent = err.message;
      $('#error').hidden = false;
    }
  } finally {
    busy = false;
    inputs.forEach(({ control, disabled }) => {
      control.disabled = disabled;
    });
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
    icons();
  }
}
async function login(token) {
  const form = $('#login-form');
  state.token = token;
  try {
    state.session = await api('/session');
    state.renderer = state.session.defaultRenderer;
    state.day = clinicDay(state.session.careTeam?.timeZone ?? 'Europe/Stockholm');
    form.reset();
    $('#identity').textContent =
      state.session.careTeam?.members.find((m) => m.id === state.session.actor.id)?.name ??
      state.session.actor.id;
    $('#workspace-nav').hidden = !canWrite();
    $('#register').hidden = !canWrite();
    await refreshPatients();
    $('#login').hidden = true;
    $('#shell').hidden = false;
    $('#project-community').hidden = true;
  } catch (err) {
    state.token = '';
    $('#login').hidden = false;
    $('#shell').hidden = true;
    $('#project-community').hidden = !state.publicDemo;
    $('#login-error').textContent = err.message;
  }
  icons();
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#local-login').disabled = true;
  await login(new FormData(event.currentTarget).get('token'));
  $('#local-login').disabled = false;
});
$('#start-demo').onclick = async () => {
  $('#login-error').textContent = '';
  $('#start-demo').disabled = true;
  try {
    const response = await fetch('/demo/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syntheticOnly: true }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Could not start the demo');
    $('.environment').title =
      'Separat arbetsyta med exempelpatienter. Återställs vid omladdning. Upphör ' +
      new Date(data.expiresAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    await login(data.token);
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    $('#start-demo').disabled = false;
  }
};
async function deployment() {
  try {
    const response = await fetch('/deployment.json');
    if (!response.ok) throw new Error('Unable to read deployment mode');
    const config = await response.json();
    if (config.mode !== 'public-demo') return;
    state.publicDemo = true;
    document.body.classList.add('public-demo');
    $('#login h1').textContent = 'Eir Journal';
    $('#demo-entry').hidden = false;
    $('#project-community').hidden = false;
    $('#token-field').hidden = true;
    $('#token-field input').disabled = true;
    $('#local-login').hidden = true;
    $('#local-hint').hidden = true;
    $('.environment').textContent = 'Demo';
  } catch {
    $('#login-error').textContent = 'Could not connect. Please reload the page.';
  }
}
void deployment();
$('#logout').onclick = () =>
  perform(async () => {
    await api('/logout', {});
    location.reload();
  });
$('#search').oninput = renderPatients;
$('#register').onclick = () => openRegistration();
const closeDialog = () =>
  perform(async () => {
    await activeDraft?.flush();
    $('#dialog').close();
    await refreshPatients();
  });
$('#cancel-dialog').onclick = closeDialog;
$('#dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDialog();
});
$('#dialog').addEventListener('close', () => {
  activeDraft?.dispose();
  activeDraft = undefined;
  disposeDialog?.();
  disposeDialog = undefined;
});
$('#dialog-form').onsubmit = (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  perform(async () => {
    await submitDialog(values);
    $('#dialog').close();
    await refreshPatients();
  });
};
function modal(title, fields, submit, label = 'Spara') {
  activeDraft?.dispose();
  activeDraft = undefined;
  disposeDialog?.();
  disposeDialog = undefined;
  submitDialog = submit;
  $('#dialog-title').textContent = title;
  $('#dialog-fields').innerHTML = fields;
  $('#dialog-error').textContent = '';
  $('#dialog-form button[type=submit]').textContent = label;
  $('#cancel-dialog').innerHTML = icon('x');
  $('#dialog').showModal();
  icons();
}
function openRegistration() {
  modal(
    'Registrera patient',
    field('name', 'Fullständigt namn') +
      field('birthDate', 'Födelsedatum', 'date') +
      `<label>ID-typ<select name="type"><option value="local">Lokalt reserv-ID</option>${state.publicDemo ? '' : '<option value="personnummer">Personnummer</option><option value="samordningsnummer">Samordningsnummer</option>'}</select></label>` +
      field('value', 'Identifierare', 'text', '', 'maxlength="64"'),
    async (values) => {
      const patient = await api('/patients', {
        name: values.name,
        birthDate: values.birthDate,
        identifier: { type: values.type, value: values.value },
      });
      state.patient = patient;
      state.tab = 'overview';
    },
  );
}
async function refreshPatients() {
  state.patients = await api('/patients');
  state.patient =
    state.patients.find((p) => p.id === state.patient?.id) ?? state.patients[0] ?? null;
  renderPatients();
  await refreshChart();
}

function memberName(id) {
  return state.session.careTeam?.members.find((m) => m.id === id)?.name ?? id;
}
function memberSelect(name, label, selected = state.session.actor.id) {
  return `<label>${label}<select name="${name}" aria-label="${e(label)}" required>${state.session.careTeam.members.map((m) => `<option value="${e(m.id)}" ${m.id === selected ? 'selected' : ''}>${e(m.name)} · ${e(m.profession)}</option>`).join('')}</select></label>`;
}
function patientSelect(selected = state.patient?.id) {
  return `<label>Patient<select name="patientId" required>${state.patients.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${e(p.data.name)} · ${e(p.data.identifier.value)}</option>`).join('')}</select></label>`;
}
function newTask(patientId) {
  modal(
    'Ny uppföljningsuppgift',
    (patientId ? '' : patientSelect()) +
      field('title', 'Uppgift') +
      field('due', 'Senast', 'date', state.day) +
      memberSelect('assigneeId', 'Ansvarig') +
      '<label>Prioritet<select name="priority"><option value="routine">Normal</option><option value="urgent">Hög</option></select></label>',
    (values) => {
      const { patientId: selected, ...input } = values;
      return api(`/patients/${patientId ?? selected}/records/task`, input);
    },
  );
}
function openDraft(original, current) {
  let record = original;
  const patientId = state.patient.id,
    clientId = crypto.randomUUID();
  modal(original ? 'Redigera utkast' : 'Ny journalanteckning', '', () => activeDraft.flush());
  activeDraft = draftEditor($('#dialog-fields'), {
    initial: record?.data.text ?? '',
    onDirty: (dirty) => {
      dirtyDraft = dirty;
    },
    async save(text) {
      try {
        record = record
          ? await transition(record, 'save', { text })
          : await api(`/patients/${patientId}/records/note`, {
              encounterId: current.id,
              clientId,
              text,
            });
      } catch (error) {
        // A response can be lost after commit. Reconcile before retrying or showing a conflict.
        try {
          const chart = await api(`/patients/${patientId}/chart`);
          const latest = chart.find((r) => r.id === record?.id || r.data.clientId === clientId);
          if (latest?.data.status === 'draft' && latest.data.text === text) {
            record = latest;
            return;
          }
          if (latest) {
            if (!record) record = latest;
            error.status = 409;
            error.message =
              'Den sparade versionen skiljer sig från din text. Granska den innan du fortsätter.';
          }
        } catch {
          /* Keep the unsaved text and original error if connectivity is still lost. */
        }
        throw error;
      }
    },
    async loadLatest() {
      const chart = await api(`/patients/${patientId}/chart`);
      return chart.find((r) => r.id === record?.id || r.data.clientId === clientId);
    },
    adoptLatest(latest) {
      record = latest;
    },
    onDiscard() {
      void perform(async () => {
        $('#dialog').close();
        await refreshPatients();
      });
    },
  });
}
async function refreshTeam() {
  state.team = await api(`/care-team?day=${encodeURIComponent(state.day)}`);
  renderCareTeam($('#content'), {
    mode: state.view,
    day: state.day,
    today: clinicDay(state.session.careTeam.timeZone),
    timeZone: state.session.careTeam.timeZone,
    data: state.team,
    patients: state.patients,
    members: state.session.careTeam.members,
    actorId: state.session.actor.id,
    owner: state.owner,
    filter: state.taskFilter,
    onAction: (name, id) => perform(() => careAction(name, id)),
    onDay: (day) =>
      perform(async () => {
        state.day = day;
        await refreshTeam();
      }),
    onOwner: (owner) =>
      perform(async () => {
        state.owner = owner;
        await refreshTeam();
      }),
    onFilter: (filter) =>
      perform(async () => {
        state.taskFilter = filter;
        await refreshTeam();
      }),
  });
  icons();
}
function bookingDialog(record) {
  const data = record?.data;
  modal(
    record ? 'Boka om besök' : 'Boka besök',
    (record ? '' : patientSelect()) +
      field(
        'localStart',
        `Tid (${state.session.careTeam.timeZone})`,
        'datetime-local',
        data?.localStart ?? `${state.day}T09:00`,
      ) +
      field(
        'durationMinutes',
        'Längd i minuter',
        'number',
        data?.durationMinutes ?? 30,
        'min="5" max="240" step="5"',
      ) +
      field('reason', 'Kontaktorsak', 'text', data?.reason ?? '') +
      memberSelect('practitionerId', 'Behandlare', data?.practitionerId) +
      `<label>Besöksform<select name="type">${[
        ['visit', 'Mottagning'],
        ['phone', 'Telefon'],
        ['video', 'Video'],
      ]
        .map(
          ([id, label]) =>
            `<option value="${id}" ${data?.type === id ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select></label>`,
    (values) => {
      const { patientId, ...input } = values;
      input.durationMinutes = Number(input.durationMinutes);
      return record
        ? api(`/appointments/${record.id}/reschedule`, { version: record.version, data: input })
        : api(`/patients/${patientId}/appointments`, input);
    },
    'Boka',
  );
}
async function careAction(name, id) {
  const appointment = state.team.appointments.find((r) => r.id === id);
  const task = state.team.tasks.find((r) => r.id === id);
  if (name === 'lab-task') {
    state.patient = state.patients.find((p) => p.id === task.patientId);
    state.view = 'chart';
    state.tab = 'labs';
    renderPatients();
    await refreshChart();
    document
      .querySelector(`[data-record-id="${task.data.linkedOrderId}"]`)
      ?.scrollIntoView({ block: 'center' });
    return;
  }
  if (name === 'chart') {
    state.patient = state.patients.find((p) => p.id === id);
    state.view = 'chart';
    state.tab = 'overview';
    renderPatients();
    await refreshChart();
    return;
  }
  if (name === 'book' || name === 'reschedule-appointment') return bookingDialog(appointment);
  if (name === 'new-task') return newTask();
  if (name === 'previous-day' || name === 'next-day')
    state.day = moveDay(state.day, name === 'previous-day' ? -1 : 1);
  if (name === 'today') state.day = clinicDay(state.session.careTeam.timeZone);
  if (name === 'cancel-appointment' || name === 'no-show')
    return modal(
      name === 'no-show' ? 'Markera utebliven' : 'Avboka besök',
      field('reason', 'Orsak'),
      (data) =>
        api(`/appointments/${id}/${name === 'no-show' ? 'no-show' : 'cancel'}`, {
          version: appointment.version,
          data,
        }),
    );
  if (name === 'arrive' || name === 'start-appointment') {
    await api(`/appointments/${id}/${name === 'arrive' ? 'arrive' : 'start'}`, {
      version: appointment.version,
      data: {},
    });
    if (name === 'start-appointment') return careAction('chart', appointment.patientId);
  }
  if (name === 'start-task') await transition(task, 'start');
  if (name === 'complete-task')
    return modal(
      'Slutför uppgift',
      `<p>${e(task.data.title)}</p>` + field('resolution', 'Åtgärd / resultat'),
      (values) => transition(task, 'complete', values),
      'Slutför',
    );
  if (name === 'assign-task')
    return modal(
      'Byt ansvarig',
      `<p>${e(task.data.title)}</p>` +
        memberSelect('assigneeId', 'Ny ansvarig', task.data.assigneeId ?? task.data.author) +
        field('reason', 'Orsak till överlämning'),
      (values) => transition(task, 'assign', values),
    );
  if (name === 'reschedule-task')
    return modal(
      'Ändra förfallodatum',
      field('due', 'Senast', 'date', task.data.due) + field('reason', 'Orsak'),
      (values) => transition(task, 'reschedule', values),
    );
  if (name === 'cancel-task' || name === 'reopen-task')
    return modal(
      name === 'cancel-task' ? 'Avbryt uppgift' : 'Öppna uppgift igen',
      field('reason', 'Orsak'),
      (values) => transition(task, name === 'cancel-task' ? 'cancel' : 'reopen', values),
    );
  if (name === 'task-history') {
    const history = await api(`/records/${id}/history`);
    return modal(
      'Uppgiftens historik',
      history
        .map(
          (r) =>
            `<div class="history-row"><strong>Version ${r.version} · ${statusLabel[r.data.status]}</strong><p>${e(r.data.title)}</p><small>${e(memberName(r.data.assigneeId ?? r.data.author))} · ${e(r.data.due)} · ${date(r.updatedAt)}</small><p>${e(r.data.resolution ?? r.data.reopenedReason ?? r.data.rescheduleReason ?? r.data.assignmentReason ?? '')}</p></div>`,
        )
        .join(''),
      async () => {},
      'Stäng',
    );
  }
  await refreshPatients();
}
function renderPatients() {
  const query = $('#search').value.toLocaleLowerCase();
  $('#patients').innerHTML =
    state.patients
      .filter((p) =>
        (p.data.name + ' ' + p.data.identifier.value).toLocaleLowerCase().includes(query),
      )
      .map(
        (p) =>
          `<button class="patient-option ${p.id === state.patient?.id ? 'active' : ''}" data-patient="${p.id}"><span class="avatar">${e(
            p.data.name
              .split(' ')
              .map((s) => s[0])
              .slice(0, 2)
              .join(''),
          )}</span><span>${e(p.data.name)}<small>${e(p.data.birthDate)} · ${e(p.data.identifier.value)}</small></span></button>`,
      )
      .join('') || '<p class="empty">Inga patienter.</p>';
  $('#patient-count').textContent = `${state.patients.length} patienter med åtkomst`;
  $('#patients')
    .querySelectorAll('button')
    .forEach(
      (b) =>
        (b.onclick = () =>
          perform(async () => {
            state.patient = state.patients.find((p) => p.id === b.dataset.patient);
            state.view = 'chart';
            renderPatients();
            await refreshChart();
          })),
    );
}
async function refreshChart() {
  state.chart = state.patient ? await api(`/patients/${state.patient.id}/chart`) : [];
  await render();
}
async function render() {
  $('#workspace-nav')
    .querySelectorAll('button')
    .forEach((b) => {
      b.classList.toggle('active', b.dataset.view === state.view);
      b.setAttribute('aria-current', b.dataset.view === state.view ? 'page' : 'false');
      b.onclick = () =>
        perform(async () => {
          state.view = b.dataset.view;
          await refreshChart();
        });
    });
  $('#patient-header').hidden = state.view !== 'chart';
  $('#tabs').hidden = state.view !== 'chart';
  if (state.view !== 'chart') {
    await refreshTeam();
    return;
  }
  const p = state.patient;
  $('#notice').textContent = '';
  if (!p) {
    $('#patient-header').innerHTML = '<h1>Patientlista</h1>';
    $('#tabs').innerHTML = '';
    $('#content').innerHTML =
      '<p class="empty">Registrera en patient för att öppna en journal.</p>';
    return;
  }
  const open = encounter();
  $('#patient-header').innerHTML =
    `<div><h1>${e(p.data.name)}</h1><p class="quiet">${e(p.data.identifier.value)} &nbsp; · &nbsp; ${e(p.data.birthDate)}</p><p class="encounter">${icon('circle-dot')}${open ? e(open.data.reason) : 'Ingen pågående vårdkontakt'}</p></div><div class="actions">${button('export', 'Exportera', 'download')}${canWrite() ? (open ? button('close', 'Avsluta kontakt', 'check') : button('encounter', 'Ny vårdkontakt', 'plus', 'class="primary"')) : ''}</div>`;
  const tabs = [
    ['overview', 'Översikt'],
    ['journal', 'Journal'],
    ['notes', 'Anteckningar'],
    ...(canWrite()
      ? [
          ['medications', 'Läkemedel'],
          ['labs', 'Prover och svar'],
        ]
      : []),
    ['tasks', 'Uppgifter'],
    ['ai', 'AI-granskning'],
    ['plugins', 'Moduler'],
  ];
  $('#tabs').innerHTML = tabs
    .map(
      ([id, label]) =>
        `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${label}</button>`,
    )
    .join('');
  $('#tabs')
    .querySelectorAll('button')
    .forEach(
      (b) =>
        (b.onclick = () =>
          perform(async () => {
            state.tab = b.dataset.tab;
            await render();
          })),
    );
  const content = $('#content');
  if (state.tab === 'overview') renderOverview(content);
  if (state.tab === 'journal') {
    content.innerHTML = `<div class="toolbar"><h2>Journalhändelser</h2><label>Visning<select id="renderer" disabled>${state.session.renderers.map((r) => `<option value="${r}" ${r === state.renderer ? 'selected' : ''}>${r === 'table' ? 'Tabell' : 'Tidslinje'}</option>`).join('')}</select></label></div><div id="record-view"></div>`;
    const renderer = await import(`/renderers/${state.renderer}.js`);
    renderer.render(
      $('#record-view'),
      state.chart.filter((r) => !['patient', 'proposal'].includes(r.kind)),
    );
    $('#renderer').onchange = () =>
      perform(async () => {
        state.renderer = $('#renderer').value;
        await render();
      });
    $('#renderer').disabled = false;
  }
  if (state.tab === 'notes') renderNotes(content);
  if (state.tab === 'medications' && canWrite())
    renderMedications(content, state.chart, memberName);
  if (state.tab === 'labs' && canWrite())
    renderLabs(content, state.chart, state.session.actor.id, memberName, !!open);
  if (state.tab === 'tasks') renderTasks(content);
  if (state.tab === 'ai') renderAI(content);
  if (state.tab === 'plugins') {
    const plugins = await api('/plugins');
    content.innerHTML = `<div class="toolbar"><h2>Aktiva moduler</h2><span class="quiet">${plugins.length} aktiva</span></div>${plugins.map((p) => `<div class="plugin"><strong>${e(p.id)}</strong><code>${e(p.provides.join(', '))}</code><span class="badge">v${e(p.version)}</span></div>`).join('')}<div class="band"><div class="section-title"><h2>Nationella anslutningar</h2></div><div class="row"><span>SITHS / HSA</span><span class="badge draft">Ej ansluten</span></div><div class="row"><span>NPÖ / 1177 Journalen</span><span class="badge draft">Ej ansluten</span></div><div class="row"><span>Nationella läkemedelslistan</span><span class="badge draft">Ej ansluten</span></div></div>`;
  }
  bindActions();
  icons();
}
function renderOverview(target) {
  const allergy = kinds('allergy').filter((x) => x.data.status === 'active');
  const problems = kinds('condition').filter((x) => x.data.status === 'active');
  const readings = kinds('observation')
    .filter((x) => x.data.status === 'final')
    .sort(
      (a, b) =>
        Date.parse(b.data.effectiveAt) - Date.parse(a.data.effectiveAt) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const observations = Object.keys(state.session.vitals)
    .map((code) => readings.find((r) => r.data.code === code))
    .filter(Boolean);
  const correction = (r) =>
    canWrite()
      ? button(
          'correct',
          '',
          'pencil',
          `data-id="${r.id}" title="Rätta uppgift" aria-label="Rätta ${e(r.data.display ?? r.data.code?.display ?? r.data.substance)}"`,
        )
      : '';
  const previous = (r) => {
    const value = readings.find(
      (v) =>
        v.data.code === r.data.code &&
        Date.parse(v.data.effectiveAt) < Date.parse(r.data.effectiveAt),
    );
    return value
      ? `<small>Tidigare ${e(value.data.value)} · ${date(value.data.effectiveAt)}</small>`
      : '';
  };
  const codeLabel = (coding) =>
    coding.system === 'http://hl7.org/fhir/sid/icd-10-se'
      ? `ICD-10-SE${coding.version ? ' ' + coding.version.slice(0, 4) : ''}`
      : coding.system;
  target.innerHTML = `<div class="split"><div>
    <section class="band"><div class="section-title"><h2>Aktuella diagnoser</h2>${canWrite() ? button('condition', 'Lägg till', 'plus') : ''}</div>
      ${problems.map((r) => `<div class="row"><div><strong>${e(r.data.code.display)}</strong><small>${e(r.data.code.code)} · ${e(codeLabel(r.data.code))}</small></div>${correction(r)}</div>`).join('') || '<p class="empty">Inga diagnoser registrerade.</p>'}
    </section>
    <section class="band"><div class="section-title"><h2>Mätvärden</h2>${canWrite() && encounter() ? button('observation', 'Registrera', 'plus') : ''}</div>
      ${observations.map((r) => `<div class="row vital-row"><div><strong>${e(r.data.display)}</strong><small>${date(r.data.effectiveAt)}</small>${previous(r)}</div><div class="metric"><strong>${e(r.data.value)}</strong><span>${e(r.data.unit)}</span></div>${correction(r)}</div>`).join('') || '<p class="empty">Inga mätvärden registrerade.</p>'}
    </section>
    <section class="band"><div class="section-title"><h2>Senaste anteckning</h2></div>${kinds('note')[0] ? `<p class="note-preview">${e(kinds('note')[0].data.text)}</p>` : '<p class="empty">Ingen anteckning ännu.</p>'}</section>
    </div><aside><section class="band"><div class="section-title"><h2>Överkänslighet</h2>${canWrite() ? button('allergy', '', 'plus', 'title="Registrera överkänslighet" aria-label="Registrera överkänslighet"') : ''}</div>
      ${allergy.map((r) => `<div class="safety"><strong>${e(r.data.substance)}</strong><p>${e(r.data.reaction)}</p>${correction(r)}</div>`).join('') || '<p class="empty">Uppgift saknas. Allergifrihet är inte bekräftad.</p>'}
    </section><section class="band"><div class="section-title"><h2>Att följa upp</h2></div>${
      kinds('task')
        .filter(taskOpen)
        .sort((a, b) => a.data.due.localeCompare(b.data.due))
        .map(
          (r) =>
            `<div class="row"><div><strong>${e(r.data.title)}</strong><small>${e(r.data.due)}</small></div></div>`,
        )
        .join('') || '<p class="empty">Inga öppna uppgifter.</p>'
    }</section></aside></div>`;
}
function renderNotes(target) {
  target.innerHTML = `<div class="toolbar"><h2>Journalanteckningar</h2>${canWrite() && encounter() ? button('note', 'Ny anteckning', 'plus', 'class="primary"') : ''}</div>${
    kinds('note')
      .map(
        (r) =>
          `<article class="note"><header><div><strong>${r.data.amends ? 'Tillägg till journalanteckning' : 'Journalanteckning'}</strong><small> · ${date(r.createdAt)}</small></div><span class="badge ${r.data.status === 'draft' ? 'draft' : ''}">${r.data.status === 'signed' ? 'Signerad' : 'Utkast'}</span></header><p>${e(r.data.text)}</p><small>${e(r.data.author)}${r.data.signedBy ? ' · Signerad av ' + e(r.data.signedBy) : ''}${r.data.proposalId ? ' · AI-understött utkast' : ''}</small><footer>${button('history', 'Versioner', 'history', `data-id="${r.id}"`)}${canWrite() ? (r.data.status === 'draft' ? button('edit-note', 'Redigera', 'pencil', `data-id="${r.id}"`) + button('sign', 'Signera', 'check', `data-id="${r.id}" class="primary"`) : button('amend', 'Skriv tillägg', 'plus', `data-id="${r.id}"`)) : ''}</footer></article>`,
      )
      .join('') || '<p class="empty">Inga anteckningar.</p>'
  }`;
}
function renderTasks(target) {
  target.innerHTML = `<div class="toolbar"><h2>Uppföljning</h2>${canWrite() ? button('task', 'Ny uppgift', 'plus') : ''}</div>${
    kinds('task')
      .map(
        (r) =>
          `<div class="row"><div><strong>${e(r.data.title)}</strong><small>Senast ${e(r.data.due)} · ${e(memberName(r.data.assigneeId ?? r.data.author))}</small></div><div class="actions"><span class="badge">${statusLabel[r.data.status]}</span>${r.data.linkedOrderId ? button('open-labs', 'Provsvar', 'flask-conical') : canWrite() && taskOpen(r) && (r.data.assigneeId ?? r.data.author) === state.session.actor.id ? button('complete', 'Markera klar', 'check', `data-id="${r.id}"`) : ''}</div></div>`,
      )
      .join('') || '<p class="empty">Inga uppgifter.</p>'
  }`;
}
function renderAI(target) {
  target.innerHTML = `<div class="toolbar"><h2>Förslag för aktuell vårdkontakt</h2>${canWrite() && encounter() ? button('propose', 'Skapa journalförslag', 'sparkles', 'class="primary"') : ''}</div>${
    kinds('proposal')
      .map(
        (r) =>
          `<article class="note"><header><div><strong>${r.data.mode === 'extractive' ? 'Källsammanställning' : 'Modellförslag'}</strong><small> · ${e(r.data.model)}</small></div><span class="badge ${r.data.status === 'pending' ? 'draft' : ''}">${e(r.data.status)}</span></header>${r.data.status === 'pending' && canWrite() ? `<label>Journaltext att granska<textarea id="proposal-${r.id}">${e(r.data.text)}</textarea></label>` : `<p>${e(r.data.text)}</p>`}<details class="evidence"><summary>${r.data.citations.length} källhänvisningar</summary>${r.data.citations.map((c) => `<p>${e(c.text)}<br><small>${e(c.ref)}</small></p>`).join('')}</details>${r.data.status === 'pending' && canWrite() ? `<footer>${button('reject', 'Avvisa', 'x', `data-id="${r.id}"`)}${button('accept', 'Spara granskat utkast', 'check', `data-id="${r.id}" class="primary"`)}</footer>` : ''}</article>`,
      )
      .join('') || '<p class="empty">Inga förslag att granska.</p>'
  }`;
}
const create = (kind, data) => api(`/patients/${state.patient.id}/records/${kind}`, data);
const transition = (record, action, data = {}) =>
  api(`/records/${record.id}/${action}`, { version: record.version, data });
function bindActions() {
  document
    .querySelectorAll('[data-action]')
    .forEach((b) => (b.onclick = () => perform(() => action(b.dataset.action, b.dataset.id))));
}
async function action(name, id) {
  const r = state.chart.find((r) => r.id === id);
  const current = encounter();
  if (name === 'open-labs') {
    state.tab = 'labs';
    return render();
  }
  if (name.startsWith('med-') || name.startsWith('lab-'))
    return workflowAction(name, id, {
      chart: state.chart,
      patientId: state.patient.id,
      encounterId: current?.id,
      actorId: state.session.actor.id,
      memberName,
      memberSelect,
      api,
      modal,
    });
  if (name === 'encounter')
    return modal('Ny vårdkontakt', field('reason', 'Kontaktorsak'), (values) =>
      create('encounter', values),
    );
  if (name === 'note') return openDraft(null, current);
  if (name === 'edit-note') return openDraft(r, current);
  if (name === 'amend')
    return modal(
      'Tillägg till signerad anteckning',
      field('reason', 'Orsak till tillägg') + textField(),
      (values) => transition(r, 'amend', values),
    );
  if (name === 'sign')
    return modal(
      'Signera journalanteckning',
      `<p>${e(r.data.text)}</p><p class="quiet">Signeras av ${e(state.session.actor.id)}. Ändringar efter signering görs som tillägg.</p>`,
      () => transition(r, 'sign'),
      'Signera',
    );
  if (name === 'task') return newTask(state.patient.id);
  if (name === 'condition') {
    let picker;
    modal('Registrera diagnos', diagnosisFields, (values) =>
      create('condition', {
        code: picker.value(),
        ...(values.onset ? { onset: values.onset } : {}),
      }),
    );
    picker = diagnosisPicker(
      $('#dialog-fields'),
      (query, signal) =>
        api(`/terminology/diagnoses?q=${encodeURIComponent(query)}`, undefined, signal),
      () => {
        $('#dialog-error').textContent = '';
      },
    );
    disposeDialog = () => picker.dispose();
    return;
  }
  if (name === 'allergy')
    return modal(
      'Registrera överkänslighet',
      field('substance', 'Ämne') +
        field('reaction', 'Reaktion') +
        `<label>Risk för allvarlig reaktion<select name="criticality"><option value="unable-to-assess">Ej bedömd</option><option value="high">Hög</option><option value="low">Låg</option></select></label>`,
      (values) => create('allergy', values),
    );
  if (name === 'observation') {
    modal(
      'Registrera mätvärde',
      `<label>Mätning<select name="code" id="vital-code">${Object.entries(state.session.vitals)
        .map(([code, v]) => `<option value="${code}">${e(v.label)} (${e(v.unit)})</option>`)
        .join('')}</select></label>` + field('value', 'Värde', 'number', '', 'step="any"'),
      (values) =>
        create('observation', {
          encounterId: current.id,
          code: values.code,
          value: Number(values.value),
          unit: state.session.vitals[values.code].unit,
          effectiveAt: new Date().toISOString(),
        }),
    );
    return;
  }
  if (name === 'correct')
    return modal(
      'Rätta journaluppgift',
      `<p>${e(display(r))}</p>` + field('reason', 'Orsak till rättelse'),
      (values) => transition(r, 'correct', values),
      'Markera felregistrerad',
    );
  if (name === 'history') {
    const history = await api(`/records/${id}/history`);
    modal(
      'Versionshistorik',
      history
        .map(
          (v) =>
            `<div class="history-row"><strong>Version ${v.version} · ${e(v.data.status)}</strong><p>${e(v.data.text ?? display(v))}</p><small>${date(v.updatedAt)}</small></div>`,
        )
        .join(''),
      async () => {},
      'Stäng',
    );
    return;
  }
  if (name === 'complete') await transition(r, 'complete');
  if (name === 'close') await transition(current, 'close');
  if (name === 'propose')
    await api(`/patients/${state.patient.id}/ai`, { encounterId: current.id });
  if (name === 'accept' || name === 'reject')
    await api(`/proposals/${id}/review`, {
      version: r.version,
      decision: name === 'accept' ? 'accept' : 'reject',
      ...(name === 'accept' ? { text: $(`#proposal-${id}`).value } : {}),
    });
  if (name === 'export') {
    const bundle = await api(`/patients/${state.patient.id}/export/fhir`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/fhir+json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'eir-patient-export.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  await refreshChart();
}
