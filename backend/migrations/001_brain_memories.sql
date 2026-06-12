-- OrgIQ Brain: persistent memory table
-- Run once in Supabase SQL Editor: https://supabase.com/dashboard/project/umcwltuvotlsqystgxci/sql

CREATE TABLE IF NOT EXISTS brain_memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  org_id        UUID,                          -- null = user-wide memory; set = org-specific
  type          VARCHAR(50) NOT NULL,          -- 'error_fix' | 'migration_pattern' | 'bulk_load_event' | 'user_preference'
  subject       VARCHAR(255) NOT NULL,         -- normalized lowercase title used for upsert dedup
  content       TEXT NOT NULL,                 -- compact memory text; prompt injection is capped in code
  keywords      TEXT[] DEFAULT '{}',           -- capped keyword list for retrieval
  metadata      JSONB DEFAULT '{}',            -- structured data (jobId, errorCode, fieldNames, etc.)
  importance    SMALLINT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  access_count  INTEGER DEFAULT 0,             -- how often this memory has been recalled
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_accessed TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS brain_memories_user_idx ON brain_memories (user_id);
CREATE INDEX IF NOT EXISTS brain_memories_org_idx  ON brain_memories (org_id);
CREATE INDEX IF NOT EXISTS brain_memories_type_idx ON brain_memories (type);
CREATE INDEX IF NOT EXISTS brain_memories_kw_idx   ON brain_memories USING GIN (keywords);
CREATE UNIQUE INDEX IF NOT EXISTS brain_memories_dedupe_idx
  ON brain_memories (user_id, type, subject);

-- RLS: users can only see their own memories
ALTER TABLE brain_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own memories" ON brain_memories
  FOR ALL USING (auth.uid() = user_id);
