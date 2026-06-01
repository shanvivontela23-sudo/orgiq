'use strict';

const express    = require('express');
const router     = express.Router();
const supabase   = require('../lib/supabase');
const { migrationQueue } = require('../workers/queue');

/**
 * GET /api/migrations
 * List migration jobs for a user.
 */
router.get('/', async (req, res) => {
  try {
    const { userId, statuses } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    let query = supabase
      .from('migration_jobs')
      .select(`
        id, status, is_dry_run, record_counts, created_at, completed_at,
        source:source_org_id (org_name),
        target:target_org_id (org_name)
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (statuses) {
      const statusList = String(statuses)
        .split(',')
        .map((status) => status.trim())
        .filter(Boolean);
      if (statusList.length > 0) {
        query = query.in('status', statusList);
      }
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ jobs: data || [] });
  } catch (err) {
    console.error('List migrations error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/migrations
 * Create a new migration job, persist to Supabase, and enqueue it.
 */
router.post('/', async (req, res) => {
  try {
    const {
      userId, sourceOrgId, targetOrgId, mappingConfig,
      isDryRun = false, isPiiTarget = false,
      skipFiles = false, skipEmails = false,
    } = req.body;

    if (!userId || !sourceOrgId || !targetOrgId) {
      return res.status(400).json({ error: 'userId, sourceOrgId, and targetOrgId are required' });
    }

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Persist to Supabase
    const { error: dbError } = await supabase.from('migration_jobs').insert({
      id:             batchId,
      user_id:        userId,
      source_org_id:  sourceOrgId,
      target_org_id:  targetOrgId,
      mapping_config: mappingConfig,
      is_dry_run:     isDryRun,
      is_pii_target:  isPiiTarget,
      skip_files:     skipFiles,
      skip_emails:    skipEmails,
      status:         'pending',
      created_at:     new Date().toISOString(),
    });

    if (dbError) throw new Error(`DB insert failed: ${dbError.message}`);

    // Enqueue
    const job = await migrationQueue.add('run-migration', {
      batchId, userId, sourceOrgId, targetOrgId, mappingConfig,
      isDryRun, isPiiTarget, skipFiles, skipEmails,
    }, { jobId: batchId, attempts: 1 });

    res.status(201).json({
      jobId:     batchId,
      bullJobId: job.id,
      status:    'pending',
    });
  } catch (err) {
    console.error('Create migration error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/migrations/:id
 * Get current status and progress of a migration job.
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: job, error } = await supabase
      .from('migration_jobs')
      .select('*, migration_phase_logs(*)')
      .eq('id', id)
      .single();

    if (error) throw new Error(error.message);
    if (!job)  return res.status(404).json({ error: 'Job not found' });

    res.json({
      jobId:        job.id,
      status:       job.status,
      currentPhase: job.current_phase,
      phaseName:    job.phase_name,
      recordCounts: job.record_counts,
      errorSummary: job.error_summary,
      startedAt:    job.started_at,
      completedAt:  job.completed_at,
      phases:       job.migration_phase_logs || [],
    });
  } catch (err) {
    console.error('Get migration error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/migrations/:id/report
 */
router.get('/:id/report', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('migration_jobs')
      .select('record_counts, error_summary, completed_at')
      .eq('id', id)
      .single();

    if (error) throw new Error(error.message);

    res.json({ jobId: id, ...data });
  } catch (err) {
    console.error('Get report error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/migrations/:id
 * Cancel an in-progress migration job.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const job = await migrationQueue.getJob(id);
    if (job) await job.remove();

    await supabase
      .from('migration_jobs')
      .update({ status: 'cancelled' })
      .eq('id', id);

    res.json({ jobId: id, status: 'cancelled' });
  } catch (err) {
    console.error('Cancel migration error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
