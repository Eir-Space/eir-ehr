import { createHash } from 'node:crypto';
import type { Pool, PoolClient, PoolConfig } from 'pg';

export type PostgresConnectionConfig = {
  connectionStringEnv: string;
  localDevelopmentOnly?: boolean;
};

// Do not pass URL SSL options to pg: they can override certificate verification.
export function postgresPoolConfig(config: PostgresConnectionConfig): PoolConfig {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.connectionStringEnv ?? ''))
    throw new Error('PostgreSQL connectionStringEnv is required');
  const value = process.env[config.connectionStringEnv];
  if (!value) throw new Error('PostgreSQL connection environment variable is missing');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username)
    throw new Error('PostgreSQL requires a TCP URL with an explicit database role');
  const local = config.localDevelopmentOnly === true;
  if (local && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('localDevelopmentOnly requires a loopback PostgreSQL host');
  for (const [key, value] of url.searchParams) {
    if (
      key !== 'sslmode' ||
      !['require', 'verify-full', ...(local ? ['disable'] : [])].includes(value)
    )
      throw new Error('Unsupported PostgreSQL URL option; TLS verification is mandatory');
  }
  url.search = '';
  return {
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: true },
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'eir-ehr',
  };
}

export const postgresDataTables = [
  'tenant_roles',
  'audit_heads',
  'entities',
  'versions',
  'grants',
  'restrictions',
  'sessions',
  'login_transactions',
  'audit',
] as const;

const initialSchema = `
CREATE TABLE eir.tenant_roles (
  runtime_role name PRIMARY KEY,
  tenant text NOT NULL CHECK (length(tenant) > 0)
);
CREATE TABLE eir.audit_heads (
  tenant text PRIMARY KEY,
  seq bigint NOT NULL DEFAULT 0,
  hash text NOT NULL DEFAULT 'GENESIS'
);
CREATE TABLE eir.entities (
  tenant text NOT NULL,
  id text NOT NULL,
  patient_id text NOT NULL,
  kind text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (tenant, id)
);
CREATE INDEX chart ON eir.entities (tenant, patient_id, kind);
CREATE UNIQUE INDEX identifier_unique ON eir.entities
  (tenant, (data->'identifier'->>'system'), (data->'identifier'->>'value')) WHERE kind = 'patient';
CREATE TABLE eir.versions (
  cursor bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant text NOT NULL,
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  PRIMARY KEY (tenant, id, version),
  FOREIGN KEY (tenant, id) REFERENCES eir.entities (tenant, id),
  CHECK ((snapshot->>'tenant') IS NOT DISTINCT FROM tenant),
  CHECK ((snapshot->>'id') IS NOT DISTINCT FROM id),
  CHECK ((snapshot->>'version') IS NOT DISTINCT FROM version::text)
);
CREATE INDEX version_changes ON eir.versions (tenant, (snapshot->>'patientId'), cursor);
CREATE TABLE eir.grants (
  tenant text NOT NULL,
  patient_id text NOT NULL,
  actor_id text NOT NULL,
  role text NOT NULL,
  expires text NOT NULL,
  PRIMARY KEY (tenant, patient_id, actor_id),
  FOREIGN KEY (tenant, patient_id) REFERENCES eir.entities (tenant, id)
);
CREATE TABLE eir.restrictions (
  tenant text NOT NULL,
  patient_id text NOT NULL,
  blocked boolean NOT NULL,
  PRIMARY KEY (tenant, patient_id),
  FOREIGN KEY (tenant, patient_id) REFERENCES eir.entities (tenant, id)
);
CREATE TABLE eir.sessions (
  tenant text NOT NULL,
  hash text NOT NULL,
  actor jsonb NOT NULL,
  expires text NOT NULL,
  last_seen text NOT NULL,
  PRIMARY KEY (tenant, hash),
  CHECK ((actor->>'tenant') IS NOT DISTINCT FROM tenant)
);
CREATE TABLE eir.login_transactions (
  tenant text NOT NULL,
  hash text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  expires text NOT NULL,
  PRIMARY KEY (tenant, hash)
);
CREATE SEQUENCE eir.audit_seq;
CREATE TABLE eir.audit (
  tenant text NOT NULL,
  seq bigint NOT NULL,
  body text NOT NULL,
  previous text NOT NULL,
  hash text NOT NULL,
  PRIMARY KEY (tenant, seq),
  CHECK ((body::jsonb->>'tenant') IS NOT DISTINCT FROM tenant)
);
CREATE INDEX audit_unit ON eir.audit (tenant, ((body::jsonb)->>'unitId'), seq DESC);

CREATE FUNCTION eir.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'EHR immutable record' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON eir.audit
  FOR EACH STATEMENT EXECUTE FUNCTION eir.reject_mutation();
CREATE TRIGGER versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON eir.versions
  FOR EACH STATEMENT EXECUTE FUNCTION eir.reject_mutation();
CREATE TRIGGER entities_no_delete BEFORE DELETE OR TRUNCATE ON eir.entities
  FOR EACH STATEMENT EXECUTE FUNCTION eir.reject_mutation();
CREATE FUNCTION eir.guard_entity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (OLD.kind = 'note' AND OLD.data->>'status' = 'signed')
    OR NEW.tenant <> OLD.tenant OR NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id
    OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'EHR immutable record or invalid revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER entity_revision_guard BEFORE UPDATE ON eir.entities
  FOR EACH ROW EXECUTE FUNCTION eir.guard_entity();

-- Only this fixed-path trigger can mutate audit heads. Runtime roles have SELECT only.
-- session_user remains the authenticated login inside this SECURITY DEFINER function;
-- the table's independent RLS policy uses current_user at the caller's boundary.
CREATE FUNCTION eir.append_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  prior text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eir.tenant_roles
      WHERE runtime_role = session_user AND tenant = NEW.tenant) THEN
    RAISE EXCEPTION 'EHR tenant denied' USING ERRCODE = '42501';
  END IF;
  SELECT hash INTO prior FROM eir.audit_heads WHERE tenant = NEW.tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EHR tenant not provisioned' USING ERRCODE = '42501';
  END IF;
  NEW.seq := nextval('eir.audit_seq'::regclass);
  NEW.previous := prior;
  NEW.hash := encode(sha256(convert_to(prior || NEW.body, 'UTF8')), 'hex');
  UPDATE eir.audit_heads SET seq = NEW.seq, hash = NEW.hash WHERE tenant = NEW.tenant;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_chain BEFORE INSERT ON eir.audit
  FOR EACH ROW EXECUTE FUNCTION eir.append_audit();

${postgresDataTables
  .map(
    (table) => `
ALTER TABLE eir.${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE eir.${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_access ON eir.${table} TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY tenant_scope ON eir.${table} USING (${
      table === 'tenant_roles'
        ? 'runtime_role = current_user'
        : 'tenant = (SELECT tenant FROM eir.tenant_roles WHERE runtime_role = current_user)'
    }) WITH CHECK (${
      table === 'tenant_roles'
        ? 'runtime_role = current_user'
        : 'tenant = (SELECT tenant FROM eir.tenant_roles WHERE runtime_role = current_user)'
    });`,
  )
  .join('\n')}
REVOKE ALL ON ALL TABLES IN SCHEMA eir FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA eir FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA eir FROM PUBLIC;
`;

export const postgresMigrations = [
  { version: 1, name: 'tenant-role-storage', sql: initialSchema },
  {
    version: 2,
    name: 'durable-integration-indexes',
    sql: `
CREATE INDEX entity_page ON eir.entities (tenant, kind, created_at, id);
CREATE INDEX integration_due ON eir.entities (tenant, kind, (data->>'connectorId'), (data->>'state'), (data->>'availableAt'));
CREATE INDEX entity_data_filter ON eir.entities USING gin (data jsonb_path_ops);
CREATE UNIQUE INDEX integration_message ON eir.entities (tenant, kind, (data->>'connectorId'), (data->>'messageId'))
  WHERE kind IN ('integrationOutbox', 'integrationInbox');
CREATE UNIQUE INDEX integration_connector ON eir.entities (tenant, (data->>'connectorId')) WHERE kind = 'integrationConnection';
CREATE FUNCTION eir.guard_integration_message() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.kind IN ('integrationOutbox', 'integrationInbox') AND
    (NEW.data->'payload' IS DISTINCT FROM OLD.data->'payload' OR
     NEW.data->'payloadHash' IS DISTINCT FROM OLD.data->'payloadHash' OR
     NEW.data->'messageId' IS DISTINCT FROM OLD.data->'messageId' OR
     NEW.data->'orderId' IS DISTINCT FROM OLD.data->'orderId' OR
     NEW.data->'connectorId' IS DISTINCT FROM OLD.data->'connectorId' OR
     NEW.data->'unitId' IS DISTINCT FROM OLD.data->'unitId') THEN
    RAISE EXCEPTION 'Integration message is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION eir.guard_integration_message() FROM PUBLIC;
CREATE TRIGGER integration_message_guard BEFORE UPDATE ON eir.entities
  FOR EACH ROW EXECUTE FUNCTION eir.guard_integration_message();
`,
  },
].map((migration) => ({
  ...migration,
  checksum: createHash('sha256').update(migration.sql).digest('hex'),
}));

export async function checkPostgresMigrations(client: PoolClient, complete = true): Promise<void> {
  const exists = await client.query("SELECT to_regclass('eir.schema_migrations') AS ledger");
  if (!exists.rows[0].ledger) throw new Error('PostgreSQL migrations have not been applied');
  const { rows } = await client.query(
    'SELECT version, name, checksum FROM eir.schema_migrations ORDER BY version',
  );
  for (const [index, row] of rows.entries()) {
    const expected = postgresMigrations[index];
    if (!expected || row.version !== expected.version)
      throw new Error('PostgreSQL migration version is newer than application or non-contiguous');
    if (row.name !== expected.name || row.checksum !== expected.checksum)
      throw new Error('PostgreSQL migration checksum mismatch');
  }
  if (complete && rows.length !== postgresMigrations.length)
    throw new Error('PostgreSQL migrations are pending; run the operator migration command');
}

const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

export async function checkRuntimeRole(client: PoolClient, role?: string): Promise<string> {
  const { rows } = await client.query(
    `
    SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      r.rolcanlogin,
      EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS member,
      EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = 'eir' AND n.nspowner = r.oid) AS schema_owner,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'eir' AND c.relowner = r.oid) AS table_owner,
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'eir' AND p.proowner = r.oid) AS function_owner,
      EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid) AS db_owner,
      has_schema_privilege(r.oid, 'eir', 'CREATE') AS schema_create,
      has_database_privilege(r.oid, current_database(), 'CREATE') AS db_create,
      session_user = current_user AS direct_login
    FROM pg_roles r WHERE r.rolname = COALESCE($1::name, current_user)`,
    [role ?? null],
  );
  const row = rows[0];
  if (
    !row ||
    !row.rolcanlogin ||
    (!role && !row.direct_login) ||
    [
      'rolsuper',
      'rolbypassrls',
      'rolcreaterole',
      'rolcreatedb',
      'rolreplication',
      'member',
      'schema_owner',
      'table_owner',
      'function_owner',
      'db_owner',
      'schema_create',
      'db_create',
    ].some((key) => row[key])
  )
    throw new Error(
      'PostgreSQL runtime role must be a restricted nonowner login without role memberships',
    );
  const { rows: settings } = await client.query(
    `SELECT
    current_setting('server_version_num')::integer AS version,
    current_setting('session_replication_role') AS replication_role,
    EXISTS (
      SELECT 1 FROM pg_db_role_setting s
      WHERE s.setrole IN (0, (SELECT oid FROM pg_roles WHERE rolname = $1::name))
        AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
        AND EXISTS (SELECT 1 FROM unnest(s.setconfig) AS option
          WHERE option LIKE 'session_replication_role=%' AND option <> 'session_replication_role=origin')
    ) AS unsafe_defaults`,
    [row.rolname],
  );
  if (settings[0].replication_role !== 'origin' || settings[0].unsafe_defaults)
    throw new Error('PostgreSQL integrity triggers must remain enabled');
  // Before PG15 only superusers can set this parameter; those were rejected above.
  if (settings[0].version >= 150000) {
    const { rows: privileges } = await client.query(
      `SELECT
      has_parameter_privilege($1::name, 'session_replication_role', 'SET') OR
      has_parameter_privilege($1::name, 'session_replication_role', 'ALTER SYSTEM') AS unsafe`,
      [row.rolname],
    );
    if (privileges[0].unsafe)
      throw new Error('PostgreSQL runtime role can disable integrity triggers');
  }
  return row.rolname;
}

export async function migratePostgres(
  pool: Pool,
  provision?: { tenant: string; runtimeRole: string },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transaction-scoped, cluster-local migration lock; failed DDL and ledger writes roll back together.
    await client.query('SELECT pg_advisory_xact_lock(170141, 202601)');
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS eir;
      REVOKE ALL ON SCHEMA eir FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS eir.schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE eir.schema_migrations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE eir.schema_migrations FORCE ROW LEVEL SECURITY;
    `);
    const policies = await client.query(
      "SELECT 1 FROM pg_policies WHERE schemaname = 'eir' AND tablename = 'schema_migrations' AND policyname = 'operator_access'",
    );
    if (!policies.rowCount)
      await client.query(`
      CREATE POLICY operator_access ON eir.schema_migrations TO CURRENT_USER USING (true) WITH CHECK (true);
      CREATE POLICY runtime_read ON eir.schema_migrations FOR SELECT USING (true);
      REVOKE ALL ON eir.schema_migrations FROM PUBLIC;
    `);
    await checkPostgresMigrations(client, false);
    const applied = await client.query('SELECT version FROM eir.schema_migrations');
    for (const migration of postgresMigrations.slice(applied.rowCount ?? 0)) {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO eir.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      );
    }
    if (provision) {
      if (!provision.tenant?.trim() || !provision.runtimeRole?.trim())
        throw new Error('Provisioning requires tenant and an existing restricted runtime role');
      await checkRuntimeRole(client, provision.runtimeRole);
      const existing = await client.query(
        'SELECT tenant FROM eir.tenant_roles WHERE runtime_role = $1',
        [provision.runtimeRole],
      );
      if (existing.rowCount && existing.rows[0].tenant !== provision.tenant)
        throw new Error('A PostgreSQL runtime role cannot be remapped to another tenant');
      await client.query(
        'INSERT INTO eir.tenant_roles (runtime_role, tenant) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [provision.runtimeRole, provision.tenant],
      );
      await client.query(
        'INSERT INTO eir.audit_heads (tenant) VALUES ($1) ON CONFLICT DO NOTHING',
        [provision.tenant],
      );
      const role = quoteIdentifier(provision.runtimeRole);
      await client.query(`
        GRANT USAGE ON SCHEMA eir TO ${role};
        GRANT SELECT ON ALL TABLES IN SCHEMA eir TO ${role};
        GRANT INSERT, UPDATE ON eir.entities, eir.grants, eir.restrictions TO ${role};
        GRANT INSERT, UPDATE, DELETE ON eir.sessions, eir.login_transactions TO ${role};
        GRANT INSERT ON eir.versions, eir.audit TO ${role};
        GRANT USAGE ON SEQUENCE eir.versions_cursor_seq TO ${role};
      `);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
