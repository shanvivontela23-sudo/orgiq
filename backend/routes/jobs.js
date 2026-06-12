'use strict';

/**
 * routes/jobs.js
 * GET /api/jobs/:jobId — poll a background job's status.
 *
 * Reads from migration_jobs (where all deploy + migration jobs are stored).
 * Frontend polls this after calling /api/objects/deploy-full or any other
 * endpoint that enqueues work and returns { jobId } immediately.
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

router.get('/:jobId', requireAuth, async (req, res) => {
  const { jobId } = req.params;

  const { data: job, error } = await supabase
    .from('migration_jobs')
    .select('id, status, phase_name, error_summary, record_counts, completed_at, created_at')
    .eq('id', jobId)
    .eq('user_id', req.user.id) // enforce ownership
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  // Flatten result from error_summary.result (where worker stores it)
  const result = job.error_summary?.result || null;
  const errorMsg = job.status === 'failed' ? (job.error_summary?.error || 'Deploy failed') : null;

  res.json({
    jobId:       job.id,
    status:      job.status,           // pending | running | completed | failed
    phase:       job.phase_name,       // current step label for UI progress
    result,                            // populated on completion
    error:       errorMsg,
    completedAt: job.completed_at,
  });
});

module.exports = router;
