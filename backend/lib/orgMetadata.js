'use strict';

/**
 * orgMetadata.js
 *
 * Fetches org-specific metadata BEFORE generation so Claude gets
 * a constrained list instead of guessing.
 *
 * Cached in Redis (same pattern as schemaContext.js).
 *
 * What it fetches per artifact type:
 *   flow         → existing flow names, available objects, flow categories
 *   report       → valid report types, report folders, existing report names
 *   validationRule → existing VR names on the object
 *   apex         → existing class/trigger names
 *   permissionSet → existing permission set names
 */

const redis = require('./redisClient');

const TTL = 60 * 60 * 6; // 6-hour cache

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Fetch all org metadata needed before generation for a given artifact type.
 * Returns a structured context object injected into the interrogator prompt.
 */
async function getOrgMetadataContext(orgId, artifactType, sfClient, options = {}) {
  if (!sfClient) return {};

  try {
    switch (artifactType) {
      case 'flow':         return await getFlowContext(orgId, sfClient, options);
      case 'report':       return await getReportContext(orgId, sfClient, options);
      case 'validationRule': return await getValidationRuleContext(orgId, sfClient, options);
      case 'apex':         return await getApexContext(orgId, sfClient, options);
      case 'permissionSet': return await getPermissionSetContext(orgId, sfClient, options);
      default:             return {};
    }
  } catch (err) {
    console.warn(`[orgMetadata] Failed to fetch context for ${artifactType}:`, err.message);
    return {};
  }
}

// ── Flow context ──────────────────────────────────────────────────────────────

async function getFlowContext(orgId, sfClient, { object } = {}) {
  const cacheKey = `orgmeta:${orgId}:flow:${object || 'all'}`;
  const cached = await tryCache(cacheKey);
  if (cached) return cached;

  const results = await Promise.allSettled([
    // Existing active flows — check for conflicts and consolidation needs
    sfClient.query(
      `SELECT ApiName, Label, ProcessType, TriggerType, Status
       FROM FlowVersionView
       WHERE Status = 'Active'
       ${object ? `AND TriggerObjectOrEventLabel = '${escapeSoql(object)}'` : ''}
       ORDER BY ApiName LIMIT 50`
    ),
    // Flow categories / process types available in this org
    sfClient.query(
      `SELECT DeveloperName, Label FROM FlowCategory ORDER BY Label LIMIT 30`
    ).catch(() => ({ records: [] })),
  ]);

  const existingFlows = results[0].status === 'fulfilled'
    ? (results[0].value.records || []).map(f => ({
        apiName:     f.ApiName,
        label:       f.Label,
        processType: f.ProcessType,
        triggerType: f.TriggerType,
        status:      f.Status,
      }))
    : [];

  const context = {
    existingFlows,
    note: existingFlows.length > 0
      ? `${existingFlows.length} active flow(s) already exist${object ? ` on ${object}` : ''}. Consider consolidation before creating a new one.`
      : 'No active flows found matching the criteria.',
  };

  await trySetCache(cacheKey, context, TTL);
  return context;
}

// ── Report context ────────────────────────────────────────────────────────────

async function getReportContext(orgId, sfClient, { keyword } = {}) {
  const cacheKey = `orgmeta:${orgId}:report:${keyword || 'all'}`;
  const cached = await tryCache(cacheKey);
  if (cached) return cached;

  const results = await Promise.allSettled([
    // Valid report types in this org
    sfClient.query(
      `SELECT DeveloperName, Label, Category
       FROM ReportType
       WHERE IsActive = true
       ${keyword ? `AND (Label LIKE '%${escapeSoql(keyword)}%' OR DeveloperName LIKE '%${escapeSoql(keyword)}%')` : ''}
       ORDER BY Label LIMIT 60`
    ),
    // Available report folders
    sfClient.query(
      `SELECT DeveloperName, Name, Type
       FROM Folder
       WHERE Type = 'Report' AND AccessType != 'Hidden'
       ORDER BY Name LIMIT 30`
    ),
    // Existing report names — to detect conflicts
    sfClient.query(
      `SELECT DeveloperName, Name, FolderName
       FROM Report
       WHERE IsDeleted = false
       ORDER BY LastModifiedDate DESC LIMIT 30`
    ).catch(() => ({ records: [] })),
  ]);

  const reportTypes = results[0].status === 'fulfilled'
    ? (results[0].value.records || []).map(rt => ({
        developerName: rt.DeveloperName,
        label:         rt.Label,
        category:      rt.Category,
      }))
    : [];

  const folders = results[1].status === 'fulfilled'
    ? (results[1].value.records || []).map(f => ({
        developerName: f.DeveloperName,
        name:          f.Name,
      }))
    : [];

  const existingReports = results[2].status === 'fulfilled'
    ? (results[2].value.records || []).map(r => ({
        developerName: r.DeveloperName,
        name:          r.Name,
        folder:        r.FolderName,
      }))
    : [];

  const context = {
    reportTypes,
    folders,
    existingReports,
    reportTypeNames: reportTypes.map(rt => rt.developerName),
    folderNames:     folders.map(f => f.developerName),
    notes: [
      reportTypes.length === 0
        ? 'No report types found — the org may have custom report types only.'
        : `${reportTypes.length} report type(s) available.`,
      folders.length === 0
        ? 'No accessible report folders found.'
        : `${folders.length} report folder(s) available: ${folders.slice(0, 5).map(f => f.name).join(', ')}${folders.length > 5 ? '…' : ''}`,
    ].join(' '),
  };

  await trySetCache(cacheKey, context, TTL);
  return context;
}

// ── Validation rule context ───────────────────────────────────────────────────

async function getValidationRuleContext(orgId, sfClient, { object } = {}) {
  if (!object) return {};
  const cacheKey = `orgmeta:${orgId}:vr:${object}`;
  const cached = await tryCache(cacheKey);
  if (cached) return cached;

  const result = await sfClient.toolingQuery(
    `SELECT Id, ValidationName, Active, Description
     FROM ValidationRule
     WHERE EntityDefinition.QualifiedApiName = '${escapeSoql(object)}'
     ORDER BY ValidationName LIMIT 50`
  ).catch(() => ({ records: [] }));

  const existingRules = (result.records || []).map(r => ({
    name:        r.ValidationName,
    active:      r.Active,
    description: r.Description,
  }));

  const context = {
    object,
    existingRules,
    note: existingRules.length > 0
      ? `${existingRules.length} existing validation rule(s) on ${object}: ${existingRules.map(r => r.name).join(', ')}`
      : `No existing validation rules on ${object}.`,
  };

  await trySetCache(cacheKey, context, TTL);
  return context;
}

// ── Apex context ──────────────────────────────────────────────────────────────

async function getApexContext(orgId, sfClient, { name } = {}) {
  const cacheKey = `orgmeta:${orgId}:apex:${name || 'all'}`;
  const cached = await tryCache(cacheKey);
  if (cached) return cached;

  const results = await Promise.allSettled([
    sfClient.toolingQuery(
      `SELECT Name, ApiVersion, Status FROM ApexClass
       ${name ? `WHERE Name LIKE '%${escapeSoql(name)}%'` : ''}
       ORDER BY Name LIMIT 30`
    ),
    sfClient.toolingQuery(
      `SELECT Name, ApiVersion, Status FROM ApexTrigger
       ${name ? `WHERE Name LIKE '%${escapeSoql(name)}%'` : ''}
       ORDER BY Name LIMIT 20`
    ),
  ]);

  const classes  = results[0].status === 'fulfilled' ? (results[0].value.records || []) : [];
  const triggers = results[1].status === 'fulfilled' ? (results[1].value.records || []) : [];

  const context = {
    existingClasses:  classes.map(c => c.Name),
    existingTriggers: triggers.map(t => t.Name),
    note: `${classes.length} Apex class(es), ${triggers.length} trigger(s) found in org.`,
  };

  await trySetCache(cacheKey, context, TTL);
  return context;
}

// ── Permission set context ────────────────────────────────────────────────────

async function getPermissionSetContext(orgId, sfClient) {
  const cacheKey = `orgmeta:${orgId}:permset`;
  const cached = await tryCache(cacheKey);
  if (cached) return cached;

  const result = await sfClient.query(
    `SELECT Name, Label, License.Name FROM PermissionSet
     WHERE IsOwnedByProfile = false ORDER BY Label LIMIT 50`
  ).catch(() => ({ records: [] }));

  const existing = (result.records || []).map(p => ({
    name:    p.Name,
    label:   p.Label,
    license: p.License?.Name,
  }));

  const context = {
    existingPermissionSets: existing,
    note: `${existing.length} existing permission set(s) in org.`,
  };

  await trySetCache(cacheKey, context, TTL);
  return context;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function tryCache(key) {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function trySetCache(key, value, ttl) {
  try { await redis.set(key, JSON.stringify(value), 'EX', ttl); } catch {}
}

function escapeSoql(str) {
  return String(str).replace(/'/g, "\\'");
}

module.exports = { getOrgMetadataContext };
