/**
 * mcp/schema_inspector.js
 * Salesforce schema introspection via direct REST API calls.
 *
 * Previously used the Salesforce hosted MCP server via Anthropic's API,
 * but that integration has a known auth bug on Anthropic's side (open issue:
 * anthropics/claude-ai-mcp#171, #184). Switched to direct REST API calls
 * which are faster and more reliable.
 *
 * When Anthropic fixes the MCP connector for Salesforce, the MCP path
 * can be restored — the interface (describe, describeGlobal, toEngineSchema)
 * is unchanged.
 *
 * REST endpoints used:
 *   GET /services/data/v62.0/sobjects/{object}/describe/
 *   GET /services/data/v62.0/sobjects/
 */

'use strict';

const axios = require('axios');

const SF_API_VERSION = 'v62.0';

class SchemaInspector {
  constructor(mcpService) {
    this.svc = mcpService;
  }

  /**
   * Build an axios instance for the Salesforce REST API.
   * Uses the access token and instance URL from the MCPService config.
   */
  _sfClient() {
    // sfAccessToken may be "instanceUrl||accessToken" for multi-org or just the token
    const token = this.svc.sfAccessToken;
    const instanceUrl = this.svc.sfInstanceUrl || `https://login.salesforce.com`;

    return axios.create({
      baseURL: `${instanceUrl}/services/data/${SF_API_VERSION}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
  }

  /**
   * Describe one or more Salesforce objects via REST API.
   *
   * @param {string[]} objectNames  — Salesforce object API names
   * @returns {Promise<object>}     — Normalized schema map keyed by object name
   */
  async describe(objectNames) {
    if (!objectNames || objectNames.length === 0) {
      return { objects: {} };
    }

    const client = this._sfClient();
    const objects = {};

    await Promise.all(
      objectNames.map(async (objName) => {
        try {
          const { data } = await client.get(`/sobjects/${objName}/describe/`);

          objects[objName] = {
            exists: true,
            label: data.label,
            labelPlural: data.labelPlural,
            keyPrefix: data.keyPrefix,
            queryable: data.queryable,
            updateable: data.updateable,
            createable: data.createable,
            fields: (data.fields || []).map((f) => ({
              name: f.name,
              label: f.label,
              type: f.type,
              length: f.length,
              nillable: f.nillable,
              updateable: f.updateable,
              createable: f.createable,
              referenceTo: f.referenceTo || [],
              picklistValues: (f.picklistValues || []).map((pv) => ({
                value: pv.value,
                label: pv.label,
                active: pv.active,
              })),
              unique: f.unique,
              externalId: f.externalId,
              defaultValue: f.defaultValue,
              calculated: f.calculated, // formula fields
              autoNumber: f.autoNumber,
            })),
            childRelationships: (data.childRelationships || []).map((cr) => ({
              childSObject: cr.childSObject,
              field: cr.field,
              relationshipName: cr.relationshipName,
              cascadeDelete: cr.cascadeDelete,
            })),
          };
        } catch (err) {
          if (err.response?.status === 404 || err.response?.status === 400) {
            objects[objName] = {
              exists: false,
              fields: [],
              childRelationships: [],
            };
          } else {
            throw new Error(
              `Schema describe failed for ${objName}: ${err.response?.data?.[0]?.message || err.message}`
            );
          }
        }
      })
    );

    return { objects };
  }

  /**
   * List all queryable objects in the org (global describe).
   *
   * @returns {Promise<object>}  — { objects: [{ name, label, queryable, custom }] }
   */
  async describeGlobal() {
    const client = this._sfClient();
    const { data } = await client.get('/sobjects/');

    return {
      objects: (data.sobjects || []).map((s) => ({
        name: s.name,
        label: s.label,
        queryable: s.queryable,
        custom: s.custom,
        keyPrefix: s.keyPrefix,
      })),
    };
  }

  /**
   * Extract only the lookup/master-detail relationship fields from a describe result.
   */
  extractRelationships(schemaResult) {
    const relationships = {};
    const objects = schemaResult?.objects || {};

    for (const [objName, objSchema] of Object.entries(objects)) {
      if (!objSchema.exists) continue;

      const refFields = (objSchema.fields || [])
        .filter((f) => f.type === 'reference' && f.referenceTo?.length > 0)
        .map((f) => ({
          fieldName: f.name,
          referenceTo: f.referenceTo,
          type: 'lookup',
        }));

      relationships[objName] = refFields;
    }

    return relationships;
  }

  /**
   * Convert a describe() result into the format expected by engine/graph.py.
   */
  toEngineSchema(schemaResult) {
    const engineSchema = {};
    const objects = schemaResult?.objects || {};

    for (const [objName, objSchema] of Object.entries(objects)) {
      if (!objSchema.exists) continue;

      engineSchema[objName] = {
        fields: (objSchema.fields || []).map((f) => ({
          name: f.name,
          type: f.type,
          referenceTo: f.referenceTo || [],
        })),
      };
    }

    return engineSchema;
  }
}

module.exports = SchemaInspector;
