import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Fault, type Actor } from './contracts.ts';

export type ClinicalModel = {
  kind: string;
  templateId: string;
  templateFile: string;
  sha256: string;
  version: string;
};

export type VitalForm =
  | {
      id: string;
      label: string;
      kind: 'quantity';
      code: string;
      unit: string;
      min: number;
      max: number;
    }
  | {
      id: '85354-9';
      label: string;
      kind: 'blood-pressure';
      unit: 'mm[Hg]';
      systolic: { code: '8480-6'; min: number; max: number };
      diastolic: { code: '8462-4'; min: number; max: number };
    };

export interface ClinicalModelRegistry {
  models(): ClinicalModel[];
  model(kind: string): ClinicalModel | undefined;
  vitalForms(): VitalForm[];
  validate(kind: string, data: Record<string, any>, actor: Actor): Record<string, any>;
}

export const openEhrVitalBindings = {
  '8867-4': {
    label: 'Puls',
    eirUnit: '/min',
    unit: '/min',
    min: 1,
    max: 350,
    obs: 'pulse_heart_beat',
    field: 'heart_rate',
    aql: { archetype: 'pulse', data: 'at0002', events: 'at0003', items: 'at0001', item: 'at0004' },
  },
  '9279-1': {
    label: 'Andningsfrekvens',
    eirUnit: '/min',
    unit: '/min',
    min: 1,
    max: 100,
    obs: 'respirations',
    field: 'rate',
    aql: {
      archetype: 'respiration',
      data: 'at0001',
      events: 'at0002',
      items: 'at0003',
      item: 'at0004',
    },
  },
  '8310-5': {
    label: 'Kroppstemperatur',
    eirUnit: 'Cel',
    unit: '°C',
    min: 20,
    max: 50,
    obs: 'body_temperature',
    field: 'temperature',
    aql: {
      archetype: 'body_temperature',
      data: 'at0002',
      events: 'at0003',
      items: 'at0001',
      item: 'at0004',
    },
  },
  '8480-6': {
    label: 'Systoliskt blodtryck',
    eirUnit: 'mm[Hg]',
    unit: 'mm[Hg]',
    min: 20,
    max: 350,
    obs: 'blood_pressure',
    field: 'systolic',
    aql: {
      archetype: 'blood_pressure',
      data: 'at0001',
      events: 'at0006',
      items: 'at0003',
      item: 'at0004',
    },
  },
  '8462-4': {
    label: 'Diastoliskt blodtryck',
    eirUnit: 'mm[Hg]',
    unit: 'mm[Hg]',
    min: 10,
    max: 250,
    obs: 'blood_pressure',
    field: 'diastolic',
    aql: {
      archetype: 'blood_pressure',
      data: 'at0001',
      events: 'at0006',
      items: 'at0003',
      item: 'at0005',
    },
  },
  '59408-5': {
    label: 'Syremättnad (SpO2)',
    eirUnit: '%',
    unit: '%',
    min: 1,
    max: 100,
    obs: 'indirect_oximetry',
    field: 'spo2',
    proportion: true as const,
    aql: {
      archetype: 'indirect_oximetry',
      data: 'at0001',
      events: 'at0002',
      items: 'at0003',
      item: 'at0006',
      numerator: true as const,
    },
  },
} as const;

const models: ClinicalModel[] = [
  {
    kind: 'observation',
    templateId: 'IDCR - Vital Signs Encounter.v1',
    templateFile: 'IDCR - Vital Signs Encounter.v1.opt',
    sha256: '565e9398aef1afac7f509ea7ec415535569c6b6cd1a09db261398ea5e63e09b7',
    version: '1',
  },
  {
    kind: 'condition',
    templateId: 'IDCR - Problem List.v1',
    templateFile: 'IDCR - Problem List.v1.opt',
    sha256: '0729d1570c10ac2e27209598a1fdcda4c96afbabc4eed1d67c9594662dd879e1',
    version: '1',
  },
  {
    kind: 'note',
    templateId: 'RIPPLE - Clinical Notes.v1',
    templateFile: 'RIPPLE - Clinical Notes.v1.opt',
    sha256: 'b043ea04823c7ffa9fa0b3d74e3ccf2b8ccbf6a9b0fe231670a66bea72a267a6',
    version: '1',
  },
];

const component = z
  .object({
    code: z.enum(['8480-6', '8462-4']),
    value: z.number().finite(),
    unit: z.literal('mm[Hg]'),
    display: z.string().min(1),
  })
  .strict();

function validateObservation(data: Record<string, any>, actor: Actor) {
  const common = z
    .object({
      encounterId: z.uuid(),
      effectiveAt: z.iso.datetime({ offset: true }),
      clientId: z.uuid(),
      status: z.enum(['final', 'entered-in-error']),
      author: z.string().min(1),
    })
    .passthrough()
    .parse(data);
  if (Date.parse(common.effectiveAt) > Date.now())
    throw new Fault(422, 'Observation time cannot be in the future');
  if (common.author !== actor.id) throw new Fault(403, 'Observation author does not match actor');

  if (data.code === '85354-9') {
    const parsed = z
      .object({
        code: z.literal('85354-9'),
        display: z.literal('Blodtryck'),
        unit: z.literal('mm[Hg]'),
        components: z.array(component).length(2),
      })
      .passthrough()
      .parse(data);
    const byCode = new Map(parsed.components.map((item) => [item.code, item]));
    for (const code of ['8480-6', '8462-4'] as const) {
      const item = byCode.get(code);
      const binding = openEhrVitalBindings[code];
      if (!item || item.value < binding.min || item.value > binding.max)
        throw new Fault(422, 'Invalid blood pressure component');
    }
    if (byCode.get('8480-6')!.value <= byCode.get('8462-4')!.value)
      throw new Fault(422, 'Systolic pressure must be greater than diastolic pressure');
    return structuredClone(data);
  }

  const code = String(data.code) as keyof typeof openEhrVitalBindings;
  const binding = openEhrVitalBindings[code];
  if (!binding)
    throw new Fault(422, 'Observation is not represented by the active openEHR template');
  if (code === '8480-6' || code === '8462-4')
    throw new Fault(422, 'Capture systolic and diastolic pressure together');
  if (
    data.unit !== binding.eirUnit ||
    typeof data.value !== 'number' ||
    data.value < binding.min ||
    data.value > binding.max
  )
    throw new Fault(422, 'Invalid observation unit or value');
  return { ...structuredClone(data), display: binding.label };
}

export async function createOpenEhrModelRegistry(
  templateDirectory = fileURLToPath(new URL('../templates/openehr/', import.meta.url)),
): Promise<ClinicalModelRegistry> {
  for (const model of models) {
    const content = await readFile(
      new URL(model.templateFile, `file://${templateDirectory.replace(/\/$/, '')}/`),
    );
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== model.sha256)
      throw new Error(`openEHR template digest mismatch: ${model.templateFile}`);
  }
  const forms: VitalForm[] = [
    ...(['8867-4', '9279-1', '8310-5', '59408-5'] as const).map((code) => {
      const b = openEhrVitalBindings[code];
      return {
        id: code,
        label: b.label,
        kind: 'quantity' as const,
        code,
        unit: b.eirUnit,
        min: b.min,
        max: b.max,
      };
    }),
    {
      id: '85354-9',
      label: 'Blodtryck',
      kind: 'blood-pressure',
      unit: 'mm[Hg]',
      systolic: {
        code: '8480-6',
        min: openEhrVitalBindings['8480-6'].min,
        max: openEhrVitalBindings['8480-6'].max,
      },
      diastolic: {
        code: '8462-4',
        min: openEhrVitalBindings['8462-4'].min,
        max: openEhrVitalBindings['8462-4'].max,
      },
    },
  ];
  return {
    models: () => structuredClone(models),
    model: (kind) => structuredClone(models.find((model) => model.kind === kind)),
    vitalForms: () => structuredClone(forms),
    validate(kind, data, actor) {
      if (kind === 'observation') return validateObservation(data, actor);
      if (!models.some((model) => model.kind === kind))
        throw new Fault(422, `No active openEHR model for ${kind}`);
      return structuredClone(data);
    },
  };
}
