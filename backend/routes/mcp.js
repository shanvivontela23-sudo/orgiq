/**
 * backend/routes/mcp.js
 * REST endpoints for OrgIQ's MCP service layer.
 *
 * All routes require { orgId } to identify which connected org to use.
 * The route handler fetches the org's MCP server URL + access token from
 * Supabase (connected_orgs table), then instantiates MCPService.
 *
 * Endpoints:
 *   POST /api/mcp/schema       — Describe Salesforce objects
 *   POST /api/mcp/validate     — Validate a field mapping config
 *   POST /api/mcp/query        — Run a SOQL query
 *   POST /api/mcp/counts       — Get record counts for a list of objects
 *   POST /api/mcp/preflight    — Data quality pre-flight checks
 *   POST /api/mcp/docs         — Generate object documentation
 *   POST /api/mcp/spec         — Generate migration spec document
 *   GET  /api/mcp/connectivity — Check org connectivity via MCP
 *
 * NOTE: Salesforce MCP requires the org's connected app to have MCP enabled
 * in Salesforce Setup → Integrations → MCP Server. The org record in Supabase
 * must store both the SF access token AND the MCP server URL.
 *
 * connected_orgs table columns needed for MCP:
 *   - access_token      (existing)
 *   - instance_url      (existing)
 *   - mcp_server_url    (NEW — set during org connection if MCP is enabled)
 *   - mcp_enabled       (NEW — boolean)
 */

'use strict';

const express    = require('express');
const router     = express.Router();
const MCPService = require('../../mcp/index');
const supabase   = require('../lib/supabase');

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Resolve org credentials from the request and instantiate MCPService.
 * TODO: Replace stub with real Supabase lookup once connected_orgs is wired up.
 *
 * @param {string} orgId
 * @returns {MCPService}
 */
async function getMCPServiceForOrg(orgId) {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // If orgId is provided, look up real credentials from Supabase
  if (orgId && orgId !== 'dev-org-001') {
    const { data: org, error } = await supabase
      .from('connected_orgs')
      .select('access_token, instance_url')
      .eq('id', orgId)
      .single();

    if (error || !org) throw new Error(`Org ${orgId} not found: ${error?.message}`);

    return new MCPService({
      anthropicApiKey,
      sfMcpServerUrl: process.env.SF_MCP_SERVER_URL,
      sfAccessToken:  org.access_token,
      sfInstanceUrl:  org.instance_url,
    });
  }

  // Fall back to env stubs for local dev / connectivity check
  const sfAccessToken = process.env.SF_ACCESS_TOKEN_STUB;
  const sfInstanceUrl = process.env.SF_INSTANCE_URL;
  if (!sfAccessToken) throw new Error('SF_ACCESS_TOKEN_STUB not set');
  if (!sfInstanceUrl) throw new Error('SF_INSTANCE_URL not set');

  return new MCPService({
    anthropicApiKey,
    sfMcpServerUrl: process.env.SF_MCP_SERVER_URL,
    sfAccessToken,
    sfInstanceUrl,
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/mcp/connectivity
 * Check whether the org's MCP server is reachable.
 * Runs a simple SELECT from Organization to confirm access.
 */
router.get('/connectivity', async (req, res) => {
  try {
    const { orgId } = req.query;
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });

    const svc = await getMCPServiceForOrg(orgId);
    const result = await svc.validator.checkConnectivity();
    res.json(result);
  } catch (err) {
    console.error('[mcp/connectivity]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/schema
 * Describe one or more Salesforce objects.
 *
 * Body: { orgId: string, objects: string[] }
 * Returns: { objects: { Account: { fields, childRelationships, ... } } }
 */
router.post('/schema', async (req, res) => {
  try {
    const { orgId, objects } = req.body;

    if (!orgId)                   return res.status(400).json({ error: 'orgId is required' });
    if (!objects?.length)         return res.status(400).json({ error: 'objects array is required' });
    if (objects.length > 20)      return res.status(400).json({ error: 'Maximum 20 objects per request' });

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.inspectSchema(objects);
    res.json(result);
  } catch (err) {
    console.error('[mcp/schema]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/schema/global
 * List all objects in the org.
 *
 * Body: { orgId: string }
 * Returns: { objects: [{ name, label, queryable, custom }] }
 */
router.post('/schema/global', async (req, res) => {
  try {
    const { orgId } = req.body;
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.schemaInspector.describeGlobal();
    res.json(result);
  } catch (err) {
    console.error('[mcp/schema/global]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/validate
 * Validate a mapping config before migration starts.
 *
 * Body: { orgId: string, mappingConfig: object, objectsInScope: string[] }
 * Returns: { valid: bool, errorCount, warningCount, issues: [] }
 */
router.post('/validate', async (req, res) => {
  try {
    const { orgId, mappingConfig, objectsInScope = [] } = req.body;

    if (!orgId)         return res.status(400).json({ error: 'orgId is required' });
    if (!mappingConfig) return res.status(400).json({ error: 'mappingConfig is required' });

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.validateMapping(mappingConfig, objectsInScope);
    res.json(result);
  } catch (err) {
    console.error('[mcp/validate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/validate/objects
 * Confirm all objects in a migration scope exist and are queryable.
 *
 * Body: { orgId: string, objects: string[] }
 * Returns: { valid: bool, accessible: [], missing: [], notQueryable: [] }
 */
router.post('/validate/objects', async (req, res) => {
  try {
    const { orgId, objects } = req.body;

    if (!orgId)           return res.status(400).json({ error: 'orgId is required' });
    if (!objects?.length) return res.status(400).json({ error: 'objects array is required' });

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.validator.validateObjectScope(objects);
    res.json(result);
  } catch (err) {
    console.error('[mcp/validate/objects]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/query
 * Run an arbitrary SOQL query on the connected org.
 *
 * Body: { orgId: string, soql: string }
 * Returns: { totalSize: int, done: bool, records: [] }
 *
 * ⚠ Intended for validation checks and debugging — not bulk extraction.
 *   Max 200 records returned. For bulk data use the Python engine.
 */
router.post('/query', async (req, res) => {
  try {
    const { orgId, soql } = req.body;

    if (!orgId) return res.status(400).json({ error: 'orgId is required' });
    if (!soql)  return res.status(400).json({ error: 'soql is required' });

    // Basic guard — no DML through this endpoint
    const upperSOQL = soql.trim().toUpperCase();
    if (!upperSOQL.startsWith('SELECT')) {
      return res.status(400).json({ error: 'Only SELECT queries are allowed via this endpoint' });
    }

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.runQuery(soql);
    res.json(result);
  } catch (err) {
    console.error('[mcp/query]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/counts
 * Get record counts for a list of objects.
 *
 * Body: { orgId: string, objects: string[] }
 * Returns: { counts: { Account: 42800, Contact: 18200 }, queriedAt: ISO }
 */
router.post('/counts', async (req, res) => {
  try {
    const { orgId, objects } = req.body;

    if (!orgId)           return res.status(400).json({ error: 'orgId is required' });
    if (!objects?.length) return res.status(400).json({ error: 'objects array is required' });

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.getRecordCounts(objects);
    res.json(result);
  } catch (err) {
    console.error('[mcp/counts]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/preflight
 * Run data quality checks on source org before migration.
 *
 * Body: { orgId: string, objects: string[] }
 * Returns: { checks: [{ name, object, count, severity, message }], overallPass: bool }
 */
router.post('/preflight', async (req, res) => {
  try {
    const { orgId, objects } = req.body;

    if (!orgId)           return res.status(400).json({ error: 'orgId is required' });
    if (!objects?.length) return res.status(400).json({ error: 'objects array is required' });

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.queryRunner.runPreFlightDataChecks(objects);
    res.json(result);
  } catch (err) {
    console.error('[mcp/preflight]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/docs
 * Generate plain-English documentation for a set of Salesforce objects.
 *
 * Body: { orgId: string, objects: string[] }
 * Returns: { docs: { Account: { summary, keyFields, customFields, relationships, migrationNotes } } }
 */
router.post('/docs', async (req, res) => {
  try {
    const { orgId, objects } = req.body;

    if (!orgId)           return res.status(400).json({ error: 'orgId is required' });
    if (!objects?.length) return res.status(400).json({ error: 'objects array is required' });
    if (objects.length > 10) return res.status(400).json({ error: 'Maximum 10 objects per docs request' });

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.generateDocs(objects);
    res.json(result);
  } catch (err) {
    console.error('[mcp/docs]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mcp/spec
 * Generate a migration specification document (Markdown).
 * Combines schema + validation + count data into a stakeholder-ready doc.
 *
 * Body: { orgId, schemaResult, validationResult, countResult }
 * Returns: { title, markdown }
 */
router.post('/spec', async (req, res) => {
  try {
    const { orgId, schemaResult, validationResult, countResult } = req.body;

    if (!orgId)            return res.status(400).json({ error: 'orgId is required' });
    if (!schemaResult)     return res.status(400).json({ error: 'schemaResult is required' });
    if (!validationResult) return res.status(400).json({ error: 'validationResult is required' });
    if (!countResult)      return res.status(400).json({ error: 'countResult is required' });

    const svc    = await getMCPServiceForOrg(orgId);
    const result = await svc.docGenerator.generateMigrationSpec(
      schemaResult,
      validationResult,
      countResult
    );
    res.json(result);
  } catch (err) {
    console.error('[mcp/spec]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
