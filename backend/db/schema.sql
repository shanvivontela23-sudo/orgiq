-- =============================================================
-- OrgIQ Database Schema
-- Deploy to Supabase via SQL Editor or supabase db push
-- =============================================================

-- Users (managed by Supabase Auth, we extend it)
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  full_name TEXT,
  company TEXT,
  plan TEXT DEFAULT 'free',
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Connected Salesforce Orgs
CREATE TABLE connected_orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES user_profiles(id),
  org_id TEXT NOT NULL,
  org_name TEXT,
  org_type TEXT, -- 'production' | 'sandbox' | 'developer'
  instance_url TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TIMESTAMPTZ,
  mcp_server_url TEXT,
  mcp_enabled BOOLEAN DEFAULT FALSE,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, org_id)
);

-- Migration Jobs
CREATE TABLE migration_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES user_profiles(id),
  source_org_id UUID REFERENCES connected_orgs(id),
  target_org_id UUID REFERENCES connected_orgs(id),
  batch_id TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending',
  -- pending | validating | dry_run | running | completed | failed | cancelled
  current_phase INTEGER DEFAULT 0,
  total_phases INTEGER DEFAULT 10,
  phase_name TEXT,
  objects_in_scope JSONB,
  mapping_file_url TEXT,
  mapping_config JSONB,
  is_dry_run BOOLEAN DEFAULT FALSE,
  is_pii_target BOOLEAN DEFAULT FALSE,
  record_counts JSONB,
  error_summary JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  stripe_payment_intent_id TEXT,
  pricing_tier TEXT
);

-- Migration Phase Log
CREATE TABLE migration_phase_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES migration_jobs(id),
  phase_number INTEGER,
  phase_name TEXT,
  status TEXT, -- 'running' | 'completed' | 'failed' | 'skipped'
  records_processed INTEGER DEFAULT 0,
  records_succeeded INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  error_detail JSONB,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(job_id, phase_number)
);

-- Validation Report
CREATE TABLE validation_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES migration_jobs(id) UNIQUE,
  report_data JSONB NOT NULL,
  pdf_url TEXT,
  csv_url TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================
-- Row Level Security (RLS) policies
-- =============================================================

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_phase_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_reports ENABLE ROW LEVEL SECURITY;

-- Users can only see their own profile
CREATE POLICY "Users can view own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);

-- Users can only see their own orgs
CREATE POLICY "Users can view own orgs" ON connected_orgs
  FOR ALL USING (auth.uid() = user_id);

-- Users can only see their own migration jobs
CREATE POLICY "Users can view own migrations" ON migration_jobs
  FOR ALL USING (auth.uid() = user_id);

-- Phase logs are viewable by job owner
CREATE POLICY "Users can view phase logs for own jobs" ON migration_phase_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM migration_jobs
      WHERE migration_jobs.id = migration_phase_logs.job_id
        AND migration_jobs.user_id = auth.uid()
    )
  );

-- Validation reports viewable by job owner
CREATE POLICY "Users can view reports for own jobs" ON validation_reports
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM migration_jobs
      WHERE migration_jobs.id = validation_reports.job_id
        AND migration_jobs.user_id = auth.uid()
    )
  );

-- =============================================================
-- Indexes for common query patterns
-- =============================================================

CREATE INDEX idx_connected_orgs_user_id ON connected_orgs(user_id);
CREATE INDEX idx_migration_jobs_user_id ON migration_jobs(user_id);
CREATE INDEX idx_migration_jobs_batch_id ON migration_jobs(batch_id);
CREATE INDEX idx_migration_jobs_status ON migration_jobs(status);
CREATE INDEX idx_phase_logs_job_id ON migration_phase_logs(job_id);
