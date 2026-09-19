import { permissions } from '../packages/workforce.ts';
// Only for disposable/local synthetic workspaces. Never use this provisioning in a clinic.
export function demoWorkforce(tenant: string) {
  const unitId = 'demo-primary-care';
  const base = {
    unitId,
    issuer: 'https://local.eir.invalid',
    validFrom: '2020-01-01T00:00:00.000Z',
    validUntil: '2099-01-01T00:00:00.000Z',
    enabled: true,
  };
  const clinical = permissions.filter(
    (p) => !['workforce.manage', 'integration.manage', 'audit.review'].includes(p),
  );
  return {
    units: [{ id: unitId, tenant, name: 'Björkbackens vårdcentral' }],
    bootstrap: [
      {
        ...base,
        actorId: 'demo-clinician',
        subject: 'emma',
        name: 'Emma Sjöberg',
        role: 'clinician',
        permissions: clinical,
      },
      {
        ...base,
        actorId: 'demo-nurse',
        subject: 'david',
        name: 'David Ek',
        role: 'clinician',
        permissions: clinical.filter(
          (p) =>
            ![
              'access.manage',
              'access.emergency',
              'patient.protected',
              'lab.order',
              'modules.manage',
            ].includes(p),
        ),
      },
      {
        ...base,
        actorId: 'demo-colleague',
        subject: 'linnea',
        name: 'Linnea Holm',
        role: 'clinician',
        permissions: clinical,
      },
      {
        ...base,
        actorId: 'demo-clinician',
        subject: 'emma',
        name: 'Emma Sjöberg',
        role: 'auditor',
        permissions: ['audit.review'],
      },
      {
        ...base,
        actorId: 'demo-clinician',
        subject: 'emma',
        name: 'Emma Sjöberg',
        role: 'administrator',
        permissions: ['workforce.manage', 'integration.manage', 'modules.manage'],
      },
    ],
  };
}
