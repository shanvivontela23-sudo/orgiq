-- OrgIQ Supabase Schema
-- Run this in the Supabase SQL editor: https://supabase.com/dashboard/project/_/sql

-- ─── Connected Orgs ──────────────────────────────────────────────────────────
create table if not exists connected_orgs (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  org_id        text not null,
  org_name      text,
  instance_url  text not null,
  access_token  text not null,
  refresh_token text,
  org_type      text check (org_type in ('source', 'target')) default 'source',
  connected_at  timestamptz default now(),
  unique (user_id, org_id)
);

-- ─── Migration Jobs ───────────────────────────────────────────────────────────
create table if not exists migration_jobs (
  id              text primary key,           -- batchId from worker
  user_id         text not null,
  source_org_id   text not null references connected_orgs(id),
  target_org_id   text not null references connected_orgs(id),
  mapping_config  jsonb,
  is_dry_run      boolean default false,
  is_pii_target   boolean default false,
  skip_files      boolean default false,
  skip_emails     boolean default false,
  status          text check (status in ('pending','running','completed','failed','cancelled')) default 'pending',
  current_phase   int default 0,
  phase_name      text,
  record_counts   jsonb,
  error_summary   jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz default now()
);

-- ─── Migration Phase Logs ─────────────────────────────────────────────────────
create table if not exists migration_phase_logs (
  id                uuid primary key default gen_random_uuid(),
  job_id            text not null references migration_jobs(id) on delete cascade,
  phase_number      int not null,
  phase_name        text,
  status            text,
  records_succeeded int default 0,
  records_failed    int default 0,
  updated_at        timestamptz default now(),
  unique (job_id, phase_number)
);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table connected_orgs    enable row level security;
alter table migration_jobs    enable row level security;
alter table migration_phase_logs enable row level security;

-- Service role bypasses RLS — backend uses service key, so no policies needed.
-- Add user-level policies here when you add Supabase Auth to the frontend.
