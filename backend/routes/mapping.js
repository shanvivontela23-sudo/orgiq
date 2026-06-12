'use strict';

/**
 * routes/mapping.js
 * Mapping Sheet Intelligence — MAP-01 to MAP-04
 *
 * POST /api/mapping/parse          — parse xlsx/csv, return rows + column suggestions
 * POST /api/mapping/compare        — compare rows against live org describe
 * POST /api/mapping/create-fields  — batch deploy approved CustomField metadata
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const xlsx    = require('xlsx');

const { requireAuth }          = require('../middleware/auth');
const { withSalesforceClient } = require('../middleware/withSalesforceClient');
const supabase                 = require('../lib/supabase');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeXml(v = '') {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function toApiName(label = '') {
  const n = label.trim().replace(/[^a-zA-Z0-9 _]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return /^[A-Za-z]/.test(n) ? n : `X${n}`;
}

function toRelationshipName(fieldApiName = '') {
  return toApiName(String(fieldApiName).replace(/\..*$/, '').replace(/__c$/i, ''));
}

// Normalise a header string for fuzzy matching
function normalise(s = '') {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const EXPECTED_COLS = {
  object:    ['object', 'objectname', 'objectapiname', 'sfobject'],
  label:     ['label', 'fieldlabel', 'fieldname', 'name'],
  apiName:   ['apiname', 'fieldapiname', 'apifieldname', 'fieldapi'],
  fieldType: ['fieldtype', 'type', 'datatype', 'sftype'],
  required:  ['required', 'isrequired', 'mandatory'],
};

function detectColumnMapping(headers) {
  const mapping = {};
  const used = new Set();

  for (const [key, candidates] of Object.entries(EXPECTED_COLS)) {
    for (const h of headers) {
      const n = normalise(h);
      if (!used.has(h) && candidates.includes(n)) {
        mapping[key] = h;
        used.add(h);
        break;
      }
    }
  }
  return mapping;
}

// Parse xlsx/csv buffer → array of raw row objects
function parseFileToRows(buffer, fileName) {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true, defval: '' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // header: 1 means first row = headers
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return rows;
}

// Map sheet field type string to a canonical SF type
const TYPE_MAP = {
  text: 'Text', string: 'Text',
  number: 'Number', numeric: 'Number', integer: 'Number', decimal: 'Number',
  date: 'Date',
  datetime: 'DateTime', 'date/time': 'DateTime', 'date time': 'DateTime',
  checkbox: 'Checkbox', boolean: 'Checkbox',
  picklist: 'Picklist', dropdown: 'Picklist', select: 'Picklist',
  lookup: 'Lookup', relationship: 'Lookup',
  formula: 'Formula',
  currency: 'Currency',
  email: 'Email',
  phone: 'Phone',
  url: 'Url',
  textarea: 'LongTextArea', 'long text': 'LongTextArea', longtext: 'LongTextArea',
  percent: 'Percent',
};

function canonicalType(raw = '') {
  return TYPE_MAP[raw.toLowerCase().trim()] || null;
}

// SF describe type → our canonical type (for mismatch detection)
const SF_TYPE_MAP = {
  string: 'Text', textarea: 'LongTextArea', boolean: 'Checkbox',
  double: 'Number', int: 'Number', currency: 'Currency', percent: 'Percent',
  date: 'Date', datetime: 'DateTime', email: 'Email', phone: 'Phone', url: 'Url',
  picklist: 'Picklist', reference: 'Lookup', formula: 'Formula',
};

function sfTypeToCanonical(sfType = '') {
  return SF_TYPE_MAP[sfType.toLowerCase()] || sfType;
}

/** Build a single <fields> block (no outer wrapper) for one field. */
function buildFieldBlock(field) {
  const {
    apiName, label, type,
    required = false, length = 255,
    precision = 18, scale = 0,
    picklistValues = [], referenceTo = '',
    formula = '', formulaReturnType = 'Text',
    helpText = '',
  } = field;

  const shortApiName = apiName.includes('.') ? apiName.split('.').pop() : apiName;

  let typeSpecific = '';
  switch (type) {
    case 'Text':      typeSpecific = `<length>${length}</length>`; break;
    case 'Number':
    case 'Currency':
    case 'Percent':   typeSpecific = `<precision>${precision}</precision><scale>${scale}</scale>`; break;
    case 'Picklist':
      typeSpecific = `<valueSet><restricted>false</restricted><valueSetDefinition><sorted>false</sorted>${
        (picklistValues.length ? picklistValues : ['Value1']).map((v, i) =>
          `<value><fullName>${escapeXml(v)}</fullName><default>${i === 0}</default><label>${escapeXml(v)}</label></value>`
        ).join('')
      }</valueSetDefinition></valueSet>`;
      break;
    case 'Lookup':
    case 'MasterDetail':
      typeSpecific = `<referenceTo>${escapeXml(referenceTo || 'Account')}</referenceTo><relationshipName>${escapeXml(toRelationshipName(shortApiName))}</relationshipName>`;
      break;
    case 'Formula':
      typeSpecific = `<formula>${escapeXml(formula || '"placeholder"')}</formula><formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>`;
      break;
    case 'LongTextArea':
      typeSpecific = `<length>32768</length><visibleLines>3</visibleLines>`;
      break;
    default: break;
  }

  const fieldType = type === 'Formula' ? (formulaReturnType || 'Text') : type;

  return `  <fields>
    <fullName>${escapeXml(shortApiName)}</fullName>
    <label>${escapeXml(label)}</label>
    <type>${escapeXml(fieldType)}</type>
    ${typeSpecific}
    ${required && type !== 'Checkbox' ? '<required>true</required>' : ''}
    ${helpText ? `<inlineHelpText>${escapeXml(helpText)}</inlineHelpText>` : ''}
  </fields>`;
}

/** Wrap multiple field blocks into one CustomObject XML (one deploy per object). */
function buildBatchObjectXml(fieldBlocks) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
${fieldBlocks.join('\n')}
</CustomObject>`;
}

async function buildFieldZip(objectApiName, objectXml) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file(`objects/${objectApiName}.object`, objectXml);
  zip.file('package.xml', `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>${escapeXml(objectApiName)}</members><name>CustomObject</name></types>
  <version>62.0</version>
</Package>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function deployZip(sfClient, zipBuffer, checkOnly = false) {
  const axios = require('axios');
  const base64 = zipBuffer.toString('base64');

  const soapEnv = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:CallOptions><met:client>SFCopilot</met:client></met:CallOptions>
    <met:SessionHeader><met:sessionId>${sfClient.accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:deploy>
      <met:ZipFile>${base64}</met:ZipFile>
      <met:DeployOptions>
        <met:allowMissingFiles>false</met:allowMissingFiles>
        <met:autoUpdatePackage>false</met:autoUpdatePackage>
        <met:checkOnly>${checkOnly}</met:checkOnly>
        <met:ignoreWarnings>true</met:ignoreWarnings>
        <met:rollbackOnError>true</met:rollbackOnError>
        <met:singlePackage>true</met:singlePackage>
      </met:DeployOptions>
    </met:deploy>
  </soapenv:Body>
</soapenv:Envelope>`;

  const deployRes = await axios.post(
    `${sfClient.instanceUrl}/services/Soap/m/62.0`,
    soapEnv,
    { headers: { 'Content-Type': 'text/xml', SOAPAction: 'deploy' } }
  );

  const asyncId = deployRes.data.match(/<id>(.*?)<\/id>/)?.[1];
  if (!asyncId) throw new Error('Deploy failed to start');

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusSoap = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header><met:SessionHeader><met:sessionId>${sfClient.accessToken}</met:sessionId></met:SessionHeader></soapenv:Header>
  <soapenv:Body><met:checkDeployStatus><met:asyncProcessId>${asyncId}</met:asyncProcessId><met:includeDetails>true</met:includeDetails></met:checkDeployStatus></soapenv:Body>
</soapenv:Envelope>`;

    const statusRes = await axios.post(
      `${sfClient.instanceUrl}/services/Soap/m/62.0`,
      statusSoap,
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'checkDeployStatus' } }
    );

    const xml  = statusRes.data;
    const done = xml.match(/<done>(.*?)<\/done>/)?.[1] === 'true';
    const succ = xml.match(/<success>(.*?)<\/success>/)?.[1] === 'true';
    if (!done) continue;
    if (succ) return { success: true, asyncId };

    const errors = [];
    for (const m of xml.matchAll(/<message>(.*?)<\/message>/gs)) errors.push(m[1].trim());
    for (const m of xml.matchAll(/<problem>(.*?)<\/problem>/gs)) errors.push(m[1].trim());
    return { success: false, asyncId, errors: [...new Set(errors)] };
  }
  throw new Error('Deploy timed out');
}

async function recordMappingOp({ userId, orgId, label, status, detail }) {
  try {
    const now = new Date().toISOString();
    await supabase.from('migration_jobs').insert({
      id: `map_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      user_id: userId, source_org_id: orgId, target_org_id: orgId,
      mapping_config: { jobType: 'mapping_sheet', label, detail },
      is_dry_run: false, status,
      current_phase: 1, phase_name: label,
      record_counts: { total: detail?.totalFields || 0, succeeded: detail?.created || 0, failed: detail?.failed || 0 },
      started_at: now, completed_at: now, created_at: now,
    });
  } catch { /* non-critical */ }
}

// ── POST /api/mapping/parse ───────────────────────────────────────────────────
// Body: multipart with file + optional colMapping JSON
router.post('/parse', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const rawRows = parseFileToRows(req.file.buffer, req.file.originalname);
    if (!rawRows.length) return res.status(400).json({ error: 'File is empty or could not be parsed' });

    const headers = Object.keys(rawRows[0]);
    const colMap  = detectColumnMapping(headers);

    // Apply column mapping to normalise rows
    const rows = rawRows
      .map(r => ({
        object:    String(r[colMap.object]    || '').trim(),
        label:     String(r[colMap.label]     || '').trim(),
        apiName:   String(r[colMap.apiName]   || '').trim(),
        fieldType: String(r[colMap.fieldType] || '').trim(),
        required:  String(r[colMap.required]  || '').trim().toLowerCase(),
      }))
      .filter(r => r.object); // drop blank rows

    // Count unique objects
    const objectCounts = {};
    for (const r of rows) {
      objectCounts[r.object] = (objectCounts[r.object] || 0) + 1;
    }

    res.json({
      rowCount:    rows.length,
      headers,
      colMap,
      colMapComplete: Object.keys(colMap).length === 5,
      objectCounts,
      objects: Object.keys(objectCounts),
      rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/mapping/compare ─────────────────────────────────────────────────
// Body: { orgId, rows: [{object, label, apiName, fieldType, required}] }
router.post('/compare', requireAuth, withSalesforceClient, async (req, res) => {
  const { rows } = req.body;
  if (!rows?.length) return res.status(400).json({ error: 'rows is required' });

  try {
    // Group by object
    const byObject = {};
    for (const row of rows) {
      if (!byObject[row.object]) byObject[row.object] = [];
      byObject[row.object].push(row);
    }

    const results = [];

    for (const [objectApiName, fields] of Object.entries(byObject)) {
      // Describe object
      let sfFields = {};
      let objectExists = true;
      try {
        const describeRes = await req.sf.fetch(`/services/data/v62.0/sobjects/${objectApiName}/describe`);
        if (!describeRes.ok) {
          objectExists = false;
        } else {
          const describe = await describeRes.json();
          sfFields = Object.fromEntries(
            (describe.fields || []).map(f => [f.name.toLowerCase(), f])
          );
        }
      } catch {
        objectExists = false;
      }

      for (const field of fields) {
        const apiNameLower = (field.apiName || '').toLowerCase();
        const sheetCanon   = canonicalType(field.fieldType);

        if (!objectExists) {
          results.push({ ...field, status: 'object_missing', statusLabel: 'Object Missing', sfType: null, sheetType: sheetCanon });
          continue;
        }

        if (!apiNameLower) {
          results.push({ ...field, status: 'missing', statusLabel: 'Missing', sfType: null, sheetType: sheetCanon });
          continue;
        }

        const sfField = sfFields[apiNameLower];
        if (!sfField) {
          results.push({ ...field, status: 'missing', statusLabel: 'Missing', sfType: null, sheetType: sheetCanon });
          continue;
        }

        const sfCanon = sfTypeToCanonical(sfField.type);
        if (sheetCanon && sfCanon && sheetCanon !== sfCanon) {
          results.push({ ...field, status: 'type_mismatch', statusLabel: 'Type Mismatch', sfType: sfCanon, sheetType: sheetCanon });
        } else {
          results.push({ ...field, status: 'exists', statusLabel: 'Exists', sfType: sfCanon, sheetType: sheetCanon });
        }
      }
    }

    const summary = {
      total:        results.length,
      exists:       results.filter(r => r.status === 'exists').length,
      missing:      results.filter(r => r.status === 'missing').length,
      typeMismatch: results.filter(r => r.status === 'type_mismatch').length,
      objectMissing:results.filter(r => r.status === 'object_missing').length,
    };

    res.json({ results, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/mapping/create-fields ──────────────────────────────────────────
// Body: { orgId, fields: [{object, apiName, label, fieldType, required, ...customisations}] }
//
// Batching strategy: group all fields for the same object into ONE CustomObject
// XML and deploy it as a single zip. 50 fields across 3 objects = 3 deploys,
// not 50. Prevents HTTP timeouts and Metadata API concurrency issues.
router.post('/create-fields', requireAuth, withSalesforceClient, async (req, res) => {
  const { fields } = req.body;
  if (!fields?.length) return res.status(400).json({ error: 'fields array is required' });

  const fieldResults = [];

  // ── Group by object ──────────────────────────────────────────────────────
  const byObject = {};
  for (const f of fields) {
    if (!byObject[f.object]) byObject[f.object] = [];
    const sfType  = canonicalType(f.fieldType) || 'Text';
    const apiName = f.apiName || `${toApiName(f.label)}__c`;
    byObject[f.object].push({ ...f, apiName, type: sfType });
  }

  // ── One deploy per object ────────────────────────────────────────────────
  for (const [objectApiName, objFields] of Object.entries(byObject)) {
    // Build all field blocks for this object in one CustomObject XML
    const fieldBlocks = objFields.map(buildFieldBlock);
    const batchXml    = buildBatchObjectXml(fieldBlocks);

    try {
      // Dry run the whole batch
      const dryZip = await buildFieldZip(objectApiName, batchXml);
      const dryRun = await deployZip(req.sf, dryZip, true);

      if (!dryRun.success) {
        // Mark all fields in this object as failed
        objFields.forEach(f => fieldResults.push({
          object: objectApiName, apiName: f.apiName, label: f.label,
          status: 'failed',
          error: `Dry run failed: ${(dryRun.errors || []).join(' | ')}`,
        }));
        continue;
      }

      // Real deploy — all fields for this object in one call
      const realZip  = await buildFieldZip(objectApiName, batchXml);
      const deployed = await deployZip(req.sf, realZip, false);

      objFields.forEach(f => fieldResults.push({
        object: objectApiName, apiName: f.apiName, label: f.label,
        status: deployed.success ? 'created' : 'failed',
        error:  deployed.success ? null : (deployed.errors || []).join(' | '),
      }));
    } catch (err) {
      objFields.forEach(f => fieldResults.push({
        object: objectApiName, apiName: f.apiName, label: f.label,
        status: 'failed', error: err.message,
      }));
    }
  }

  const created = fieldResults.filter(r => r.status === 'created').length;
  const failed  = fieldResults.filter(r => r.status === 'failed').length;

  await recordMappingOp({
    userId: req.user?.id, orgId: req.orgConn?.id,
    label: `Mapping sheet — ${created} field${created !== 1 ? 's' : ''} created`,
    status: failed === 0 ? 'completed' : created > 0 ? 'completed' : 'failed',
    detail: { totalFields: fields.length, created, failed },
  });

  res.json({ results: fieldResults, summary: { total: fields.length, created, failed } });
});

module.exports = router;
