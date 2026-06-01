require('dotenv').config();
const { Worker } = require('bullmq');
const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const { getRedisConnection } = require('./redisConnection');
const supabase = require('../lib/supabase');
const { getSalesforceOAuthConfig } = require('../lib/salesforceOAuth');

const ENGINE_DIR = path.resolve(__dirname, '../../engine');

/**
 * Refresh OAuth tokens for a connected org via Salesforce refresh_token grant.
 * Returns { access_token, instance_url }
 */
async function refreshOrgToken(orgId) {
  const { data: org, error } = await supabase
    .from('connected_orgs')
    .select('access_token, refresh_token, instance_url, org_type')
    .eq('id', orgId)
    .single();

  if (error || !org) throw new Error(`Org ${orgId} not found: ${error?.message}`);

  // Try to refresh if we have a refresh_token
  if (org.refresh_token) {
    try {
      const oauthConfig = getSalesforceOAuthConfig(org.org_type);
      const { data: tokenData } = await axios.post(
        `${oauthConfig.loginUrl}/services/oauth2/token`,
        new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     oauthConfig.clientId,
          client_secret: oauthConfig.clientSecret,
          refresh_token: org.refresh_token,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      // Persist refreshed token
      await supabase
        .from('connected_orgs')
        .update({
          access_token: tokenData.access_token,
          instance_url: tokenData.instance_url || org.instance_url,
        })
        .eq('id', orgId);

      return {
        access_token: tokenData.access_token,
        instance_url: tokenData.instance_url || org.instance_url,
      };
    } catch (refreshErr) {
      console.warn(`[token-refresh] Refresh failed for org ${orgId}, using existing token:`, refreshErr.message);
    }
  }

  return { access_token: org.access_token, instance_url: org.instance_url };
}

/**
 * Persist a phase log entry to Supabase.
 */
async function writePhaseLog(jobId, phase) {
  const { error } = await supabase.from('migration_phase_logs').upsert(
    {
      job_id:           jobId,
      phase_number:     phase.number,
      phase_name:       phase.name,
      status:           phase.status,
      records_succeeded: phase.recordsSucceeded || 0,
    },
    { onConflict: 'job_id,phase_number' }
  );
  if (error) console.error(`[phase-log] Supabase error:`, error.message);
}

async function updateJobProgress(jobId, attrs) {
  const { error } = await supabase
    .from('migration_jobs')
    .update(attrs)
    .eq('id', jobId);
  if (error) console.error(`[job-progress] Supabase error:`, error.message);
}

/**
 * Mark migration job completed in Supabase.
 */
async function markCompleted(jobId, recordCounts) {
  const { error } = await supabase
    .from('migration_jobs')
    .update({
      status:        'completed',
      record_counts: recordCounts,
      completed_at:  new Date().toISOString(),
    })
    .eq('id', jobId);
  if (error) console.error(`[completed] Supabase error:`, error.message);
  else console.log(`[completed] job=${jobId}`, recordCounts);
}

/**
 * Mark migration job failed in Supabase.
 */
async function markFailed(jobId, errorSummary) {
  const { error } = await supabase
    .from('migration_jobs')
    .update({
      status:        'failed',
      error_summary: errorSummary,
      completed_at:  new Date().toISOString(),
    })
    .eq('id', jobId);
  if (error) console.error(`[failed] Supabase error:`, error.message);
  else console.error(`[failed] job=${jobId}`, errorSummary);
}

/**
 * Build CLI args array for the Python engine from job config.
 */
function buildEngineArgs(jobData) {
  const {
    batchId,
    sourceOrgId,
    targetOrgId,
    mappingConfig,
    isDryRun,
    isPiiTarget,
    skipFiles,
    skipEmails,
  } = jobData;

  const args = [
    'sf_migrate.py',
    '--batch-id', batchId,
    '--source-org', sourceOrgId,
    '--target-org', targetOrgId,
  ];

  if (isDryRun) args.push('--dry-run');
  if (isPiiTarget) args.push('--pii-target');
  if (skipFiles) args.push('--skip-files');
  if (skipEmails) args.push('--skip-emails');

  if (mappingConfig?.mappingFileUrl) {
    args.push('--mapping-file', mappingConfig.mappingFileUrl);
  }

  if (mappingConfig?.sourceFilters) {
    args.push('--source-filters', JSON.stringify(mappingConfig.sourceFilters));
  }

  return args;
}

/**
 * Parse a stdout line from the Python engine.
 * Expected format: JSON lines like:
 *   {"type":"phase","number":2,"name":"Contact load","status":"running"}
 *   {"type":"progress","succeeded":1200,"failed":3,"phase":2}
 *   {"type":"complete","recordCounts":{"total":42800,"succeeded":42103,"failed":697}}
 *   {"type":"error","sfId":"003XX","object":"Contact","code":"FIELD_CUSTOM...","action":"..."}
 */
function parseLine(line) {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

const worker = new Worker(
  'migrations',
  async (job) => {
    const { batchId, sourceOrgId, targetOrgId } = job.data;
    console.log(`[worker] Starting migration job ${batchId}`);

    // 1. Refresh OAuth tokens for both orgs
    const [sourceToken, targetToken] = await Promise.all([
      refreshOrgToken(sourceOrgId),
      refreshOrgToken(targetOrgId),
    ]);

    // 2. Build env for Python process
    const pythonEnv = {
      ...process.env,
      SOURCE_ACCESS_TOKEN: sourceToken.access_token,
      SOURCE_INSTANCE_URL: sourceToken.instance_url,
      TARGET_ACCESS_TOKEN: targetToken.access_token,
      TARGET_INSTANCE_URL: targetToken.instance_url,
      // MCP_SERVICE_URL tells the engine where to call for schema introspection.
      // In Docker, this should be the backend container's internal hostname.
      MCP_SERVICE_URL: process.env.MCP_SERVICE_URL || 'http://localhost:3001',
    };

    // 3. Spawn Python engine
    const args = buildEngineArgs(job.data);
    const pythonProcess = spawn('python3', args, {
      cwd: ENGINE_DIR,
      env: pythonEnv,
    });

    const recordCounts = { total: 0, succeeded: 0, failed: 0 };
    const pendingWrites = [];
    let stdoutChain = Promise.resolve();

    // 4. Stream stdout — parse JSON lines for phase updates and progress
    async function handleEngineOutput(data) {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = parseLine(line);
        if (!msg) {
          console.log(`[engine stdout] ${line}`);
          continue;
        }

        if (msg.type === 'phase') {
          const phaseWrite = writePhaseLog(batchId, {
            number: msg.number,
            name: msg.name,
            status: msg.status,
            recordsSucceeded: 0,
          });
          pendingWrites.push(phaseWrite);
          await phaseWrite;

          const progressAttrs = {
            current_phase: msg.number,
            phase_name: msg.name,
            started_at: new Date().toISOString(),
          };
          if (msg.status === 'running') progressAttrs.status = 'running';
          if (msg.status === 'failed') progressAttrs.status = 'failed';

          const progressWrite = updateJobProgress(batchId, progressAttrs);
          pendingWrites.push(progressWrite);
          await progressWrite;
        }

        if (msg.type === 'progress') {
          recordCounts.succeeded = msg.succeeded;
          recordCounts.failed = msg.failed;
          recordCounts.total = msg.succeeded + msg.failed;
          const countWrite = updateJobProgress(batchId, { record_counts: { ...recordCounts } });
          pendingWrites.push(countWrite);
          await countWrite;
        }

        if (msg.type === 'complete') {
          recordCounts.succeeded = msg.recordCounts?.succeeded || 0;
          recordCounts.failed = msg.recordCounts?.failed || 0;
          recordCounts.total = msg.recordCounts?.total ?? (recordCounts.succeeded + recordCounts.failed);
        }

        if (msg.type === 'error') {
          console.error(`[engine error] ${msg.object}/${msg.sfId}: ${msg.code}`);
          // TODO: append to error log in Supabase
        }
      }
    }

    pythonProcess.stdout.on('data', (data) => {
      stdoutChain = stdoutChain.then(() => handleEngineOutput(data));
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error(`[engine stderr] ${data.toString()}`);
    });

    // 5. Wait for engine to finish
    await new Promise((resolve, reject) => {
      pythonProcess.on('close', async (code) => {
        await stdoutChain;
        await Promise.allSettled(pendingWrites);
        if (code === 0) {
          await markCompleted(batchId, recordCounts);
          resolve();
        } else {
          await markFailed(batchId, { exitCode: code, recordCounts });
          reject(new Error(`Python engine exited with code ${code}`));
        }
      });

      pythonProcess.on('error', (err) => {
        markFailed(batchId, { error: err.message }).catch(console.error);
        reject(err);
      });
    });

    console.log(`[worker] Migration ${batchId} completed`);
    return { batchId, recordCounts };
  },
  {
    connection: getRedisConnection(),
    concurrency: 3, // max 3 migrations running simultaneously
  }
);

worker.on('completed', (job, result) => {
  console.log(`[worker] Job ${job.id} completed`, result);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[worker] Worker error:', err);
});

console.log('OrgIQ migration worker started — listening on queue: migrations');
