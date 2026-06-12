-- SF Copilot product hardening tables.
-- Run after 001_brain_memories.sql in Supabase SQL Editor.

-- Extend existing connected_orgs instead of splitting data into a new org_connections table.
ALTER TABLE connected_orgs ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE connected_orgs ADD COLUMN IF NOT EXISTS api_version TEXT DEFAULT '62.0';
ALTER TABLE connected_orgs ADD COLUMN IF NOT EXISTS token_status TEXT DEFAULT 'unknown';
ALTER TABLE connected_orgs ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ;
ALTER TABLE connected_orgs ADD COLUMN IF NOT EXISTS last_deploy_check_at TIMESTAMPTZ;
ALTER TABLE connected_orgs ADD COLUMN IF NOT EXISTS org_alias TEXT;

CREATE TABLE IF NOT EXISTS org_connection_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_org_id UUID NOT NULL REFERENCES connected_orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  test_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail','warning')),
  error_code TEXT,
  error_message TEXT,
  remediation TEXT,
  latency_ms INTEGER,
  details JSONB DEFAULT '{}',
  tested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_connection_tests_org_idx ON org_connection_tests(connected_org_id, tested_at DESC);
CREATE INDEX IF NOT EXISTS org_connection_tests_user_idx ON org_connection_tests(user_id, tested_at DESC);

CREATE TABLE IF NOT EXISTS deployment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  connected_org_id UUID REFERENCES connected_orgs(id) ON DELETE SET NULL,
  metadata_type TEXT NOT NULL,
  component_name TEXT,
  requested_action TEXT NOT NULL DEFAULT 'deploy',
  status TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  request_text TEXT,
  dry_run_required BOOLEAN NOT NULL DEFAULT true,
  dry_run_passed BOOLEAN NOT NULL DEFAULT false,
  final_deploy_confirmed BOOLEAN NOT NULL DEFAULT false,
  result_summary JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS deployment_runs_user_idx ON deployment_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployment_runs_org_idx ON deployment_runs(connected_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployment_runs_status_idx ON deployment_runs(status, current_stage);

CREATE TABLE IF NOT EXISTS generated_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_run_id UUID NOT NULL REFERENCES deployment_runs(id) ON DELETE CASCADE,
  metadata_type TEXT NOT NULL,
  component_name TEXT,
  artifact_path TEXT,
  artifact_xml TEXT,
  generated_summary TEXT,
  model_used TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generated_artifacts_run_idx ON generated_artifacts(deployment_run_id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES generated_artifacts(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  change_reason TEXT,
  diff_from_previous TEXT,
  artifact_xml TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(artifact_id, version_number)
);

CREATE TABLE IF NOT EXISTS deployment_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_run_id UUID NOT NULL REFERENCES deployment_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  raw_error TEXT NOT NULL,
  error_category TEXT NOT NULL,
  root_cause TEXT,
  repair_strategy TEXT,
  safe_to_auto_repair BOOLEAN NOT NULL DEFAULT false,
  confidence NUMERIC(4,3),
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployment_errors_run_idx ON deployment_errors(deployment_run_id);
CREATE INDEX IF NOT EXISTS deployment_errors_category_idx ON deployment_errors(error_category);

CREATE TABLE IF NOT EXISTS data_load_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  connected_org_id UUID REFERENCES connected_orgs(id) ON DELETE SET NULL,
  object_api_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert','update','upsert')),
  external_id_field TEXT,
  status TEXT NOT NULL,
  total_rows INTEGER DEFAULT 0,
  succeeded_rows INTEGER DEFAULT 0,
  failed_rows INTEGER DEFAULT 0,
  dry_run_passed BOOLEAN NOT NULL DEFAULT false,
  migration_job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS data_load_jobs_user_idx ON data_load_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS data_load_jobs_org_idx ON data_load_jobs(connected_org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS data_load_row_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_load_job_id UUID NOT NULL REFERENCES data_load_jobs(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  field_name TEXT,
  raw_value TEXT,
  error_code TEXT,
  error_message TEXT NOT NULL,
  recommended_fix TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_load_row_errors_job_idx ON data_load_row_errors(data_load_job_id);

-- Structured learning fields. They are nullable so the existing memory API keeps working.
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS metadata_type TEXT;
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS error_signature TEXT;
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS root_cause TEXT;
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS fix_strategy TEXT;
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS safe_to_auto_repair BOOLEAN DEFAULT false;
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3) DEFAULT 0.500;
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS success_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brain_memories ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS brain_memories_error_signature_idx
  ON brain_memories(user_id, metadata_type, error_signature)
  WHERE metadata_type IS NOT NULL AND error_signature IS NOT NULL;
