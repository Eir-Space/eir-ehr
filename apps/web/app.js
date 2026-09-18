import { escape as e, date, display } from './renderers/shared.js';
import { diagnosisFields, diagnosisPicker } from './diagnosis-picker.js';
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
let busy = false;
window.addEventListener('DOMContentLoaded', icons);
async function api(path, body, signal) {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error +
        (data.fields ? ' · ' + data.fields.map((f) => f.path + ': ' + f.message).join('; ') : ''),
    );
  return data;
}
async function perform(fn) {
  if (busy) return;
  busy = true;
  $('#error').hidden = true;
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
    $('#login').hidden = true;
    $('#shell').hidden = false;
    $('#project-community').hidden = true;
    form.reset();
    $('#identity').textContent = state.session.actor.id;
    $('#register').hidden = !canWrite();
    await refreshPatients();
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
$('#cancel-dialog').onclick = () => $('#dialog').close();
$('#dialog').addEventListener('close', () => {
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
  disposeDialog?.();
  disposeDialog = undefined;
  submitDialog = submit;
  $('#dialog-title').textContent = title;
  $('#dialog-fields').innerHTML = fields;
  $('#dialog-error').textContent = '';
  $('#dialog-form button[type=submit]').textContent = label;
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
        .filter((r) => r.data.status === 'requested')
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
          `<div class="row"><div><strong>${e(r.data.title)}</strong><small>Senast ${e(r.data.due)}</small></div><div class="actions"><span class="badge">${r.data.status === 'completed' ? 'Klar' : 'Öppen'}</span>${canWrite() && r.data.status === 'requested' ? button('complete', 'Markera klar', 'check', `data-id="${r.id}"`) : ''}</div></div>`,
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
  if (name === 'encounter')
    return modal('Ny vårdkontakt', field('reason', 'Kontaktorsak'), (values) =>
      create('encounter', values),
    );
  if (name === 'note')
    return modal('Ny journalanteckning', textField(), (values) =>
      create('note', { ...values, encounterId: current.id }),
    );
  if (name === 'edit-note')
    return modal('Redigera utkast', textField(r.data.text), (values) =>
      transition(r, 'save', values),
    );
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
  if (name === 'task')
    return modal(
      'Ny uppföljningsuppgift',
      field('title', 'Uppgift') + field('due', 'Senast', 'date'),
      (values) => create('task', values),
    );
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
