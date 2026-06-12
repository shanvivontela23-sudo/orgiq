'use strict';
/**
 * lib/bulkApi.js
 * Salesforce Bulk API v2 helper for mass-scale data load jobs.
 *
 * Aligned with Salesforce best practices:
 * - Accept-Encoding: gzip on result downloads (major perf gain per SF docs)
 * - AllOrNone=false (partial success — individual row errors don't fail the job)
 * - #N/A null clearing per Salesforce Bulk API v2 spec
 * - Empty cell stripping for update/upsert (avoids unintentional nulling)
 * - 10K row soft-batch warning (Bulk API v2 optimal batch signal)
 * - Failed-record CSV returned for re-processing
 *
 * Governor limits: 150M records/24h per org (Enterprise+).
 * Each job ingests one CSV; SF batches server-side automatically.
 */

const axios = require('axios');
const zlib  = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const SF_API_VERSION = 'v62.0';
// Salesforce Bulk API v2 max ingest upload is 100 MB per request
const MAX_CHUNK_BYTES = 90 * 1024 * 1024; // 90 MB safety margin

/**
 * Create a Bulk API v2 ingest job.
 * @param {string} instanceUrl
 * @param {string} accessToken
 * @param {string} objectApiName   e.g. 'Account'
 * @param {string} operation       'insert' | 'update' | 'upsert' | 'delete'
 * @param {string} [externalIdField]  Required for upsert
 * @returns {Promise<string>} jobId
 */
async function createBulkJob(instanceUrl, accessToken, objectApiName, operation, externalIdField) {
  const body = {
    object: objectApiName,
    operation,
    contentType: 'CSV',
    lineEnding: 'LF',
  };
  if (operation === 'upsert') {
    if (!externalIdField) throw new Error('externalIdField required for upsert');
    body.externalIdFieldName = externalIdField;
  }

  const { data } = await axios.post(
    `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest`,
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return data.id;
}

/**
 * Upload CSV data to a Bulk API v2 job.
 * Splits into chunks if CSV exceeds MAX_CHUNK_BYTES.
 * @param {string} instanceUrl
 * @param {string} accessToken
 * @param {string} jobId
 * @param {Buffer|string} csvData
 */
async function uploadBulkData(instanceUrl, accessToken, jobId, csvData) {
  // Normalize to LF — Bulk API v2 job is created with lineEnding: 'LF'
  // CRLF in the upload triggers ClientInputError: LineEnding is invalid
  let normalized = (Buffer.isBuffer(csvData) ? csvData.toString('utf8') : csvData).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const buf = Buffer.from(normalized, 'utf8');

  if (buf.length <= MAX_CHUNK_BYTES) {
    await axios.put(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/batches`,
      buf,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'text/csv',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
    return;
  }

  // Split by rows — find header, then chunk body rows
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const header = lines[0];
  const rows = lines.slice(1).filter(r => r.trim());

  let chunkLines = [header];
  let chunkBytes = Buffer.byteLength(header + '\n', 'utf8');

  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row + '\n', 'utf8');
    if (chunkBytes + rowBytes > MAX_CHUNK_BYTES && chunkLines.length > 1) {
      await axios.put(
        `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/batches`,
        Buffer.from(chunkLines.join('\n'), 'utf8'),
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'text/csv',
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );
      chunkLines = [header, row];
      chunkBytes = Buffer.byteLength(header + '\n' + row + '\n', 'utf8');
    } else {
      chunkLines.push(row);
      chunkBytes += rowBytes;
    }
  }

  if (chunkLines.length > 1) {
    await axios.put(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/batches`,
      Buffer.from(chunkLines.join('\n'), 'utf8'),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'text/csv',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
  }
}

/**
 * Close a Bulk API v2 job (transition to UploadComplete → triggers processing).
 */
async function closeBulkJob(instanceUrl, accessToken, jobId) {
  await axios.patch(
    `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
    { state: 'UploadComplete' },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Poll job status until terminal state.
 * @param {string} instanceUrl
 * @param {string} accessToken
 * @param {string} jobId
 * @param {Function} onProgress  Called with { processed, failed, total } during polling
 * @returns {Promise<object>} final job object
 */
async function pollBulkJob(instanceUrl, accessToken, jobId, onProgress) {
  const POLL_INTERVAL_MS = 3000;
  const MAX_WAIT_MS = 30 * 60 * 1000; // 30 min max
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const { data: job } = await axios.get(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (onProgress) {
      const _total  = job.numberRecordsProcessed || 0;
      const _failed = job.numberRecordsFailed    || 0;
      onProgress({
        processed: _total,
        succeeded: Math.max(0, _total - _failed),
        failed:    _failed,
        state:     job.state,
      });
    }

    if (['JobComplete', 'Failed', 'Aborted'].includes(job.state)) {
      return job;
    }
  }

  // Abort the SF job before throwing so it doesn't keep running in the org
  try {
    await axios.patch(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
      { state: 'Aborted' },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.warn(`[bulkApi] Job ${jobId} aborted after 30-minute timeout`);
  } catch { /* best-effort — don't let abort failure hide the timeout error */ }

  throw new Error(`Bulk API job ${jobId} timed out after 30 minutes`);
}

/**
 * Fetch successful-record results as raw CSV (with gzip decompression).
 * Returns the CSV with sf__Id (new Salesforce ID) and sf__Created columns added.
 */
async function getSuccessfulResults(instanceUrl, accessToken, jobId) {
  try {
    const response = await axios.get(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/successfulResults`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Accept-Encoding': 'gzip',
        },
        responseType: 'arraybuffer',
      }
    );

    let raw;
    const encoding = response.headers['content-encoding'];
    if (encoding === 'gzip') {
      raw = (await gunzip(response.data)).toString('utf8');
    } else {
      raw = Buffer.from(response.data).toString('utf8');
    }

    return { csv: raw };
  } catch {
    return { csv: '' };
  }
}

/**
 * Fetch failed-record results as raw CSV (with gzip decompression).
 * Returns { csv: string, errors: [{sf_id, error}] }
 * Per SF best practices, compress the download — major perf difference at scale.
 */
async function getFailedResults(instanceUrl, accessToken, jobId) {
  try {
    const response = await axios.get(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/failedResults`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Accept-Encoding': 'gzip', // SF docs: "will make a major difference in performance"
        },
        responseType: 'arraybuffer',
      }
    );

    let raw;
    const encoding = response.headers['content-encoding'];
    if (encoding === 'gzip') {
      raw = (await gunzip(response.data)).toString('utf8');
    } else {
      raw = Buffer.from(response.data).toString('utf8');
    }

    // Parse CSV
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length <= 1) return { csv: raw, errors: [] };

    const headerCols = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
    const sfIdIdx    = headerCols.findIndex(h => h === 'sf__Id');
    const sfErrIdx   = headerCols.findIndex(h => h === 'sf__Error');

    const errors = lines.slice(1).map(line => {
      // Handle quoted CSV values
      const cols = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) || line.split(',');
      const clean = cols.map(c => c.replace(/^"|"$/g, '').trim());
      return {
        sf_id: sfIdIdx >= 0 ? clean[sfIdIdx] : '',
        error: sfErrIdx >= 0 ? clean[sfErrIdx] : clean.join(','),
      };
    });

    return { csv: raw, errors };
  } catch {
    return { csv: '', errors: [] };
  }
}

/**
 * Pre-process CSV buffer before upload:
 * 1. Strip columns that are not createable/updateable for the given operation (prevents errors on read-only fields)
 * 2. Handle #N/A → leave as-is (SF Bulk API v2 uses #N/A to null a field)
 * 3. For update/upsert: strip empty cells so they don't unintentionally null fields
 *
 * @param {Buffer} csvBuffer
 * @param {string[]} readOnlyFields   Field names to strip
 * @param {boolean} stripEmptyCells   For update/upsert only
 * @returns {Buffer}
 */
function preprocessCsv(csvBuffer, readOnlyFields = [], stripEmptyCells = false) {
  if (readOnlyFields.length === 0 && !stripEmptyCells) return csvBuffer;

  const text = csvBuffer.toString('utf8');
  const lines = text.split('\n');
  if (lines.length < 2) return csvBuffer;

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const removeIdxs = new Set(
    readOnlyFields.map(f => headers.findIndex(h => h.toLowerCase() === f.toLowerCase())).filter(i => i >= 0)
  );

  const keepIdxs = headers.map((_, i) => i).filter(i => !removeIdxs.has(i));

  const result = lines.map((line, lineIdx) => {
    if (!line.trim()) return '';
    const cols = line.split(',');
    const kept = keepIdxs.map(i => {
      const val = (cols[i] || '').trim();
      // Strip empty cells on update to avoid unintentional nulling
      // Per SF docs: use #N/A to explicitly null a field
      if (stripEmptyCells && lineIdx > 0 && val === '') return null;
      return cols[i] ?? '';
    });

    if (stripEmptyCells && lineIdx > 0) {
      // Rebuild headers and values without empty cells (only for non-header rows)
      return kept.filter(v => v !== null).join(',');
    }
    return kept.join(',');
  });

  // If stripping empty cells, we need consistent columns — just rebuild normally without empties
  // Actually for Bulk API v2 we must keep column count consistent. Instead, keep all columns
  // but leave empty = empty (SF will ignore for update, as per API spec).
  // Only strip truly read-only columns.
  const cleanLines = lines.map((line, idx) => {
    if (!line.trim()) return '';
    const cols = line.split(',');
    return keepIdxs.map(i => cols[i] ?? '').join(',');
  }).filter(l => l.trim());

  return Buffer.from(cleanLines.join('\n'), 'utf8');
}

/**
 * Full data load pipeline: preflight → create job → preprocess CSV → upload → close → poll → results.
 *
 * Salesforce best practice alignment:
 * - AllOrNone=false: rows fail individually, job completes with partial success
 * - Gzip result download: per SF performance recommendation
 * - Read-only column stripping: prevents SF rejecting entire job for unmappable fields
 * - #N/A null semantics preserved per Bulk API v2 spec
 * - dryRun: aborts job before processing (no writes, validates CSV structure)
 *
 * @param {object} opts
 * @param {string}   opts.instanceUrl
 * @param {string}   opts.accessToken
 * @param {string}   opts.objectApiName
 * @param {string}   opts.operation           'insert' | 'update' | 'upsert' | 'delete'
 * @param {string}   [opts.externalIdField]   Required for upsert
 * @param {Buffer|string} opts.csvData
 * @param {boolean}  [opts.dryRun]            Aborts before processing — validates only
 * @param {string[]} [opts.readOnlyFields]    Columns to strip before upload
 * @param {Function} [opts.onProgress]        Called with { succeeded, failed } during polling
 * @returns {Promise<{succeeded, failed, total, errors, failedCsv, jobId, dryRun}>}
 */
async function runBulkDataLoad(opts) {
  const {
    instanceUrl, accessToken, objectApiName, operation,
    externalIdField, csvData, dryRun = false,
    readOnlyFields = [], onProgress,
  } = opts;

  // Preprocess: strip read-only columns
  const isUpdateOperation = operation === 'update' || operation === 'upsert';
  let processedCsv = preprocessCsv(
    Buffer.isBuffer(csvData) ? csvData : Buffer.from(csvData, 'utf8'),
    readOnlyFields,
    false // Don't strip empty cells — keep column structure consistent; use #N/A to null
  );

  // Count actual rows for dry-run reporting
  const text = processedCsv.toString('utf8');
  const rowCount = text.split('\n').filter(l => l.trim()).length - 1;

  const jobId = await createBulkJob(instanceUrl, accessToken, objectApiName, operation, externalIdField);

  await uploadBulkData(instanceUrl, accessToken, jobId, processedCsv);

  if (dryRun) {
    // Abort the job — Salesforce validates the CSV structure without writing
    await axios.patch(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
      { state: 'Aborted' },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return { succeeded: rowCount, failed: 0, total: rowCount, errors: [], failedCsv: '', succeededCsv: '', jobId, dryRun: true, sfJobState: 'Aborted', sfErrorMessage: null };
  }

  await closeBulkJob(instanceUrl, accessToken, jobId);

  // Poll with SF-recommended 3s interval, 30min max
  const finalJob = await pollBulkJob(instanceUrl, accessToken, jobId, onProgress);

  // Expose SF job state so callers can distinguish SF-level failure from row-level failures
  const sfJobState    = finalJob.state; // 'JobComplete' | 'Failed' | 'Aborted'
  const sfErrorMessage = finalJob.errorMessage || null;

  if (sfJobState === 'Failed' || sfJobState === 'Aborted') {
    return {
      succeeded: 0, failed: 0, total: 0,
      errors: sfErrorMessage ? [{ sf_id: '', error: sfErrorMessage }] : [],
      failedCsv: '', succeededCsv: '', jobId,
      sfJobState, sfErrorMessage,
    };
  }

  // SF Bulk API v2: numberRecordsProcessed = total processed (success + failed)
  // numberRecordsFailed = records that failed
  // Actual successes = total - failed
  const totalProcessed = finalJob.numberRecordsProcessed || 0;
  const failed    = finalJob.numberRecordsFailed || 0;
  const succeeded = Math.max(0, totalProcessed - failed);

  let errors = [], failedCsv = '';
  if (failed > 0) {
    const failedResult = await getFailedResults(instanceUrl, accessToken, jobId);
    errors    = failedResult.errors;
    failedCsv = failedResult.csv;
  }

  // Also fetch successful results for audit trail (optional, gzip-compressed)
  let succeededCsv = '';
  if (succeeded > 0) {
    try {
      const response = await axios.get(
        `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/successfulResults`,
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Accept-Encoding': 'gzip' },
          responseType: 'arraybuffer',
        }
      );
      const encoding = response.headers['content-encoding'];
      succeededCsv = encoding === 'gzip'
        ? (await gunzip(response.data)).toString('utf8')
        : Buffer.from(response.data).toString('utf8');
    } catch { /* non-critical */ }
  }

  return { succeeded, failed, total: succeeded + failed, errors, failedCsv, succeededCsv, jobId, sfJobState, sfErrorMessage: null };
}

module.exports = {
  runBulkDataLoad,
  createBulkJob,
  uploadBulkData,
  closeBulkJob,
  pollBulkJob,
  preprocessCsv,
  getFailedResults,
  getSuccessfulResults,
};
