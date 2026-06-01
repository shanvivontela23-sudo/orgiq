/**
 * mcp/index.js
 * OrgIQ MCP Service — Claude + Salesforce native MCP Server
 *
 * This module is the single entry point for all AI-powered org intelligence.
 * It calls the Anthropic Messages API with the user's Salesforce MCP server
 * configured, letting Claude use Salesforce tools (query, describe, etc.)
 * directly against the live org — no extra OAuth plumbing required on our side.
 *
 * Architecture:
 *   Backend routes → MCPService → Anthropic API (with SF MCP server)
 *                                       ↓
 *                              Salesforce MCP Server
 *                              (configured in SF Setup)
 *                                       ↓
 *                              Live Salesforce Org
 *
 * Anthropic MCP client beta header: anthropic-beta: mcp-client-2025-04-04
 *
 * Salesforce MCP server URL pattern (confirmed from SF Setup → Integrations → MCP Servers):
 *   https://api.salesforce.com/platform/mcp/v1/platform/sobject-all   (all objects)
 *   https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads  (read-only)
 *   https://api.salesforce.com/platform/mcp/v1/platform/metadata-experts (metadata)
 * type: 'url' — these are HTTP (not SSE) endpoints
 */

'use strict';

const axios = require('axios');

const SchemaInspector = require('./schema_inspector');
const Validator = require('./validator');
const QueryRunner = require('./query_runner');
const DocGenerator = require('./doc_generator');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'mcp-client-2025-11-20';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

class MCPService {
  /**
   * @param {object} config
   * @param {string} config.anthropicApiKey    — Anthropic API key
   * @param {string} config.sfMcpServerUrl     — Salesforce MCP SSE endpoint URL
   *                                             e.g. https://myorg.my.salesforce.com/services/mcp/sse
   * @param {string} config.sfAccessToken      — Salesforce OAuth2 access token for the org
   * @param {string} config.sfInstanceUrl      — Salesforce instance URL (e.g. https://myorg.my.salesforce.com)
   * @param {string} [config.model]            — Claude model override
   */
  constructor({ anthropicApiKey, sfMcpServerUrl, sfAccessToken, sfInstanceUrl, model } = {}) {
    if (!anthropicApiKey) throw new Error('MCPService: anthropicApiKey is required');
    if (!sfAccessToken)   throw new Error('MCPService: sfAccessToken is required');
    if (!sfInstanceUrl)   throw new Error('MCPService: sfInstanceUrl is required');

    this.anthropicApiKey  = anthropicApiKey;
    this.sfMcpServerUrl   = sfMcpServerUrl; // kept for future use when Anthropic fixes SF MCP
    this.sfAccessToken    = sfAccessToken;
    this.sfInstanceUrl    = sfInstanceUrl;
    this.model            = model || DEFAULT_MODEL;

    this.schemaInspector = new SchemaInspector(this);
    this.validator       = new Validator(this);
    this.queryRunner     = new QueryRunner(this);
    this.docGenerator    = new DocGenerator(this);
  }

  /**
   * Low-level: Call the Anthropic Messages API.
   * Schema data is fetched via Salesforce REST API (schema_inspector.js) and
   * injected into the prompt — Claude performs AI analysis over it.
   *
   * NOTE: The Salesforce hosted MCP server transport has a known auth bug on
   * Anthropic's side (anthropics/claude-ai-mcp#171). When that is fixed,
   * re-attach mcp_servers here and remove the REST-based SchemaInspector.
   *
   * @param {string}   systemPrompt  — system instruction for this call
   * @param {string}   userMessage   — the user-turn prompt
   * @param {object}   [options]
   * @param {number}   [options.maxTokens=4096]
   * @param {object[]} [options.extraTools]  — additional tool definitions
   * @returns {Promise<object>} Anthropic response object
   */
  async callClaude(systemPrompt, userMessage, options = {}) {
    const { maxTokens = 4096, extraTools = [] } = options;

    const payload = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage },
      ],
    };

    if (extraTools.length > 0) {
      payload.tools = extraTools;
    }

    try {
      const response = await axios.post(ANTHROPIC_API_URL, payload, {
        headers: {
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        timeout: 120_000,
      });

      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const body   = err.response?.data;
      const msg    = body?.error?.message || err.message;
      throw new Error(`Anthropic API error (${status}): ${msg}`);
    }
  }

  /**
   * Extract the final text content from a Claude response.
   * Claude may make multiple MCP tool calls before producing a final text block.
   */
  extractText(claudeResponse) {
    const content = claudeResponse?.content || [];
    const textBlocks = content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n').trim();
  }

  /**
   * Extract and JSON-parse a structured result from Claude's response.
   * Claude is instructed to wrap JSON in ```json fences.
   */
  extractJSON(claudeResponse) {
    const text = this.extractText(claudeResponse);

    // Try ```json ... ``` fence first
    const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      return JSON.parse(fenceMatch[1].trim());
    }

    // Fallback: try to parse the entire text as JSON
    return JSON.parse(text);
  }

  // ─── Convenience delegates ─────────────────────────────────────────────────

  /**
   * Introspect schema for one or more Salesforce objects via MCP.
   * @param {string[]} objectNames  — e.g. ['Account', 'Contact', 'Opportunity']
   * @returns {Promise<object>}     — { objects: { Account: { fields: [...], ... }, ... } }
   */
  async inspectSchema(objectNames) {
    return this.schemaInspector.describe(objectNames);
  }

  /**
   * Validate a field mapping config against source + target org schemas.
   * @param {object} mappingConfig  — the user's mapping JSON
   * @param {string[]} objects      — object API names in scope
   * @returns {Promise<object>}     — { valid: bool, errors: [], warnings: [] }
   */
  async validateMapping(mappingConfig, objects) {
    return this.validator.validateMapping(mappingConfig, objects);
  }

  /**
   * Run a SOQL query on the connected org via MCP.
   * @param {string} soql  — SOQL string
   * @returns {Promise<object>}  — { totalSize: int, records: [...] }
   */
  async runQuery(soql) {
    return this.queryRunner.run(soql);
  }

  /**
   * Get record counts for a set of objects (pre or post migration check).
   * @param {string[]} objectNames
   * @returns {Promise<object>}  — { Account: 42800, Contact: 18200, ... }
   */
  async getRecordCounts(objectNames) {
    return this.queryRunner.getRecordCounts(objectNames);
  }

  /**
   * Generate plain-English documentation for a set of objects.
   * @param {string[]} objectNames
   * @returns {Promise<object>}  — { docs: { Account: "...", Contact: "..." } }
   */
  async generateDocs(objectNames) {
    return this.docGenerator.generate(objectNames);
  }
}

module.exports = MCPService;
