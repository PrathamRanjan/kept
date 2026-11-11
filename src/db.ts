import { mkdirSync } from "node:fs";
import { config } from "./config.js";

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: "pglite" | "postgres";
}

async function openPglite(path: string | null): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (path) mkdirSync(path, { recursive: true });
  const pg = path ? new PGlite(path) : new PGlite();
  await pg.waitReady;
  // PGlite is single-connection: serialise transactions so concurrent requests don't interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const db: Db = {
    kind: "pglite",
    query: async (sql, params) => {
      const r = await pg.query(sql, params as any[]);
      return { rows: r.rows as any[] };
    },
    exec: async (sql) => {
      await pg.exec(sql);
    },
    tx: (fn) => {
      const run = chain.then(() => pg.transaction(async (t) => fn({ query: async (s, p) => ({ rows: (await t.query(s, p as any[])).rows as any[] }) })));
      chain = run.catch(() => undefined);
      return run as any;
    },
    close: async () => {
      await pg.close();
    },
  };
  return db;
}

async function openPostgres(url: string): Promise<Db> {
  const pgmod = await import("pg");
  const Pool = (pgmod as any).default?.Pool ?? (pgmod as any).Pool;
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 10 });
  return {
    kind: "postgres",
    query: async (sql, params) => {
      const r = await pool.query(sql, params);
      return { rows: r.rows };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: async (s: string, p?: unknown[]) => ({ rows: (await client.query(s, p)).rows }) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  owner_email TEXT,
  paypal_payer_id TEXT,
  paypal_env TEXT NOT NULL DEFAULT 'sandbox',
  paypal_credentials TEXT,
  paypal_product_id TEXT,
  paypal_webhook_id TEXT,
  owner_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  paypal_plan_id TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('regular','lite','promo')),
  base_plan_id TEXT,
  discount_percent INTEGER,
  price NUMERIC(12,2) NOT NULL,
  interval_unit TEXT NOT NULL CHECK (interval_unit IN ('DAY','WEEK','MONTH','YEAR')),
  interval_count INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  version INTEGER NOT NULL,
  rules JSONB NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  notes JSONB NOT NULL DEFAULT '[]',
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, version)
);
CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  plan_id TEXT REFERENCES plans(id),
  home_plan_id TEXT REFERENCES plans(id),
  ref TEXT UNIQUE NOT NULL,
  paypal_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL,
  kept_state TEXT,
  subscriber_name TEXT,
  subscriber_email TEXT,
  channel TEXT NOT NULL DEFAULT 'web',
  agent_id TEXT,
  approval_url TEXT,
  next_billing_time TIMESTAMPTZ,
  last_payment_amount NUMERIC(12,2),
  last_payment_time TIMESTAMPTZ,
  outstanding NUMERIC(12,2) NOT NULL DEFAULT 0,
  failed_payments INTEGER NOT NULL DEFAULT 0,
  resume_at TIMESTAMPTZ,
  promo_until TIMESTAMPTZ,
  is_sample BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscribers_merchant ON subscribers(merchant_id);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  policy_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  terms JSONB NOT NULL,
  message TEXT NOT NULL,
  reason_category TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','accepted','declined','expired')),
  monthly_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  subscriber_id TEXT REFERENCES subscribers(id),
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  outcome TEXT,
  is_sample BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_requests (
  id TEXT PRIMARY KEY,
  merchant_id TEXT,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args JSONB NOT NULL,
  idempotency_key TEXT,
  ok BOOLEAN,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_requests_idem ON agent_requests(agent_id, tool, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS event_log (
  id BIGSERIAL PRIMARY KEY,
  merchant_id TEXT,
  subscriber_id TEXT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload JSONB,
  paypal_response JSONB,
  is_sample BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_log_merchant ON event_log(merchant_id, id DESC);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  body JSONB NOT NULL,
  verified BOOLEAN NOT NULL,
  simulated BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  subscriber_id TEXT REFERENCES subscribers(id),
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  is_sample BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}',
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS consent_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS promise_until TIMESTAMPTZ;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS start_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_start_key ON subscribers (merchant_id, start_key) WHERE start_key IS NOT NULL;

-- ---------- Foundation (roadmap B, 9 Nov 2026) ----------
CREATE TABLE IF NOT EXISTS ai_calls (
  id BIGSERIAL PRIMARY KEY, purpose TEXT NOT NULL, model TEXT NOT NULL, via TEXT NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
  ok BOOLEAN NOT NULL, error TEXT, output JSONB, run_id TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_calls_hash ON ai_calls(input_hash, id DESC);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, agent_id TEXT, merchant_id TEXT, subject TEXT NOT NULL DEFAULT '', entity TEXT, entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'running', started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS agent_trace (
  id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id), step INTEGER NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL,
  args JSONB, policy TEXT, gate TEXT, result JSONB, pp_request_id TEXT, pp_debug_id TEXT, duration_ms INTEGER, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_trace_run ON agent_trace(run_id, step);
CREATE TABLE IF NOT EXISTS audit_chain (
  seq BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, payload JSONB NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kill_switches (scope TEXT PRIMARY KEY, engaged BOOLEAN NOT NULL DEFAULT false, reason TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, action TEXT NOT NULL, payload_hash TEXT NOT NULL, payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','expired')), method TEXT, decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, credential_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS provenance (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, trust TEXT NOT NULL CHECK (trust IN ('system','paypal','owner','agent','document','message','web')), text TEXT NOT NULL,
  entity TEXT, entity_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')), address TEXT NOT NULL, body TEXT NOT NULL, buttons JSONB,
  entity TEXT, entity_id TEXT, external_id TEXT, status TEXT NOT NULL DEFAULT 'queued', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS party_links (id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, party TEXT NOT NULL, party_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (channel, address));
CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, party TEXT NOT NULL, party_id TEXT NOT NULL, subscription JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS judge_sessions (id TEXT PRIMARY KEY, merchant_id TEXT, beat INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY, suite TEXT NOT NULL, arm TEXT NOT NULL, case_id TEXT NOT NULL, expected TEXT NOT NULL, actual TEXT NOT NULL, correct BOOLEAN NOT NULL,
  trap BOOLEAN NOT NULL DEFAULT false, naive_paid_cents INTEGER NOT NULL DEFAULT 0, ours_paid_cents INTEGER NOT NULL DEFAULT 0, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0, detail JSONB, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_runs_suite ON eval_runs(suite, arm);
-- Key-value settings (safety layer: protected mode per merchant).
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Owner guard settings: how much the agents and the offer step may do without the owner (earned autonomy).
CREATE TABLE IF NOT EXISTS guard_settings (
  merchant_id TEXT PRIMARY KEY, auto_discount_max_pct INTEGER NOT NULL DEFAULT 15, auto_pause_max_cycles INTEGER NOT NULL DEFAULT 2,
  approve_capture_above_cents INTEGER NOT NULL DEFAULT 5000, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, subscriber_id TEXT NOT NULL, paypal_invoice_id TEXT, amount NUMERIC(12,2) NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL, run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS time_zone TEXT;
-- ---------- Wave 2 (11 Nov 2026): Decisions thresholds, the AI call summary, the agent loop ----------
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS input_summary TEXT;
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS merchant_id TEXT;
CREATE TABLE IF NOT EXISTS nightly_runs (
  id TEXT PRIMARY KEY, trigger TEXT NOT NULL, passed INTEGER NOT NULL, total INTEGER NOT NULL, result JSONB NOT NULL, run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS decision_thresholds (
  name TEXT PRIMARY KEY, clear_below DOUBLE PRECISION NOT NULL, hold_above DOUBLE PRECISION NOT NULL, calibrated_on TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0, precision_at_hold DOUBLE PRECISION, recall_at_hold DOUBLE PRECISION, set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS jurisdiction TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE event_log ADD COLUMN IF NOT EXISTS run_id TEXT;
-- The in-app simulator is gone: old rows become the in-app message record, and "simulated" becomes "not_sent".
UPDATE channel_messages SET channel = 'inapp' WHERE channel = 'simulator';
UPDATE channel_messages SET status = CASE WHEN channel = 'inapp' THEN 'sent' ELSE 'not_sent' END WHERE status = 'simulated';
DELETE FROM party_links WHERE channel = 'simulator';
DROP TABLE IF EXISTS subscription_history;
-- (Wave 1, 11 Nov 2026) The old boot-time purge of sample rows is now a one-time migration, recorded in
-- settings, so labelled samples seeded into demo workspaces survive restarts.
CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now());
-- ---------- Wave 1 A1/A2.2: private demo workspaces and the approval pool ----------
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('visitor','showcase')),
  ip_hash TEXT, seed_version INTEGER NOT NULL DEFAULT 1, seed_state TEXT NOT NULL DEFAULT 'seeding' CHECK (seed_state IN ('seeding','ready','failed')),
  seed_error TEXT, checklist JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS workspaces_kind ON workspaces(kind, last_seen_at);
CREATE TABLE IF NOT EXISTS approval_pool (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'subscription', paypal_id TEXT UNIQUE NOT NULL, plan_id TEXT, approve_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval','ready','claimed','spent')), claimed_by_ws TEXT, note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS paypal_refs (resource_id TEXT PRIMARY KEY, ws_id TEXT, merchant_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS usage_counters (scope TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, day, kind));
ALTER TABLE offers ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE audit_chain ADD COLUMN IF NOT EXISTS merchant_id TEXT;
-- Every workspace clones the showcase's PayPal plans, so a PayPal plan id is unique per shop, not globally.
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_paypal_plan_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS plans_merchant_paypal ON plans(merchant_id, paypal_plan_id);
CREATE INDEX IF NOT EXISTS offers_merchant ON offers(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_merchant ON feedback(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_merchant ON payments(merchant_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS approvals_merchant ON approvals(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_merchant ON agent_runs(merchant_id, started_at DESC);
`;

/** Runs a migration once; its id is recorded in the migrations table. */
async function runOnce(db: Db, id: string, sql: string) {
  const done = (await db.query("SELECT 1 FROM migrations WHERE id = $1", [id])).rows.length > 0;
  if (done) return;
  await db.exec(sql);
  await db.query("INSERT INTO migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
}

let shared: Db | null = null;

export async function openDb(opts: { memory?: boolean } = {}): Promise<Db> {
  const db = opts.memory ? await openPglite(null) : config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite(config.pglitePath);
  await db.exec(SCHEMA);
  // No time zone is a guess: unset means the scam check skips the time-of-day signal instead of assuming UTC.
  await runOnce(db, "2026-11-11-time-zone-unset", `ALTER TABLE merchants ALTER COLUMN time_zone DROP NOT NULL; ALTER TABLE merchants ALTER COLUMN time_zone DROP DEFAULT; UPDATE merchants SET time_zone = NULL WHERE time_zone = 'UTC';`);
  await runOnce(db, "2026-11-10-purge-old-samples", `
    DELETE FROM offers WHERE subscriber_id IN (SELECT id FROM subscribers WHERE is_sample);
    DELETE FROM feedback WHERE subscriber_id IN (SELECT id FROM subscribers WHERE is_sample);
    DELETE FROM payments WHERE is_sample OR subscriber_id IN (SELECT id FROM subscribers WHERE is_sample);
    DELETE FROM invoices WHERE subscriber_id IN (SELECT id FROM subscribers WHERE is_sample);
    DELETE FROM event_log WHERE is_sample OR subscriber_id IN (SELECT id FROM subscribers WHERE is_sample);
    DELETE FROM subscribers WHERE is_sample;`);
  return db;
}

export async function getDb(): Promise<Db> {
  if (!shared) shared = await openDb();
  return shared;
}

export function setDb(db: Db) {
  shared = db;
}
