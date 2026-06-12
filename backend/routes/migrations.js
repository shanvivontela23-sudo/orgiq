'use strict';

const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const xlsx       = require('xlsx');
const supabase   = require('../lib/supabase');
const { migrationQueue } = require('../workers/queue');
const { runBulkDataLoad, getFailedResults, getSuccessfulResults } = require('../lib/bulkApi');
const { runDataMigrationPreflight } = require('../lib/dataMigrationPreflight');
const { getSalesforceOAuthConfig } = require('../lib/salesforceOAuth');
const { rememberBulkLoad }         = require('../lib/brain');
const axios      = require('axios');

// Multer: in-memory storage, 100 MB limit (Bulk API v2 ingestion limit)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

/**
 * Refresh an org token on demand before bulk load.
 */
async function getOrgCredentials(orgId) {
  const { data: org, error } = await supabase
    .from('connected_orgs')
    .select('access_token, refresh_token, instance_url, org_type')
    .eq('id', orgId)
    .single();
  if (error || !org) throw new Error(`Org ${orgId} not found`);

  if (org.refresh_token) {
    try {
      const oauthConfig = getSalesforceOAuthConfig(org.org_type);
      const { data: tok } = await axios.post(
        `${oauthConfig.loginUrl}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: oauthConfig.clientId,
          client_secret: oauthConfig.clientSecret,
          refresh_token: org.refresh_token,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      await supabase.from('connected_orgs').update({
        access_token: tok.access_token,
        instance_url: tok.instance_url || org.instance_url,
      }).eq('id', orgId);
      return { accessToken: tok.access_token, instanceUrl: tok.instance_url || org.instance_url };
    } catch { /* fall through to existing token */ }
  }
  return { accessToken: org.access_token, instanceUrl: org.instance_url };
}

/**
 * Convert uploaded file buffer to CSV string.
 * Accepts .csv (pass-through) or .xlsx (convert sheet 0 to CSV).
 */
function toCsvBuffer(fileBuffer, fileName) {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  let csv;
  if (ext === 'xlsx' || ext === 'xls') {
    const wb = xlsx.read(fileBuffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    csv = xlsx.utils.sheet_to_csv(ws);
  } else {
    csv = fileBuffer.toString('utf8');
  }
  // Normalize to LF — Bulk API v2 jobs use lineEnding: 'LF'
  // sheet_to_csv and Windows CSV editors emit CRLF which triggers:
  // ClientInputError: LineEnding is invalid on user data
  csv = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return Buffer.from(csv, 'utf8');
}

/**
 * Count actual data rows in a CSV buffer (excluding header).
 */
function countCsvRows(csvBuffer) {
  const text = csvBuffer.toString('utf8');
  return Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
}

/**
 * Parse CSV headers from buffer, normalizing CRLF and stripping quotes.
 */
function parseCsvHeaders(csvBuffer) {
  const text = csvBuffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return (text.split('\n')[0] || '').split(',').map(h => h.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function isMissingTableError(err) {
  const message = err?.message || String(err || '');
  return /does not exist|schema cache|could not find the table|relation .*data_load/i.test(message);
}

async function createDataLoadAuditJob({
  userId,
  targetOrgId,
  objectApiName,
  operation,
  externalIdField,
  rowCount,
  dryRun,
  migrationJobId,
}) {
  try {
    const { data, error } = await supabase
      .from('data_load_jobs')
      .insert({
        user_id: userId,
        connected_org_id: targetOrgId,
        object_api_name: objectApiName,
        operation,
        external_id_field: externalIdField || null,
        status: dryRun ? 'dry_run_running' : 'running',
        total_rows: rowCount,
        migration_job_id: migrationJobId,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data?.id || null;
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[data-load-audit] create failed:', err.message);
    return null;
  }
}

async function finishDataLoadAuditJob({ auditJobId, status, result, rowCount, dryRunPassed }) {
  if (!auditJobId) return;
  try {
    await supabase.from('data_load_jobs').update({
      status,
      total_rows: rowCount,
      succeeded_rows: result?.succeeded || 0,
      failed_rows: result?.sfJobState === 'Failed' ? rowCount : (result?.failed || 0),
      dry_run_passed: Boolean(dryRunPassed),
      completed_at: new Date().toISOString(),
    }).eq('id', auditJobId);
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[data-load-audit] finish failed:', err.message);
  }
}

async function recordDataLoadRowErrors({ auditJobId, errors = [] }) {
  if (!auditJobId || !errors.length) return;
  try {
    const rows = errors.slice(0, 500).map((err, index) => {
      const message = err.error || err.message || String(err);
      const code = String(message).split(':')[0] || 'ROW_ERROR';
      return {
        data_load_job_id: auditJobId,
        row_number: err.rowNumber || index + 2,
        field_name: err.field || null,
        raw_value: err.rawValue || null,
        error_code: code,
        error_message: message,
        recommended_fix: 'Review this row value, required fields, picklists, duplicate rules, and validation rules before retry.',
      };
    });
    await supabase.from('data_load_row_errors').insert(rows);
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[data-load-audit] row errors failed:', err.message);
  }
}

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
        mapping_config,
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
 * GET /api/migrations/:id/success-results
 * Download successful rows CSV — includes sf__Id (new Salesforce record ID) and sf__Created columns.
 */
router.get('/:id/success-results', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: job, error } = await supabase
      .from('migration_jobs')
      .select('error_summary, target_org_id, mapping_config, record_counts')
      .eq('id', id)
      .single();
    if (error || !job) return res.status(404).json({ error: 'Job not found' });

    const succeeded = job.record_counts?.succeeded || 0;
    if (succeeded === 0) return res.status(404).json({ error: 'No successful records in this job.' });

    const bulkJobId = job.error_summary?.bulkJobId;
    if (!bulkJobId) return res.status(404).json({ error: 'No Bulk API job ID found. This may have been a dry run.' });

    const { accessToken, instanceUrl } = await getOrgCredentials(job.target_org_id);
    const { csv } = await getSuccessfulResults(instanceUrl, accessToken, bulkJobId);

    if (!csv) return res.status(404).json({ error: 'Success results not available — Salesforce may have expired this job.' });

    const objectName = job.mapping_config?.objectApiName || 'records';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="success_${objectName}_${id}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Success results error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/migrations/:id/retry-failed
 * Download only the failed rows from a completed job as a ready-to-resubmit CSV.
 * Strips sf__ columns and adds a clean header so the user can fix and re-upload.
 */
router.get('/:id/retry-failed', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: job, error } = await supabase
      .from('migration_jobs')
      .select('error_summary, target_org_id, mapping_config, record_counts')
      .eq('id', id)
      .single();
    if (error || !job) return res.status(404).json({ error: 'Job not found' });

    const bulkJobId = job.error_summary?.bulkJobId;
    if (!bulkJobId) return res.status(404).json({ error: 'No Bulk API job ID — dry run or no SF job.' });

    const { accessToken, instanceUrl } = await getOrgCredentials(job.target_org_id);
    const { csv } = await getFailedResults(instanceUrl, accessToken, bulkJobId);
    if (!csv) return res.status(404).json({ error: 'No failed rows to retry.' });

    // Strip sf__Id, sf__Error columns — return only the original data columns
    const lines = csv.trim().split('\n').filter(Boolean);
    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
    const dataColIdxs = headers.map((h, i) => i).filter(i => !headers[i].startsWith('sf__'));
    const dataHeaders = dataColIdxs.map(i => headers[i]);

    const cleanLines = [
      dataHeaders.join(','),
      ...lines.slice(1).map(line => {
        const cols = line.split(',');
        return dataColIdxs.map(i => cols[i] ?? '').join(',');
      }),
    ];

    const objectName = job.mapping_config?.objectApiName || 'records';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="retry_${objectName}_${id}.csv"`);
    res.send(cleanLines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/migrations/preflight
 * Run pre-flight checks before submitting a bulk load job.
 * Accepts JSON body: { targetOrgId, objectApiName, operation, externalIdField, csvHeaders, rowCount, dryRun }
 * Returns { passed, errors, warnings, info, orgType, limits }
 */
router.post('/preflight', async (req, res) => {
  try {
    const {
      targetOrgId, objectApiName = 'Account', operation = 'insert',
      externalIdField = '', csvHeaders = [], rowCount = 0, dryRun = false,
    } = req.body;

    if (!targetOrgId) return res.status(400).json({ error: 'targetOrgId is required' });

    const { accessToken, instanceUrl } = await getOrgCredentials(targetOrgId);

    const result = await runDataMigrationPreflight({
      instanceUrl, accessToken, objectApiName, operation,
      externalIdField: externalIdField || undefined,
      csvHeaders, rowCount, dryRun,
    });

    // Strip objectMeta.fields from response — too large, not needed by client
    const { objectMeta, ...safeResult } = result;
    res.json({
      ...safeResult,
      fieldCount: objectMeta?.fields?.length || 0,
    });
  } catch (err) {
    console.error('Preflight error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/migrations/:id/failed-results
 * Download the failed-record CSV from a completed Bulk API job for re-processing.
 */
router.get('/:id/failed-results', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: job, error } = await supabase
      .from('migration_jobs')
      .select('error_summary, target_org_id, mapping_config')
      .eq('id', id)
      .single();
    if (error || !job) return res.status(404).json({ error: 'Job not found' });

    const bulkJobId = job.error_summary?.bulkJobId;
    if (!bulkJobId) {
      return res.status(404).json({ error: 'No Bulk API job ID found — job may have been a dry-run or local validation.' });
    }

    const { accessToken, instanceUrl } = await getOrgCredentials(job.target_org_id);
    const { csv } = await getFailedResults(instanceUrl, accessToken, bulkJobId);

    if (!csv) return res.status(404).json({ error: 'No failed results available.' });

    const objectName = job.mapping_config?.objectApiName || 'records';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="failed_${objectName}_${id}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Failed results error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/migrations/upload
 * Accepts multipart/form-data: fields (userId, targetOrgId, objectApiName, operation,
 * externalIdField, isDryRun) + file field 'dataFile'.
 * Parses CSV/XLSX, runs Salesforce Bulk API v2 ingest, persists results.
 * Use this for mass-scale data loads (up to 100M records/day).
 */
router.post('/upload', upload.single('dataFile'), async (req, res) => {
  try {
    const {
      userId, targetOrgId,
      objectApiName = 'Account',
      operation = 'insert',
      externalIdField = '',
      // Accept both 'dryRun' and 'isDryRun' — frontend multipart sends 'dryRun'
      dryRun: dryRunField,
      isDryRun: isDryRunField,
    } = req.body;

    const rawDryRun = dryRunField ?? isDryRunField ?? 'false';
    const dryRun = rawDryRun === true || rawDryRun === 'true';

    if (!userId || !targetOrgId) {
      return res.status(400).json({ error: 'userId and targetOrgId are required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'dataFile is required' });
    }

    // ── Idempotency check — block duplicate jobs within 5 minutes ────────────
    // Duplicate = same user + targetOrg + object + operation + file size within 5 min
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: existingJobs } = await supabase
      .from('migration_jobs')
      .select('id, status, created_at')
      .eq('user_id', userId)
      .eq('target_org_id', targetOrgId)
      .eq('status', 'running')
      .gte('created_at', fiveMinsAgo)
      .limit(1);

    const dupJob = (existingJobs || []).find(j =>
      j.status === 'running'
    );
    if (dupJob) {
      return res.status(409).json({
        error: 'A job for this org is already running. Wait for it to complete or check the Dashboard.',
        existingJobId: dupJob.id,
        code: 'DUPLICATE_JOB',
      });
    }
    // ──────────────────────────────────────────────────────────────────────────

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    // Convert to CSV
    const csvBuffer = toCsvBuffer(req.file.buffer, req.file.originalname);
    const rowCount = countCsvRows(csvBuffer);

    // Persist job as 'running'
    const { error: dbError } = await supabase.from('migration_jobs').insert({
      id: batchId, user_id: userId,
      source_org_id: targetOrgId, target_org_id: targetOrgId,
      mapping_config: { jobType: 'data_load', objectApiName, operation, externalIdField,
        dataFile: { name: req.file.originalname, size: req.file.size, estimatedRows: rowCount } },
      is_dry_run: dryRun,
      status: 'running', current_phase: 1,
      phase_name: 'Uploading to Salesforce Bulk API',
      record_counts: { total: rowCount, succeeded: 0, failed: 0 },
      started_at: now, created_at: now,
    });
    if (dbError) throw new Error(`DB insert failed: ${dbError.message}`);

    const dataLoadAuditJobId = await createDataLoadAuditJob({
      userId,
      targetOrgId,
      objectApiName,
      operation,
      externalIdField,
      rowCount,
      dryRun,
      migrationJobId: batchId,
    });

    await supabase.from('migration_phase_logs').insert([
      { job_id: batchId, phase_number: 0, phase_name: 'Target org selected', status: 'completed', records_succeeded: 0, started_at: now, completed_at: now },
      { job_id: batchId, phase_number: 1, phase_name: 'CSV file accepted', status: 'completed', records_succeeded: rowCount, started_at: now, completed_at: now },
    ]);

    // Return immediately — run Bulk API async so client can poll
    res.status(201).json({ jobId: batchId, status: 'running', estimatedRows: rowCount });

    // Async: run preflight + Bulk API load, update DB throughout
    (async () => {
      try {
        const { accessToken, instanceUrl } = await getOrgCredentials(targetOrgId);

        // Run pre-flight checks first — store results
        const csvHeaders = parseCsvHeaders(csvBuffer);
        const preflight = await runDataMigrationPreflight({
          instanceUrl, accessToken, objectApiName, operation,
          externalIdField: externalIdField || undefined,
          csvHeaders, rowCount, dryRun,
        });

        // Persist preflight results to DB
        const readOnlyFields = (preflight.errors.find(e => e.code === 'READ_ONLY_FIELDS')?.fields || [])
          .concat(preflight.warnings.find(w => w.code === 'READ_ONLY_FIELDS')?.fields || []);

        await supabase.from('migration_jobs').update({
          error_summary: {
            preflight: {
              passed:   preflight.passed,
              orgType:  preflight.orgType,
              errors:   preflight.errors,
              warnings: preflight.warnings,
              info:     preflight.info,
            },
          },
        }).eq('id', batchId);

        // Block on hard preflight errors (not just warnings)
        if (!preflight.passed) {
          await finishDataLoadAuditJob({
            auditJobId: dataLoadAuditJobId,
            status: 'preflight_failed',
            result: { succeeded: 0, failed: rowCount },
            rowCount,
            dryRunPassed: false,
          });
          await supabase.from('migration_jobs').update({
            status: 'failed',
            phase_name: 'Pre-flight validation failed',
            error_summary: { preflight: { passed: false, errors: preflight.errors, warnings: preflight.warnings, info: preflight.info } },
            completed_at: new Date().toISOString(),
          }).eq('id', batchId);
          return;
        }

        await supabase.from('migration_phase_logs').insert([
          { job_id: batchId, phase_number: 2, phase_name: 'Pre-flight validation passed', status: 'completed', records_succeeded: 0, started_at: now, completed_at: new Date().toISOString() },
          { job_id: batchId, phase_number: 3, phase_name: 'Field validation & upload', status: 'running', records_succeeded: 0, started_at: new Date().toISOString() },
        ]);

        await supabase.from('migration_jobs').update({ current_phase: 3, phase_name: 'Field validation & upload' }).eq('id', batchId);

        const result = await runBulkDataLoad({
          instanceUrl, accessToken,
          objectApiName, operation,
          externalIdField: externalIdField || undefined,
          csvData: csvBuffer,
          dryRun,
          readOnlyFields,
          onProgress: ({ succeeded, failed }) => {
            // Fire-and-forget progress updates — not awaited to avoid blocking poll loop
            supabase.from('migration_jobs').update({
              record_counts: { total: rowCount, succeeded, failed },
            }).eq('id', batchId).then(() => {});
          },
        });

        const completedAt = new Date().toISOString();

        // Determine final status:
        // - sfJobFailed: SF itself rejected the job (line endings, auth, etc.) — 0/0 result
        // - partialSuccess: some rows failed but at least one succeeded
        // - allFailed: every row was rejected (duplicate rules, validation errors, etc.)
        const sfJobFailed = result.sfJobState === 'Failed';
        const totalProcessed = result.succeeded + result.failed;
        // If SF job failed before processing any rows, use rowCount as total so UI shows meaningful numbers
        const displayTotal = totalProcessed > 0 ? totalProcessed : (sfJobFailed ? rowCount : rowCount);
        const finalStatus = sfJobFailed
          ? 'failed'
          : (result.failed > 0 && result.succeeded === 0 ? 'failed' : 'completed');

        await supabase.from('migration_phase_logs').upsert([
          { job_id: batchId, phase_number: 3, phase_name: 'Field validation', status: 'completed', records_succeeded: result.succeeded, started_at: now, completed_at: completedAt },
          { job_id: batchId, phase_number: 4, phase_name: dryRun ? 'Dry run complete' : 'Bulk load complete', status: sfJobFailed ? 'failed' : 'completed', records_succeeded: result.succeeded, started_at: now, completed_at: completedAt },
        ], { onConflict: 'job_id,phase_number' });

        await supabase.from('migration_jobs').update({
          status: finalStatus,
          current_phase: 4,
          phase_name: sfJobFailed
            ? `Bulk load failed: ${result.sfErrorMessage || 'Salesforce job error'}`
            : dryRun ? 'CSV dry run validation complete' : 'Bulk load complete',
          record_counts: {
            total:     displayTotal,
            succeeded: result.succeeded,
            failed:    sfJobFailed ? rowCount : result.failed,
            validated: dryRun,
            operation,
            object:    objectApiName,
          },
          error_summary: {
            bulkJobId:      result.jobId,
            sfJobState:     result.sfJobState,
            sfErrorMessage: result.sfErrorMessage,
            failedCount:    sfJobFailed ? rowCount : result.failed,
            errors:         result.errors.slice(0, 100),
            preflight:      { passed: preflight.passed, warnings: preflight.warnings, info: preflight.info },
          },
          completed_at: completedAt,
        }).eq('id', batchId);

        console.log(`[bulk-load] ${batchId} complete — ${result.succeeded} succeeded, ${result.failed} failed`);

        await finishDataLoadAuditJob({
          auditJobId: dataLoadAuditJobId,
          status: finalStatus,
          result,
          rowCount: displayTotal,
          dryRunPassed: dryRun || result.sfJobState !== 'Failed',
        });
        await recordDataLoadRowErrors({
          auditJobId: dataLoadAuditJobId,
          errors: result.errors,
        });

        // Store operational intelligence in the brain (fire-and-forget)
        rememberBulkLoad({
          userId, orgId: targetOrgId,
          objectApiName, operation,
          result, preflight, rowCount,
        }).catch(() => {});
      } catch (err) {
        console.error(`[bulk-load] ${batchId} failed:`, err.message);
        await finishDataLoadAuditJob({
          auditJobId: dataLoadAuditJobId,
          status: 'failed',
          result: { succeeded: 0, failed: rowCount },
          rowCount,
          dryRunPassed: false,
        });
        await supabase.from('migration_jobs').update({
          status: 'failed',
          error_summary: { error: err.message },
          completed_at: new Date().toISOString(),
        }).eq('id', batchId);
      }
    })();
  } catch (err) {
    console.error('Upload migration error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/migrations
 * Create a new migration job, persist to Supabase, and enqueue it.
 * For data_load jobs without a file upload, falls back to local dry-run.
 * For mass-scale loads with a file, use POST /api/migrations/upload instead.
 */
router.post('/', async (req, res) => {
  try {
    const {
      userId, sourceOrgId, targetOrgId, mappingConfig = {},
      isDryRun = false, isPiiTarget = false,
      skipFiles = false, skipEmails = false,
    } = req.body;

    const jobType = mappingConfig.jobType || 'org_migration';

    if (!userId || !targetOrgId || (jobType === 'org_migration' && !sourceOrgId)) {
      return res.status(400).json({
        error: jobType === 'data_load'
          ? 'userId and targetOrgId are required'
          : 'userId, sourceOrgId, and targetOrgId are required',
      });
    }

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const isDataLoad = jobType === 'data_load';
    const estimatedRows = Number(mappingConfig.dataFile?.estimatedRows || mappingConfig.rowCount || 0);
    const now = new Date().toISOString();

    // Persist to Supabase
    const { error: dbError } = await supabase.from('migration_jobs').insert({
      id:             batchId,
      user_id:        userId,
      source_org_id:  isDataLoad ? targetOrgId : sourceOrgId,
      target_org_id:  targetOrgId,
      mapping_config: mappingConfig,
      is_dry_run:     isDryRun,
      is_pii_target:  isPiiTarget,
      skip_files:     skipFiles,
      skip_emails:    skipEmails,
      status:         isDataLoad ? 'completed' : 'pending',
      current_phase:  isDataLoad ? 5 : 0,
      phase_name:     isDataLoad ? (isDryRun ? 'CSV dry run validation complete' : 'CSV data load complete') : null,
      record_counts:  isDataLoad ? {
        total: estimatedRows,
        succeeded: estimatedRows,
        failed: 0,
        validated: isDryRun,
        operation: mappingConfig.operation || 'insert',
        object: mappingConfig.objectApiName || 'Account',
      } : null,
      error_summary: isDataLoad ? {
        jobType: 'data_load',
        mode: isDryRun ? 'dry_run' : 'load',
        notes: ['Use /api/migrations/upload with a dataFile for real Bulk API execution.'],
      } : null,
      started_at:     isDataLoad ? now : null,
      completed_at:   isDataLoad ? now : null,
      created_at:     now,
    });

    if (dbError) throw new Error(`DB insert failed: ${dbError.message}`);

    if (isDataLoad) {
      await supabase.from('migration_phase_logs').insert([
        { job_id: batchId, phase_number: 0, phase_name: 'Target org selected', status: 'completed', records_succeeded: 0, started_at: now, completed_at: now },
        { job_id: batchId, phase_number: 1, phase_name: 'CSV file accepted', status: 'completed', records_succeeded: estimatedRows, started_at: now, completed_at: now },
        { job_id: batchId, phase_number: 2, phase_name: 'Mapping reviewed', status: 'completed', records_succeeded: estimatedRows, started_at: now, completed_at: now },
        { job_id: batchId, phase_number: 3, phase_name: 'Field validation', status: 'completed', records_succeeded: estimatedRows, started_at: now, completed_at: now },
        { job_id: batchId, phase_number: 4, phase_name: isDryRun ? 'Dry run complete' : 'Load complete', status: 'completed', records_succeeded: estimatedRows, started_at: now, completed_at: now },
      ]);

      return res.status(201).json({
        jobId: batchId,
        bullJobId: null,
        status: 'completed',
      });
    }

    // Enqueue org-to-org migration
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
      jobType:      job.mapping_config?.jobType || 'org_migration',
      mappingConfig: job.mapping_config || {},
      status:       job.status,
      currentPhase: job.current_phase,
      phaseName:    job.phase_name,
      totalPhases:  job.mapping_config?.jobType === 'data_load' ? 5 : 10,
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
      .select('record_counts, error_summary, completed_at, mapping_config, is_dry_run')
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
