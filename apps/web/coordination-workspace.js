import { escape as e, date } from './renderers/shared.js';
const views = new WeakMap();
const kinds = {
  'care-request': 'Vårdbegäran',
  admission: 'Inskrivning',
  planning: 'Planering',
  'discharge-ready': 'Utskrivningsklar',
  discharge: 'Utskrivning',
  'care-transfer': 'Vård och omsorg',
  administrative: 'Administrativt',
  referral: 'Hänvisning',
  interruption: 'Avbrott',
  'sip-invitation': 'SIP-kallelse',
};
const phases = {
  open: 'Påbörjat',
  admitted: 'Inskriven',
  ready: 'Utskrivningsklar',
  discharged: 'Utskriven',
  interrupted: 'Avbrutet',
};
const planStatus = {
  draft: 'Utkast',
  invited: 'För bekräftelse',
  agreed: 'Färdig SIP',
  closed: 'Avslutad',
};
const tool = (id, title, icon, extra = '') =>
  `<button data-sam="${id}" ${extra} aria-label="${e(title)}" title="${e(title)}"><i data-lucide="${icon}"></i></button>`;
const field = (name, label, value = '', type = 'text') =>
  `<label>${e(label)}<input name="${name}" aria-label="${e(label)}" type="${type}" value="${e(value)}" required></label>`;
const area = (name, label, value = '') =>
  `<label>${e(label)}<textarea name="${name}" aria-label="${e(label)}" maxlength="8000" required>${e(value)}</textarea></label>`;
const choose = (name, label, options, selected) =>
  `<label>${e(label)}<select name="${name}" aria-label="${e(label)}">${options.map(([id, text]) => `<option value="${e(id)}" ${id === selected ? 'selected' : ''}>${e(text)}</option>`).join('')}</select></label>`;
const picked = (values, prefix) =>
  Object.keys(values)
    .filter((k) => k.startsWith(prefix) && values[k] === 'on')
    .map((k) => k.slice(prefix.length));
const localTime = (value) => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function download(file) {
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function renderCoordination(target, ctx) {
  let view = views.get(target);
  if (!view || view.scope !== ctx.actor.assignmentId) {
    view = {
      scope: ctx.actor.assignmentId,
      selected: null,
      tab: 'messages',
      status: 'open',
      after: '',
    };
    views.set(target, view);
  }
  const { api, modal, perform, patientSelect, actor, permissions } = ctx;
  const workspace = await api(
    `/coordination?status=${view.status}${view.after ? '&after=' + encodeURIComponent(view.after) : ''}`,
  );
  if (!workspace.items.some((i) => i.id === view.selected))
    view.selected = workspace.items[0]?.id ?? null;
  const detail = view.selected ? await api(`/coordination/cases/${view.selected}`) : null;
  const record = detail?.record,
    units = workspace.units,
    own = units.find((u) => u.id === actor.unitId);
  const canWrite =
    workspace.enabled && permissions.includes('coordination.write') && !detail?.readOnly;
  const canManage =
    !detail?.readOnly &&
    permissions.includes('coordination.manage') &&
    record?.data.ownerUnitId === actor.unitId;
  const unitName = (id) => units.find((u) => u.id === id)?.name ?? id;
  const checks = (prefix, selected, excludeSelf = false) =>
    `<fieldset class="sam-checks"><legend>${prefix === 'party-' ? 'Deltagande enheter' : 'Mottagare'}</legend>${units
      .filter((u) => !excludeSelf || u.id !== actor.unitId)
      .map(
        (u) =>
          `<label><input type="checkbox" name="${prefix}${e(u.id)}" ${selected.includes(u.id) ? 'checked' : ''}>${e(u.name)}</label>`,
      )
      .join('')}</fieldset>`;
  const refresh = () => renderCoordination(target, ctx);
  if (
    (view.tab === 'sip' && !workspace.features.sip) ||
    (view.tab === 'documents' && !workspace.features.documents)
  )
    view.tab = 'messages';
  target.innerHTML = `<div class="workspace-heading"><div><p class="eyebrow">${e(workspace.unit)}</p><h1>Eir Samverkan</h1></div><div class="actions"><span class="badge ${workspace.enabled ? '' : 'draft'}">${workspace.enabled ? 'Aktiv' : 'Avstängd'}</span>${canWrite ? tool('new', 'Nytt samverkansärende', 'plus') : ''}${tool('refresh', 'Uppdatera samverkan', 'refresh-cw')}${permissions.includes('coordination.export') ? tool('report', 'Exportera ärendelistan', 'download') : ''}</div></div>
    <div class="sam-layout"><aside class="sam-inbox"><div class="sam-filter">${choose(
      'sam-status',
      'Ärendestatus',
      [
        ['open', 'Öppna'],
        ['closed', 'Avslutade'],
      ],
      view.status,
    )}<strong>${workspace.items.length} ärenden på sidan</strong></div>${workspace.items.map((r) => `<button class="sam-case ${view.selected === r.id ? 'selected' : ''}" data-sam-case="${r.id}"><strong>${e(r.data.patient.name)}</strong><span>${e(r.data.title)}</span><small>${r.consentActive ? e(phases[r.data.phase]) : 'Samtycke saknas'}${r.unread ? ` · ${r.unread} okvitterade` : ''}</small></button>`).join('') || '<p class="empty">Inga ärenden i inkorgen.</p>'}<div class="actions">${view.after ? tool('first', 'Första ärendesidan', 'chevrons-left') : ''}${workspace.nextCursor ? tool('next', 'Nästa ärendesida', 'chevron-right') : ''}</div></aside>
    <section class="sam-case-content">${
      record
        ? `<header class="sam-case-heading"><div><h2>${e(record.data.patient.name)}</h2><small>${e(record.data.patient.identifier.value)} · ${e(record.data.title)}</small></div><div class="actions"><span class="badge">${e(phases[record.data.phase])}</span>${workspace.features.documents && detail.consentActive && permissions.includes('coordination.export') ? tool('pdf', 'Exportera ärende och SIP som PDF', 'file-down') : ''}${canWrite && detail.consentActive && record.data.status === 'open' && (record.data.ownerUnitId === actor.unitId || own.kind === 'municipality') ? tool('close', 'Avsluta samverkansärende', 'check-check') : ''}</div></header>
      <div class="sam-parties">${detail.parties.map((p) => `<span>${e(unitName(p.data.unitId))}${p.data.readOnly ? ' · Läsbehörighet' : ''}</span>`).join('')}</div>
      <div class="sam-consent"><span class="badge ${detail.consentActive ? '' : 'draft'}">${detail.consentActive ? 'Samtycke till ' + date(record.data.consent.validUntil) : 'Samtycke krävs för delning'}</span><div class="actions">${canManage ? tool('consent', 'Dokumentera samtycke', 'shield-check') + (canWrite && detail.consentActive ? tool('parties', 'Hantera deltagande enheter', 'users') : '') : ''}</div></div>
      ${
        detail.consentActive
          ? `<nav class="sam-tabs" aria-label="Samverkansvyer">${[
              ['messages', 'Meddelanden'],
              ['sip', 'SIP'],
              ['documents', 'Bilagor'],
              ['responsibility', 'Ansvar och betalning'],
              ['history', 'Historik'],
            ]
              .filter(([id]) => (id !== 'sip' && id !== 'documents') || workspace.features[id])
              .map(
                ([id, label]) =>
                  `<button data-sam-tab="${id}" aria-current="${view.tab === id ? 'page' : 'false'}">${label}</button>`,
              )
              .join('')}</nav><div id="sam-panel"></div>`
          : '<p class="empty">Ingen information delas innan samtycke har dokumenterats.</p>'
      }`
        : '<p class="empty">Välj ett ärende eller skapa ett nytt.</p>'
    }</section></div>`;
  const formAction = (title, fields, submit, label) => modal(title, fields, submit, label);
  const afterPost = async (path, body) => {
    const result = await api(path, body);
    return result;
  };
  const prefix = record ? `/coordination/cases/${record.id}` : '';
  const actions = {
    refresh,
    first: async () => {
      view.after = '';
      view.selected = null;
      await refresh();
    },
    next: async () => {
      view.after = workspace.nextCursor;
      view.selected = null;
      await refresh();
    },
    new: () =>
      formAction(
        'Nytt samverkansärende',
        patientSelect() +
          field('title', 'Ärende') +
          choose(
            'pathway',
            'Process',
            [
              ['inpatient', 'In- och utskrivning'],
              ['outpatient', 'Öppenvård'],
              ['sip', 'SIP'],
            ],
            'inpatient',
          ) +
          checks(
            'party-',
            units.filter((u) => u.id !== actor.unitId).map((u) => u.id),
            true,
          ),
        async (v) => {
          const row = await api('/coordination/cases', {
            patientId: v.patientId,
            title: v.title,
            pathway: v.pathway,
            participants: picked(v, 'party-'),
          });
          view.selected = row.id;
          view.status = 'open';
          view.after = '';
        },
      ),
    consent: () =>
      formAction(
        'Dokumentera samtycke',
        choose(
          'granted',
          'Samtycke',
          [...(canWrite ? [['true', 'Lämnat samtycke']] : []), ['false', 'Återkallat samtycke']],
          canWrite ? String(record.data.consent.granted) : 'false',
        ) +
          field(
            'validUntil',
            'Giltigt till',
            localTime(Date.now() + 30 * 86400000),
            'datetime-local',
          ) +
          area('note', 'Hur samtycket lämnades eller återkallades'),
        (v) =>
          afterPost(prefix + '/consent', {
            version: record.version,
            granted: v.granted === 'true',
            validUntil: new Date(v.validUntil).toISOString(),
            unitIds: detail.parties.map((p) => p.data.unitId),
            note: v.note,
          }),
      ),
    parties: () =>
      formAction(
        'Hantera deltagande enheter',
        choose(
          'unitId',
          'Enhet',
          units.filter((u) => u.id !== actor.unitId).map((u) => [u.id, u.name]),
        ) +
          choose(
            'active',
            'Deltagande',
            [
              ['true', 'Aktiv'],
              ['false', 'Ta bort åtkomst'],
            ],
            'true',
          ) +
          choose(
            'readOnly',
            'Behörighet',
            [
              ['false', 'Medverka'],
              ['true', 'Läsa'],
            ],
            'false',
          ) +
          area('reason', 'Orsak'),
        (v) =>
          afterPost(prefix + '/action', {
            action: 'participant',
            version: record.version,
            unitId: v.unitId,
            active: v.active === 'true',
            readOnly: v.readOnly === 'true',
            reason: v.reason,
          }),
      ),
    close: () =>
      formAction('Avsluta samverkansärende', area('reason', 'Avslutsorsak'), (v) =>
        afterPost(prefix + '/action', {
          action: 'close',
          version: record.version,
          reason: v.reason,
        }),
      ),
    pdf: async () => download(await api(prefix + '/pdf')),
    report: async () =>
      download(
        await api(
          `/coordination/report?status=${view.status}${view.after ? '&after=' + encodeURIComponent(view.after) : ''}`,
        ),
      ),
  };
  target.querySelector('[name=sam-status]').onchange = (ev) =>
    perform(async () => {
      view.status = ev.target.value;
      view.after = '';
      view.selected = null;
      await refresh();
    });
  target.querySelectorAll('[data-sam-case]').forEach(
    (b) =>
      (b.onclick = () =>
        perform(async () => {
          view.selected = b.dataset.samCase;
          await refresh();
        })),
  );
  target.querySelectorAll('[data-sam-tab]').forEach(
    (b) =>
      (b.onclick = () =>
        perform(async () => {
          view.tab = b.dataset.samTab;
          await refresh();
        })),
  );
  const panel = target.querySelector('#sam-panel');
  const send = (replyTo, sender) => {
    const options = Object.entries(kinds).filter(
      ([id]) =>
        id !== 'sip-invitation' &&
        (!['admission', 'discharge-ready', 'discharge', 'interruption'].includes(id) ||
          (own.kind === 'hospital' && record.data.pathway === 'inpatient')),
    );
    formAction(
      replyTo ? 'Svara på meddelande' : 'Nytt samverkansmeddelande',
      choose('type', 'Meddelandetyp', options, 'administrative') +
        area('body', 'Meddelande') +
        field(
          'expectedDischargeAt',
          'Beräknad utskrivning',
          localTime(Date.now() + 2 * 86400000),
          'datetime-local',
        ) +
        checks(
          'recipient-',
          sender
            ? [sender]
            : detail.parties
                .filter((p) => p.data.unitId !== actor.unitId)
                .map((p) => p.data.unitId),
          true,
        ),
      (v) =>
        afterPost(prefix + '/messages', {
          version: record.version,
          type: v.type,
          body: v.body,
          recipients: picked(v, 'recipient-'),
          ...(replyTo ? { replyTo } : {}),
          ...(v.type === 'admission'
            ? { expectedDischargeAt: new Date(v.expectedDischargeAt).toISOString() }
            : {}),
        }),
      'Skicka',
    );
  };
  if (panel && view.tab === 'messages') {
    panel.innerHTML = `<div class="toolbar"><h3>Meddelandetråd</h3>${canWrite && record.data.status === 'open' ? '<button data-sam="send"><i data-lucide="send"></i>Nytt meddelande</button>' : ''}</div>${
      detail.messages
        .map((m) => {
          const receipts = detail.receipts.filter((r) => r.data.messageId === m.id),
            receipt = receipts.find((r) => r.data.unitId === actor.unitId);
          return `<article class="sam-message ${m.data.status === 'withdrawn' ? 'withdrawn' : ''}"><header><strong>${e(kinds[m.data.type] ?? m.data.type)}</strong><time>${date(m.data.sentAt)}</time></header><small>${e(unitName(m.data.senderUnitId))} till ${e(m.data.recipients.map(unitName).join(', '))}${m.data.replyTo ? ' · Svar i tråd' : ''}</small><p>${e(m.data.body)}</p>${m.data.status === 'withdrawn' ? `<p>Makulering: ${e(m.data.reason)}</p>` : `<div class="sam-receipts">${receipts.map((r) => `<span>${e(unitName(r.data.unitId))}: ${r.data.status === 'acknowledged' ? 'Kvitterat ' + date(r.data.acknowledgedAt) : 'Ej kvitterat'}</span>`).join('')}</div>`}<footer class="actions">${canWrite && receipt?.data.status === 'unread' ? `<button data-sam-ack="${m.id}" data-version="${receipt.version}"><i data-lucide="check"></i>Kvittera</button>` : ''}${canWrite && m.data.status === 'sent' && record.data.status === 'open' ? tool('reply', 'Svara', 'reply', `data-message="${m.id}"`) + (m.data.senderUnitId === actor.unitId ? tool('withdraw', 'Makulera meddelande', 'undo-2', `data-message="${m.id}"`) : '') : ''}</footer></article>`;
        })
        .join('') || '<p class="empty">Inga meddelanden ännu.</p>'
    }`;
    actions.send = () => send();
    target.querySelectorAll('[data-sam-ack]').forEach(
      (b) =>
        (b.onclick = () =>
          perform(async () => {
            await api(`/coordination/messages/${b.dataset.samAck}/acknowledge`, {
              version: Number(b.dataset.version),
            });
            await refresh();
          })),
    );
    actions.reply = (b) => {
      const m = detail.messages.find((m) => m.id === b.dataset.message);
      send(m.id, m.data.senderUnitId === actor.unitId ? undefined : m.data.senderUnitId);
    };
    actions.withdraw = (b) => {
      const m = detail.messages.find((m) => m.id === b.dataset.message);
      formAction('Makulera meddelande', area('reason', 'Orsak'), (v) =>
        api(`/coordination/messages/${m.id}/withdraw`, { version: m.version, reason: v.reason }),
      );
    };
  }
  if (panel && view.tab === 'sip') {
    const plan = await api(prefix + '/sip'),
      f = plan?.data.fields;
    panel.innerHTML = `<div class="toolbar"><h3>Samordnad individuell plan</h3><span class="badge">${plan ? e(planStatus[plan.data.status]) : 'Ingen plan'}</span><div class="actions">${canWrite && (!plan || plan.data.status === 'draft') ? tool('sip-edit', plan ? 'Redigera SIP' : 'Skapa SIP', 'pencil') : ''}${
      canWrite && plan
        ? Object.entries({
            invite: ['Kalla till SIP', 'calendar-plus'],
            accept: ['Bekräfta SIP', 'check'],
            finalize: ['Färdigställ SIP', 'file-check'],
            reopen: ['Öppna för revidering', 'rotate-ccw'],
            close: ['Avsluta SIP', 'check-check'],
          })
            .filter(([a]) => a === 'accept' || plan.data.coordinatorUnitId === actor.unitId)
            .filter(([a]) =>
              a === 'invite'
                ? plan.data.status === 'draft'
                : a === 'accept' || a === 'finalize'
                  ? plan.data.status === 'invited'
                  : a === 'reopen'
                    ? ['invited', 'agreed'].includes(plan.data.status)
                    : plan.data.status === 'agreed',
            )
            .map(([a, [title, ic]]) => tool('sip-action', title, ic, `data-plan-action="${a}"`))
            .join('')
        : ''
    }</div></div>${f ? `<dl class="sam-facts"><dt>Patientens prioriteringar</dt><dd>${e(f.patientPriorities)}</dd><dt>Delaktighet</dt><dd>${e(f.participation)}</dd><dt>Möte</dt><dd>${date(f.meetingAt)} · ${e(f.location)}</dd><dt>Uppföljning</dt><dd>${e(f.followUpOn)}</dd></dl><p>${f.participants.map((p) => e(p.name)).join(', ')}</p><div class="sam-goals">${f.goals.map((g) => `<article><h3>${e(g.goal)}</h3><p>${e(g.need)}</p><p>${e(g.intervention)}</p><small>${e(unitName(g.responsibleUnitId))} · ${e(g.dueOn)} · ${e({ planned: 'Planerad', ongoing: 'Pågående', completed: 'Klar' }[g.status])}</small><p>${e(g.followUp)}</p></article>`).join('')}</div><p class="quiet">Bekräftat av: ${Object.keys(plan.data.confirmations).map(unitName).map(e).join(', ') || 'Ingen enhet'}</p>` : '<p class="empty">Ingen SIP har upprättats.</p>'}`;
    actions['sip-action'] = (b) =>
      formAction(b.title, area('reason', 'Kommentar'), (v) =>
        api(prefix + '/sip/action', {
          version: plan.version,
          action: b.dataset.planAction,
          reason: v.reason,
        }),
      );
    actions['sip-edit'] = () => {
      const goals = f?.goals ?? [
        {
          need: '',
          goal: '',
          intervention: '',
          responsibleUnitId: actor.unitId,
          dueOn: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          status: 'planned',
          followUp: '',
        },
      ];
      const goalFields = (g, index) =>
        `<fieldset class="sam-goal-editor" data-index="${index}"><legend>Insats ${index + 1}</legend>${
          field(`need-${index}`, 'Behov', g.need) +
          field(`goal-${index}`, 'Mål', g.goal) +
          area(`intervention-${index}`, 'Insats', g.intervention) +
          choose(
            `owner-${index}`,
            'Ansvarig enhet',
            detail.parties
              .filter((p) => !p.data.readOnly)
              .map((p) => [p.data.unitId, unitName(p.data.unitId)]),
            g.responsibleUnitId,
          ) +
          field(`due-${index}`, 'Senast', g.dueOn, 'date') +
          choose(
            `status-${index}`,
            'Insatsstatus',
            [
              ['planned', 'Planerad'],
              ['ongoing', 'Pågående'],
              ['completed', 'Klar'],
            ],
            g.status,
          )
        }<label>Uppföljningsanteckning<textarea name="followup-${index}">${e(g.followUp)}</textarea></label><button type="button" data-remove-sam-row aria-label="Ta bort insats" title="Ta bort insats"><i data-lucide="trash-2"></i></button></fieldset>`;
      const people = f?.participants ?? [
        { name: record.data.patient.name, role: 'patient' },
        { name: '', role: 'staff', unitId: actor.unitId },
      ];
      const participantFields = (p, i) =>
        `<div class="sam-person-editor" data-index="${i}">${
          field(`person-${i}`, 'Namn', p.name) +
          choose(
            `role-${i}`,
            'Deltagarroll',
            [
              ['patient', 'Patient'],
              ['relative', 'Närstående'],
              ['staff', 'Personal'],
            ],
            p.role,
          ) +
          choose(
            `unit-${i}`,
            'Deltagarens enhet',
            [
              ['', 'Ingen enhet'],
              ...detail.parties.map((p) => [p.data.unitId, unitName(p.data.unitId)]),
            ],
            p.unitId ?? '',
          )
        }<button type="button" data-remove-sam-row aria-label="Ta bort deltagare" title="Ta bort deltagare"><i data-lucide="trash-2"></i></button></div>`;
      formAction(
        'SIP-utkast',
        area('patientPriorities', 'Patientens prioriteringar', f?.patientPriorities) +
          area('participation', 'Delaktighet och patientens synpunkter', f?.participation) +
          field(
            'meetingAt',
            'Mötestid',
            localTime(f?.meetingAt ?? Date.now() + 86400000),
            'datetime-local',
          ) +
          field('location', 'Mötesplats', f?.location) +
          field(
            'followUpOn',
            'Uppföljningsdatum',
            f?.followUpOn ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
            'date',
          ) +
          `<div id="sam-people">${people.map(participantFields).join('')}</div><button type="button" id="sam-add-person"><i data-lucide="user-plus"></i>Lägg till deltagare</button><div id="sam-goal-fields">${goals.map(goalFields).join('')}</div><button type="button" id="sam-add-goal"><i data-lucide="plus"></i>Lägg till insats</button>` +
          area('reason', 'Ändringsorsak'),
        (v) => {
          const participants = Array.from(
            document.querySelectorAll('#sam-people .sam-person-editor'),
          ).map((row) => {
            const i = row.dataset.index;
            return {
              name: v[`person-${i}`],
              role: v[`role-${i}`],
              ...(v[`unit-${i}`] ? { unitId: v[`unit-${i}`] } : {}),
            };
          });
          const goals = Array.from(document.querySelectorAll('#sam-goal-fields fieldset')).map(
            (row) => {
              const i = row.dataset.index;
              return {
                need: v[`need-${i}`],
                goal: v[`goal-${i}`],
                intervention: v[`intervention-${i}`],
                responsibleUnitId: v[`owner-${i}`],
                dueOn: v[`due-${i}`],
                status: v[`status-${i}`],
                followUp: v[`followup-${i}`],
              };
            },
          );
          return api(prefix + '/sip', {
            version: plan?.version ?? 0,
            reason: v.reason,
            fields: {
              patientPriorities: v.patientPriorities,
              participation: v.participation,
              meetingAt: new Date(v.meetingAt).toISOString(),
              location: v.location,
              followUpOn: v.followUpOn,
              participants,
              goals,
            },
          });
        },
      );
      let nextGoal = goals.length,
        nextPerson = people.length;
      const wireRemovals = () => {
        document.querySelectorAll('[data-remove-sam-row]').forEach(
          (b) =>
            (b.onclick = () => {
              const row = b.closest('[data-index]');
              if (row.parentElement.children.length > 1) row.remove();
            }),
        );
        globalThis.lucide?.createIcons();
      };
      wireRemovals();
      document.querySelector('#sam-add-goal').onclick = () => {
        const box = document.querySelector('#sam-goal-fields'),
          i = nextGoal++;
        if (box.children.length < 20)
          box.insertAdjacentHTML(
            'beforeend',
            goalFields({ ...goals[0], need: '', goal: '', intervention: '', followUp: '' }, i),
          );
        wireRemovals();
      };
      document.querySelector('#sam-add-person').onclick = () => {
        const box = document.querySelector('#sam-people'),
          i = nextPerson++;
        if (box.children.length < 30)
          box.insertAdjacentHTML(
            'beforeend',
            participantFields({ name: '', role: 'staff', unitId: actor.unitId }, i),
          );
        wireRemovals();
      };
    };
  }
  if (panel && view.tab === 'documents') {
    panel.innerHTML = `<div class="toolbar"><h3>Bilagor</h3>${canWrite ? '<label class="sam-upload"><i data-lucide="paperclip"></i>PDF eller TXT<input id="sam-file" aria-label="Bifoga PDF eller text" type="file" accept=".pdf,.txt"></label>' : ''}</div>${detail.attachments.map((a) => `<div class="row"><div><strong>${e(a.data.name)}</strong><small>${a.data.size} byte · ${a.data.state === 'available' ? 'Tillgänglig' : 'Karantän'}</small></div>${permissions.includes('coordination.export') && a.data.state === 'available' ? tool('attachment', 'Hämta bilaga', 'download', `data-file="${a.id}"`) : ''}</div>`).join('') || '<p class="empty">Inga bilagor.</p>'}`;
    actions.attachment = async (b) =>
      download(await api('/coordination/attachments/' + b.dataset.file));
    panel.querySelector('#sam-file')?.addEventListener('change', (ev) =>
      perform(async () => {
        const file = ev.target.files[0];
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        let raw = '';
        for (const b of bytes) raw += String.fromCharCode(b);
        await api(prefix + '/attachments', {
          name: file.name,
          contentType: file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain',
          base64: btoa(raw),
        });
        await refresh();
      }),
    );
  }
  if (panel && view.tab === 'responsibility') {
    const p = detail.payment;
    panel.innerHTML = `<div class="toolbar"><h3>Ansvar och tillgänglighet</h3><div class="actions">${canWrite && own.kind === 'primary-care' ? tool('contact', 'Ange fast vårdkontakt', 'user-round-check') + tool('availability', 'Bekräfta öppenvårdens insatser', 'clipboard-check') : ''}</div></div><dl class="sam-facts"><dt>Fast vårdkontakt</dt><dd>${e(record.data.contact?.name ?? 'Ej utsedd')}</dd><dt>Öppenvårdens insatser</dt><dd>${record.data.outpatientAvailable ? 'Bekräftat tillgängliga' : 'Inte bekräftade'}</dd></dl>${p ? `<h3>Preliminärt betalningsunderlag</h3><p>${p.status === 'estimate' ? `${p.days} dagar · ${(p.amountOre / 100).toLocaleString('sv-SE')} SEK` : e(p.reasons.join('. '))}</p><small>${e(p.policyVersion)}${p.developmentOnly ? ' · Exempelavtal, inte faktureringsunderlag' : ''}</small>` : ''}<h3 class="sam-subheading">Notifieringar</h3>${detail.notifications.map((n) => `<div class="row"><span>${e(unitName(n.data.unitId))}</span><span>${e({ 'not-configured': 'Ingen kanal konfigurerad', pending: 'Väntar', sending: 'Skickas', delivered: 'Gateway har mottagit', failed: 'Leverans misslyckades', cancelled: 'Avbruten' }[n.data.status])}</span></div>`).join('') || '<p class="empty">Inga notifieringar.</p>'}`;
    actions.contact = () =>
      formAction(
        'Fast vårdkontakt',
        field('name', 'Namn och kontaktuppgift', record.data.contact?.name),
        (v) =>
          api(prefix + '/action', { action: 'contact', version: record.version, name: v.name }),
      );
    actions.availability = () =>
      formAction(
        'Öppenvårdens insatser',
        choose(
          'available',
          'Tillgängliga',
          [
            ['true', 'Ja'],
            ['false', 'Nej / inte klarlagt'],
          ],
          String(record.data.outpatientAvailable),
        ) + area('reason', 'Bedömning'),
        (v) =>
          api(prefix + '/action', {
            action: 'availability',
            version: record.version,
            available: v.available === 'true',
            reason: v.reason,
          }),
      );
  }
  if (panel && view.tab === 'history')
    panel.innerHTML = `<h3>Ärendehistorik</h3>${detail.events.map((ev) => `<div class="history-row"><strong>${e(ev.data.type)}</strong><small>${date(ev.createdAt)} · ${e(unitName(ev.data.unitId))} · ${e(ev.data.author)}</small><p>${e(ev.data.note)}</p></div>`).join('')}`;
  target
    .querySelectorAll('[data-sam]')
    .forEach((b) => (b.onclick = () => perform(() => actions[b.dataset.sam]?.(b))));
  globalThis.lucide?.createIcons();
}
