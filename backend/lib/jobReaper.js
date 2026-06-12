'use strict';

/**
 * jobReaper.js
 *
 * Runs every 5 minutes. Finds migration_jobs stuck in 'running' or 'pending'
 * for more than 45 minutes and marks them failed.
 *
 * Covers: server crash mid-job, network drop during SF polling, orphaned BullMQ jobs.
 */

const supabase = require('./supabase');

const STALE_AFTER_MS  = 45 * 60 * 1000; // 45 minutes
const REAP_INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes

async function reapStaleJobs() {
  try {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();

    const { data: stale, error } = await supabase
      .from('migration_jobs')
      .select('id, status, started_at')
      .in('status', ['running', 'pending'])
      .lt('started_at', cutoff);

    if (error || !stale?.length) return;

    const ids = stale.map(j => j.id);

    await supabase
      .from('migration_jobs')
      .update({
        status:       'failed',
        phase_name:   'Job timed out — server may have restarted',
        error_summary: { error: 'Job exceeded 45-minute timeout. It was likely interrupted by a server restart. Safe to retry.' },
        completed_at: new Date().toISOString(),
      })
      .in('id', ids);

    console.log(`[reaper] Marked ${ids.length} stale job(s) as failed: ${ids.join(', ')}`);
  } catch (err) {
    // Never let the reaper crash the server
    console.error('[reaper] Error during stale job cleanup:', err.message);
  }
}

function startReaper() {
  // Run once immediately on startup (catches jobs from last crash)
  reapStaleJobs();
  // Then every 5 minutes
  const interval = setInterval(reapStaleJobs, REAP_INTERVAL_MS);
  // Don't keep Node alive just for the reaper
  interval.unref();
  console.log('[reaper] Stale job reaper started (45-min timeout, 5-min interval)');
}

module.exports = { startReaper, reapStaleJobs };
