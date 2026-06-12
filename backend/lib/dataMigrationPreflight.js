'use strict';
/**
 * lib/dataMigrationPreflight.js
 *
 * Certified data migration pre-flight checks aligned with Salesforce best practices:
 * https://help.salesforce.com/s/articleView?id=000385417
 * https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/asynch_api_planning_guidelines.htm
 *
 * Checks run BEFORE any Bulk API job is submitted.
 * Returns { passed, errors, warnings, info } — errors block launch, warnings are shown to user.
 */

const axios = require('axios');

const SF_API_VERSION = 'v62.0';

// Objects with self-referential lookups that require a 2-pass load
const SELF_REFERENTIAL_OBJECTS = new Set(['Account', 'Contact', 'Case', 'Asset', 'Territory2']);

// Parent-child relationship map — if you load child first you'll get invalid cross-reference ID errors
const LOAD_ORDER_DEPENDENCIES = {
  Contact:        ['Account'],
  Opportunity:    ['Account'],
  OpportunityLineItem: ['Opportunity', 'Product2', 'PricebookEntry'],
  Case:           ['Account', 'Contact'],
  Task:           ['Account', 'Contact', 'Lead', 'Opportunity'],
  Event:          ['Account', 'Contact', 'Lead', 'Opportunity'],
  Lead:           [],
  CampaignMember: ['Campaign', 'Contact', 'Lead'],
  Asset:          ['Account', 'Contact', 'Product2'],
  Contract:       ['Account'],
  Order:          ['Account', 'Contract'],
  OrderItem:      ['Order', 'Product2', 'PricebookEntry'],
};

/**
 * Detect whether an org is sandbox or production.
 * Sandboxes have instance URLs containing 'sandbox', 'scratch', 'develop', 'orgfarm', or
 * domain patterns like *.sandbox.my.salesforce.com
 */
function detectOrgType(instanceUrl) {
  const url = (instanceUrl || '').toLowerCase();
  const isSandbox =
    url.includes('.sandbox.') ||
    url.includes('scratch') ||
    url.includes('develop.my.') ||
    url.includes('orgfarm') ||
    url.includes('.cs') ||         // Classic sandbox pods cs1–cs999
    /--\w+\.sandbox\./.test(url);  // my-org--sandboxname.sandbox.my.salesforce.com
  return isSandbox ? 'sandbox' : 'production';
}

/**
 * Call Salesforce Limits API to get Bulk API daily usage.
 * Returns { used, total, percentUsed }
 */
async function getBulkApiLimits(instanceUrl, accessToken) {
  try {
    const { data } = await axios.get(
      `${instanceUrl}/services/data/${SF_API_VERSION}/limits`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, timeout: 15000 }
    );
    const bulk2 = data?.DailyBulkV2QueryJobs || data?.DailyBulkApiRequests;
    if (bulk2) {
      return {
        used:        bulk2.Max - bulk2.Remaining,
        total:       bulk2.Max,
        remaining:   bulk2.Remaining,
        percentUsed: Math.round(((bulk2.Max - bulk2.Remaining) / bulk2.Max) * 100),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether the authenticated user has Create/Edit/Delete on the target object.
 * Uses the sObject describe endpoint (requires at least Read on the object).
 */
async function checkObjectPermissions(instanceUrl, accessToken, objectApiName) {
  try {
    const { data } = await axios.get(
      `${instanceUrl}/services/data/${SF_API_VERSION}/sobjects/${objectApiName}/describe`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
    );
    return {
      createable: data.createable,
      updateable: data.updateable,
      deletable:  data.deletable,
      queryable:  data.queryable,
      fields:     (data.fields || []).map(f => ({
        name:         f.name,
        label:        f.label,
        type:         f.type,
        createable:   f.createable,
        updateable:   f.updateable,
        nillable:     f.nillable,
        externalId:   f.externalId,
        unique:       f.unique,
        referenceTo:  f.referenceTo || [],
        defaultedOnCreate: f.defaultedOnCreate,
        calculated:   f.calculated,
      })),
    };
  } catch (err) {
    if (err.response?.status === 404) {
      return { error: `Object "${objectApiName}" does not exist in this org.` };
    }
    if (err.response?.status === 403) {
      return { error: `No access to object "${objectApiName}".` };
    }
    return { error: err.message };
  }
}

/**
 * Validate that CSV column headers map to real, createable/updateable fields on the target object.
 * Returns { valid: [], invalid: [], readOnly: [], notNillable: [] }
 */
function validateCsvHeaders(csvHeaders, objectFields, operation) {
  const fieldMap = {};
  for (const f of objectFields) fieldMap[f.name.toLowerCase()] = f;

  const valid = [], invalid = [], readOnly = [], notNillable = [];

  for (const header of csvHeaders) {
    const h = header.trim();
    if (!h || h === 'Id') continue;

    const field = fieldMap[h.toLowerCase()];
    if (!field) {
      invalid.push(h);
      continue;
    }

    const isInsert = operation === 'insert';
    const isUpdate = operation === 'update' || operation === 'upsert';

    if (isInsert && !field.createable && !field.calculated && !field.defaultedOnCreate) {
      readOnly.push(h);
    } else if (isUpdate && !field.updateable) {
      readOnly.push(h);
    } else {
      valid.push(h);
    }

    // Warn about required fields with non-nillable that might fail with empty values
    if (!field.nillable && !field.defaultedOnCreate && field.createable && isInsert) {
      notNillable.push(h);
    }
  }

  return { valid, invalid, readOnly, notNillable };
}

/**
 * Check for active duplicate rules on the object (REST API).
 */
async function checkDuplicateRules(instanceUrl, accessToken, objectApiName) {
  try {
    const { data } = await axios.get(
      `${instanceUrl}/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(
        `SELECT Id, DeveloperName, IsActive FROM DuplicateRule WHERE SobjectType='${objectApiName}' AND IsActive=true`
      )}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
    );
    return (data?.records || []).map(r => r.DeveloperName);
  } catch {
    return []; // Tooling API not always accessible; degrade gracefully
  }
}

/**
 * Get count of existing records in the target object (for duplicate risk awareness).
 */
async function getExistingRecordCount(instanceUrl, accessToken, objectApiName) {
  try {
    const { data } = await axios.get(
      `${instanceUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(
        `SELECT COUNT() FROM ${objectApiName}`
      )}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
    );
    return data?.totalSize ?? null;
  } catch {
    return null;
  }
}

/**
 * Main preflight runner. Call before submitting a Bulk API job.
 *
 * @param {object} opts
 * @param {string} opts.instanceUrl
 * @param {string} opts.accessToken
 * @param {string} opts.objectApiName
 * @param {string} opts.operation         'insert' | 'update' | 'upsert' | 'delete'
 * @param {string} [opts.externalIdField]
 * @param {string[]} [opts.csvHeaders]    Column names from the uploaded CSV
 * @param {number} [opts.rowCount]        Rows in the upload
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{passed, errors, warnings, info, objectMeta}>}
 */
async function runDataMigrationPreflight(opts) {
  const {
    instanceUrl, accessToken, objectApiName, operation,
    externalIdField, csvHeaders = [], rowCount = 0, dryRun = false,
  } = opts;

  const errors = [];
  const warnings = [];
  const info = [];

  // ── 1. Sandbox vs Production detection ──────────────────────────────────────
  const orgType = detectOrgType(instanceUrl);
  if (orgType === 'production' && !dryRun) {
    warnings.push({
      code: 'PRODUCTION_ORG',
      message: '⚠️ Target is a production org. Salesforce recommends running a full dry-run in a sandbox before loading into production.',
      action: 'Enable "Dry Run" mode first, or point to a sandbox.',
    });
  }
  info.push({ code: 'ORG_TYPE', message: `Target org detected as: ${orgType}` });

  // ── 2. Bulk API daily limit check ────────────────────────────────────────────
  const limits = await getBulkApiLimits(instanceUrl, accessToken);
  if (limits) {
    info.push({ code: 'BULK_LIMIT', message: `Bulk API v2 daily usage: ${limits.used.toLocaleString()} / ${limits.total.toLocaleString()} (${limits.percentUsed}% used, ${limits.remaining.toLocaleString()} remaining)` });
    if (limits.percentUsed >= 90) {
      errors.push({ code: 'BULK_LIMIT_CRITICAL', message: `Bulk API daily limit ${limits.percentUsed}% consumed — only ${limits.remaining.toLocaleString()} rows remaining today. Load will likely fail.`, action: 'Wait until the 24-hour window resets or contact Salesforce to increase your limit.' });
    } else if (limits.percentUsed >= 75) {
      warnings.push({ code: 'BULK_LIMIT_HIGH', message: `Bulk API daily limit ${limits.percentUsed}% consumed. ${rowCount.toLocaleString()} new rows will bring usage to ~${Math.round(((limits.used + rowCount) / limits.total) * 100)}%.`, action: 'Monitor usage in Setup → Company Information → API Requests.' });
    }
    if (rowCount > limits.remaining) {
      errors.push({ code: 'BULK_LIMIT_EXCEEDED', message: `Your file has ${rowCount.toLocaleString()} rows but only ${limits.remaining.toLocaleString()} Bulk API rows remain today.`, action: 'Split into smaller batches across multiple days, or purchase additional API capacity.' });
    }
  }

  // ── 3. Object permissions ────────────────────────────────────────────────────
  const objectMeta = await checkObjectPermissions(instanceUrl, accessToken, objectApiName);
  if (objectMeta.error) {
    errors.push({ code: 'OBJECT_ACCESS_ERROR', message: objectMeta.error, action: 'Verify the object name and migration user profile permissions.' });
    return { passed: false, errors, warnings, info, objectMeta: null };
  }

  const needsCreate = operation === 'insert';
  const needsUpdate = operation === 'update' || operation === 'upsert';

  if (needsCreate && !objectMeta.createable) {
    errors.push({ code: 'NO_CREATE_PERMISSION', message: `Migration user does not have Create permission on ${objectApiName}.`, action: 'Grant Create permission via profile or permission set.' });
  }
  if (needsUpdate && !objectMeta.updateable) {
    errors.push({ code: 'NO_UPDATE_PERMISSION', message: `Migration user does not have Edit permission on ${objectApiName}.`, action: 'Grant Edit permission via profile or permission set.' });
  }

  // ── 4. External ID field validation (upsert) ──────────────────────────────
  if (operation === 'upsert') {
    if (!externalIdField) {
      errors.push({ code: 'UPSERT_NO_EXTERNAL_ID', message: 'Upsert requires an External ID field to be specified.', action: 'Add an External ID custom field to the object and specify it here.' });
    } else {
      const extField = objectMeta.fields?.find(f => f.name.toLowerCase() === externalIdField.toLowerCase());
      if (!extField) {
        errors.push({ code: 'EXTERNAL_ID_NOT_FOUND', message: `External ID field "${externalIdField}" does not exist on ${objectApiName}.`, action: 'Check the field API name. External ID fields typically end in __c.' });
      } else if (!extField.externalId && extField.name !== 'Id') {
        errors.push({ code: 'FIELD_NOT_EXTERNAL_ID', message: `Field "${externalIdField}" exists but is NOT marked as an External ID in Salesforce.`, action: 'Edit the field in Setup → Object Manager → ${objectApiName} → Fields → ${externalIdField} and check "External ID".' });
      } else if (!csvHeaders.map(h => h.toLowerCase()).includes(externalIdField.toLowerCase())) {
        errors.push({ code: 'EXTERNAL_ID_NOT_IN_CSV', message: `External ID field "${externalIdField}" is not a column in your CSV.`, action: 'Add a column named exactly "${externalIdField}" to your CSV with unique values per row.' });
      }
    }
  }

  // ── 5. CSV header validation ────────────────────────────────────────────────
  if (csvHeaders.length > 0 && objectMeta.fields) {
    const headerCheck = validateCsvHeaders(csvHeaders, objectMeta.fields, operation);

    if (headerCheck.invalid.length > 0) {
      errors.push({
        code: 'INVALID_FIELD_NAMES',
        message: `${headerCheck.invalid.length} column(s) in your CSV don't match any ${objectApiName} field: ${headerCheck.invalid.slice(0, 5).join(', ')}${headerCheck.invalid.length > 5 ? '…' : ''}`,
        action: 'Use exact Salesforce API field names (e.g. FirstName, not First Name). Check Setup → Object Manager.',
        fields: headerCheck.invalid,
      });
    }
    if (headerCheck.readOnly.length > 0) {
      warnings.push({
        code: 'READ_ONLY_FIELDS',
        message: `${headerCheck.readOnly.length} column(s) are read-only for ${operation} and will be ignored by Salesforce: ${headerCheck.readOnly.join(', ')}`,
        action: 'Remove these columns from your CSV to avoid confusion.',
        fields: headerCheck.readOnly,
      });
    }
    info.push({ code: 'HEADER_CHECK', message: `${headerCheck.valid.length} of ${csvHeaders.filter(h => h && h !== 'Id').length} columns validated against ${objectApiName} schema.` });
  }

  // ── 6. Load order / relationship warnings ─────────────────────────────────
  const requiredParents = LOAD_ORDER_DEPENDENCIES[objectApiName];
  if (requiredParents && requiredParents.length > 0) {
    warnings.push({
      code: 'LOAD_ORDER_DEPENDENCY',
      message: `Loading ${objectApiName} requires parent records to exist first: ${requiredParents.join(', ')}.`,
      action: `Ensure ${requiredParents.join(' and ')} records are already in the target org before this load. Salesforce will return INVALID_CROSS_REFERENCE_KEY errors otherwise.`,
    });
  }

  // ── 7. Self-referential object warning ───────────────────────────────────
  if (SELF_REFERENTIAL_OBJECTS.has(objectApiName)) {
    const selfRefHeaders = csvHeaders.filter(h =>
      ['ParentId', 'ReportsToId', 'MasterRecordId'].includes(h)
    );
    if (selfRefHeaders.length > 0) {
      warnings.push({
        code: 'SELF_REFERENTIAL_OBJECT',
        message: `${objectApiName} contains self-referential field(s): ${selfRefHeaders.join(', ')}. Salesforce best practice requires a 2-pass load: first load records without the self-referential field, then update with it.`,
        action: '1st pass: remove ParentId/ReportsToId column. 2nd pass: update records with the parent reference using upsert + External ID.',
      });
    }
  }

  // ── 8. Duplicate rules warning ───────────────────────────────────────────
  const duplicateRules = await checkDuplicateRules(instanceUrl, accessToken, objectApiName);
  if (duplicateRules.length > 0) {
    warnings.push({
      code: 'ACTIVE_DUPLICATE_RULES',
      message: `${duplicateRules.length} active duplicate rule(s) found on ${objectApiName}: ${duplicateRules.join(', ')}. Bulk API v2 does NOT support the Sforce-Duplicate-Rule-Header — rules will run and may block records.`,
      action: 'Consider temporarily deactivating duplicate rules in Setup → Duplicate Management → Duplicate Rules during the migration, then re-enable afterwards.',
    });
  }

  // ── 9. Automation reminder ───────────────────────────────────────────────
  warnings.push({
    code: 'AUTOMATION_REMINDER',
    message: 'Automation reminder: validation rules, workflow rules, flows, and Apex triggers fire on every record save — even during bulk loads.',
    action: 'Review Setup → Automation and consider temporarily disabling non-critical rules to speed up loading and avoid unexpected failures. Re-enable after migration.',
  });

  // ── 10. Existing record count ────────────────────────────────────────────
  const existingCount = await getExistingRecordCount(instanceUrl, accessToken, objectApiName);
  if (existingCount !== null) {
    info.push({ code: 'EXISTING_COUNT', message: `Target org currently has ${existingCount.toLocaleString()} ${objectApiName} records.` });
    if (operation === 'insert' && existingCount > 0) {
      warnings.push({
        code: 'EXISTING_DATA_INSERT',
        message: `You are inserting into ${objectApiName} which already has ${existingCount.toLocaleString()} records. Duplicate records may be created.`,
        action: 'Use "Upsert" with an External ID if you want to avoid duplicates. Use "Insert" only if you are certain these are new records.',
      });
    }
  }

  // ── 11. Null value warning ────────────────────────────────────────────────
  warnings.push({
    code: 'NULL_FIELD_HANDLING',
    message: 'Empty cells in your CSV will NOT clear existing field values in Salesforce Bulk API v2 by default (empty strings are ignored for update/upsert operations). Explicitly set #N/A to null a field.',
    action: 'To explicitly clear a field, use #N/A as the cell value. Empty cells are treated as "no change" on update.',
  });

  const passed = errors.length === 0;
  return { passed, errors, warnings, info, orgType, objectMeta, limits };
}

module.exports = { runDataMigrationPreflight, detectOrgType, getBulkApiLimits };
