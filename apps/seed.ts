import type { Actor } from '../packages/contracts.ts';
import type { Runtime } from '../packages/runtime.ts';
import { vitals } from '../plugins/clinical.ts';
import { Temporal } from '@js-temporal/polyfill';
import { randomUUID } from 'node:crypto';
// Fictional clinical scenarios. Local identifiers never resemble national identity numbers.
const patients = [
  {
    name: 'Anna Lindberg',
    birthDate: '1968-04-23',
    codes: ['I10.9'],
    reason: 'Blodtrycksuppföljning',
    background:
      'Hypertoni sedan 2021. Arbetar som lärare. Promenerar dagligen och röker inte. Har med sig anteckningar från hemblodtrycksmätning.',
    note: 'Kontaktorsak\nPlanerad uppföljning av blodtryck.\n\nAktuellt\nMår bra i vardagen. Ingen yrsel, bröstsmärta eller andfåddhet. Har börjat promenera till arbetet.\n\nStatus\nBlodtryck 138/84 mmHg efter vila. Puls 72/min.\n\nPlan\nGå igenom hemblodtryck och stäm av aktuell läkemedelslista. Uppföljning med sjuksköterska bokas.',
    previous: [78, 36.6, 148, 90, 76.2],
    current: [72, 36.5, 138, 84, 75.4],
    tasks: ['Gå igenom hemblodtrycksdagbok', 'Boka blodtryckskontroll hos sjuksköterska'],
    allergy: {
      substance: 'Penicillin',
      reaction:
        'Patienten uppger nässelutslag vid behandling som ung. Preparat och årtal oklara; behöver verifieras.',
      criticality: 'unable-to-assess',
    },
  },
  {
    name: 'Johan Bergström',
    birthDate: '1955-11-08',
    codes: ['E11.9', 'I10.9'],
    reason: 'Årskontroll vid typ 2-diabetes',
    background:
      'Typ 2-diabetes sedan 2018. Pensionerad elektriker. Cyklar kortare sträckor. Önskar stöd för mer regelbundna måltider.',
    note: 'Kontaktorsak\nÅrlig diabetesuppföljning.\n\nAktuellt\nUpplever stabilt allmäntillstånd. Inga nytillkomna besvär från fötterna. Har frågor om matvanor vid resor.\n\nStatus\nBlodtryck 132/78 mmHg. Vikt 91,5 kg.\n\nPlan\nStäm av provsvar och tidpunkt för senaste ögonbottenundersökning. Boka separat fotstatus och samtal med diabetessjuksköterska.',
    previous: [76, 36.7, 140, 82, 93.0],
    current: [74, 36.6, 132, 78, 91.5],
    tasks: ['Stäm av senaste ögonbottenundersökning', 'Boka besök hos diabetessjuksköterska'],
  },
  {
    name: 'Sara Haddad',
    birthDate: '1992-07-15',
    codes: ['J45.9', 'J30.1'],
    reason: 'Uppföljning av astma och pollenbesvär',
    background:
      'Astma sedan tonåren och återkommande pollenbesvär. Arbetar som arkitekt. Tränar på gym och röker inte.',
    note: 'Kontaktorsak\nPlanerad astmauppföljning.\n\nAktuellt\nBesvär främst under pollensäsong och vid löpning utomhus. Ingen andfåddhet i vila. Vill gå igenom inhalationsteknik.\n\nStatus\nOpåverkat allmäntillstånd. Puls 68/min. Temperatur 36,7 °C.\n\nPlan\nBoka astmasköterska för genomgång av inhalationsteknik och aktuell behandlingsplan. Stäm av tidigare spirometri.',
    previous: [72, 36.6, 116, 74, 64.0],
    current: [68, 36.7, 118, 72, 64.2],
    tasks: ['Boka genomgång av inhalationsteknik', 'Hämta uppgift om senaste spirometri'],
  },
  {
    name: 'Erik Nyström',
    birthDate: '1980-02-06',
    codes: ['M54.5'],
    reason: 'Uppföljning av ländryggssmärta',
    background:
      'Arbetar som lageransvarig. Återkommande ländryggsbesvär efter belastning. Tidigare kontakt med fysioterapeut.',
    note: 'Kontaktorsak\nÅterbesök för ländryggssmärta.\n\nAktuellt\nMindre ont än vid föregående kontakt. Besvär efter längre sittande. Uppger ingen nytillkommen svaghet, känselnedsättning eller påverkan på blåsfunktion.\n\nStatus\nGår obehindrat. Rörelse i ländryggen utlöser lokal smärta.\n\nPlan\nFölj upp funktion och arbetsbelastning. Boka fysioterapeut och telefonkontakt för uppföljning.',
    previous: [80, 36.8, 128, 82, 84.2],
    current: [76, 36.6, 126, 80, 84.0],
    tasks: ['Boka fysioterapeut', 'Telefonuppföljning av funktion och smärta'],
  },
];
export async function seedDemo(runtime: Runtime, actor: Actor) {
  return runtime.get('store').transaction(() => seedRecords(runtime, actor));
}
async function seedRecords(runtime: Runtime, actor: Actor) {
  const clinical = runtime.get('clinical');
  const terminology = runtime.get('terminology');
  const now = Date.now();
  const team = runtime.get('careTeam');
  const staff = await team.members(actor);
  const today = Temporal.Now.plainDateISO(team.timeZone).toString();
  const days = (offset: number) => new Date(now + offset * 86400000).toISOString();
  // Insert in reverse so the newest-first directory opens Anna's follow-up.
  for (const [index, scenario] of [...patients.entries()].reverse()) {
    const patient = await clinical.register(actor, {
      name: scenario.name,
      birthDate: scenario.birthDate,
      identifier: { type: 'local', value: `DEMO-00${index + 1}` },
    });
    for (const member of staff)
      if (member.id !== actor.id)
        await runtime
          .get('access')
          .grant(
            actor,
            patient.id,
            member.id,
            'clinician',
            days(30),
            'Scheduled care in the synthetic clinic',
          );
    const appointment = await team.book(actor, patient.id, {
      practitionerId: actor.id,
      localStart: `${today}T${String(9 + index).padStart(2, '0')}:00`,
      durationMinutes: 30,
      reason: scenario.reason,
      type: index === 3 ? 'phone' : 'visit',
    });
    if (index === 0)
      await team.appointment(actor, appointment.id, 'arrive', appointment.version, {});
    for (const code of scenario.codes) {
      const term = terminology.lookup(code)!;
      await clinical.create(actor, patient.id, 'condition', {
        code: {
          system: term.system,
          version: term.version,
          code: term.code,
          display: term.display,
        },
      });
    }
    if (scenario.allergy) await clinical.create(actor, patient.id, 'allergy', scenario.allergy);
    const intake = await clinical.create(actor, patient.id, 'encounter', {
      reason: 'Genomgång av bakgrund',
    });
    const history = await clinical.create(actor, patient.id, 'note', {
      encounterId: intake.id,
      text: scenario.background,
    });
    await clinical.transition(actor, history.id, 'sign', history.version, {});
    await clinical.transition(actor, intake.id, 'close', intake.version, {});
    const encounter = await clinical.create(actor, patient.id, 'encounter', {
      reason: scenario.reason,
    });
    const medicine = [
      ['Enalapril 5 mg, tablett', 'Hypertoni'],
      ['Metformin 500 mg, tablett', 'Typ 2-diabetes'],
      ['Pulmicort Turbuhaler 200 mikrogram/dos', 'Astma'],
    ][index];
    if (medicine)
      await runtime.get('medications').add(actor, patient.id, {
        clientId: randomUUID(),
        name: medicine[0],
        indication: medicine[1],
        dosageText: null,
        source: 'patient',
        sourceDetail:
          'Patienten uppger preparat och styrka. Dosering behöver stämmas av mot aktuell lista.',
        status: 'active',
      });
    if (index < 2) {
      const labs = runtime.get('laboratories');
      const order = await labs.order(actor, patient.id, {
        clientId: randomUUID(),
        encounterId: encounter.id,
        test: index === 0 ? 'Kreatinin och kalium' : 'HbA1c',
        question:
          index === 0 ? 'Prover inför behandlingsuppföljning.' : 'Prov inför diabetesuppföljning.',
        specimen: index === 0 ? 'Plasma' : 'Blod',
        assigneeId: actor.id,
        due: today,
        priority: 'routine',
      });
      if (index === 0)
        await labs.receive(actor, order.id, order.version, {
          source: 'Exempellaboratoriet',
          messageId: 'LAB-2026-001',
          collectedAt: days(-1),
          reportedAt: days(0),
          results: [
            { name: 'P-Kreatinin', value: '78', unit: 'µmol/L', reference: '', flag: 'unknown' },
            { name: 'P-Kalium', value: '4,2', unit: 'mmol/L', reference: '', flag: 'unknown' },
          ],
        });
    }
    for (const [i, code] of Object.keys(vitals).entries()) {
      // Earlier readings are entered retrospectively; audit timestamps remain real.
      for (const [value, offset] of [
        [scenario.previous[i], -28],
        [scenario.current[i], 0],
      ]) {
        await clinical.create(actor, patient.id, 'observation', {
          encounterId: encounter.id,
          code,
          value,
          unit: vitals[code].unit,
          effectiveAt: days(offset),
        });
      }
    }
    await clinical.create(actor, patient.id, 'note', {
      encounterId: encounter.id,
      text: scenario.note,
    });
    for (const [i, title] of scenario.tasks.entries()) {
      await clinical.create(actor, patient.id, 'task', {
        title,
        due: days(index === 1 && i === 0 ? -1 : 3 + i * 11).slice(0, 10),
        assigneeId: i === 1 ? (staff[1]?.id ?? actor.id) : actor.id,
        priority: index === 1 && i === 0 ? 'urgent' : 'routine',
      });
    }
  }
}
