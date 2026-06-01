/**
 * backend/lib/supabase.js
 * Singleton Supabase client for server-side use.
 * Uses the SERVICE_KEY — never expose this to the frontend.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

module.exports = supabase;
