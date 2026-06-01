/**
 * mcp/doc_generator.js
 * AI-powered documentation generation via Claude + Salesforce MCP.
 *
 * Takes a live Salesforce org and produces plain-English documentation:
 *   - Object-level summaries ("What is this object used for?")
 *   - Field inventories with business-language labels
 *   - Relationship maps ("Opportunity looks up to Account, owned by User")
 *   - Migration-specific callouts ("⚠ This object has 14 required fields")
 *   - Custom field inventory with descriptions
 *
 * Target user: a Salesforce admin who needs to hand a migration spec to a
 * stakeholder who has never seen the Salesforce UI. Should read like a
 * business analyst wrote it, not a developer.
 *
 * This is a Module 3 feature (Documentation Generator) — separate from the
 * core migration engine. The same MCP service powers it.
 */

'use strict';

const SYSTEM_PROMPT = `You are OrgIQ's Salesforce documentation specialist.

You have access to the Salesforce MCP tools. Use them to inspect the connected
org's schema and produce clear, business-friendly documentation.

Your audience is a Salesforce admin or stakeholder who understands the business
but may not know every field name or API name. Write in plain English.

Documentation should include for each object:
1. What this object is used for (business purpose, 2-3 sentences)
2. Key standard fields and what they store
3. Custom fields (those ending in __c or __r) and their likely purpose
4. Relationships to other objects
5. Migration considerations (required fields, lookup dependencies, volume estimate)

Format your output per the JSON schema specified.`;

class DocGenerator {
  constructor(mcpService) {
    this.svc = mcpService;
  }

  /**
   * Generate documentation for a list of Salesforce objects.
   *
   * @param {string[]} objectNames
   * @returns {Promise<object>} — { docs: { Account: { summary, fields, relationships, migrationNotes } } }
   */
  async generate(objectNames) {
    if (!objectNames || objectNames.length === 0) {
      return { docs: {} };
    }

    const objectList = objectNames.join(', ');

    const userMessage = `Please document the following Salesforce objects from the connected org: ${objectList}

For each object:
1. Use the Salesforce MCP describe tools to get the full schema
2. Write a plain-English business description
3. List key fields (both standard and custom) with their purpose
4. Document all lookup/master-detail relationships
5. Identify migration considerations (required fields, self-referential lookups, large volumes)

Return ONLY a JSON code block:
\`\`\`json
{
  "generatedAt": "2025-05-14T10:30:00Z",
  "orgId": "00D...",
  "docs": {
    "Account": {
      "label": "Account",
      "apiName": "Account",
      "summary": "Accounts represent companies or individuals your organization does business with. They are the central object in Salesforce CRM, linking Contacts, Opportunities, Cases, and most other records.",
      "keyFields": [
        {
          "apiName": "Name",
          "label": "Account Name",
          "type": "string",
          "required": true,
          "description": "The legal or trading name of the company"
        }
      ],
      "customFields": [
        {
          "apiName": "Annual_Revenue_Override__c",
          "label": "Annual Revenue Override",
          "type": "currency",
          "description": "Custom field likely used to override the standard Annual Revenue field from a data import"
        }
      ],
      "relationships": [
        {
          "type": "parent",
          "relatedObject": "Account",
          "field": "ParentId",
          "label": "Parent Account",
          "description": "Self-referential lookup — allows Account hierarchy (subsidiaries)"
        },
        {
          "type": "child",
          "relatedObject": "Contact",
          "field": "AccountId",
          "label": "Contacts",
          "description": "Contacts associated with this Account"
        }
      ],
      "migrationNotes": [
        {
          "severity": "warning",
          "note": "Account has a self-referential ParentId field. These must be migrated in two passes: first without ParentId, then update ParentId after all Accounts exist on the target."
        },
        {
          "severity": "info",
          "note": "Name is required. Ensure all source Account records have a non-null Name."
        }
      ]
    }
  }
}
\`\`\``;

    const response = await this.svc.callClaude(SYSTEM_PROMPT, userMessage, {
      maxTokens: 16384,
    });

    return this.svc.extractJSON(response);
  }

  /**
   * Generate a human-readable migration specification document.
   * Used to produce the pre-migration sign-off document.
   *
   * @param {object} schemaResult     — from SchemaInspector.describe()
   * @param {object} validationResult — from Validator.validateMapping()
   * @param {object} countResult      — from QueryRunner.getRecordCounts()
   * @returns {Promise<object>}       — { markdown: string, title: string }
   */
  async generateMigrationSpec(schemaResult, validationResult, countResult) {
    const SPEC_SYSTEM = `You are OrgIQ's technical writer. Generate a clear migration specification
document in Markdown format. It should be suitable for a stakeholder sign-off
before a production Salesforce migration runs.

Include:
- Executive summary (what is being migrated, why)
- Object inventory with record counts
- Validation summary (errors and warnings)
- Field mapping highlights
- Known risks and mitigations
- Pre-migration checklist

Return ONLY a JSON code block:
\`\`\`json
{
  "title": "Migration Specification: [Source Org] → [Target Org]",
  "markdown": "# Migration Specification\\n\\n## Executive Summary\\n..."
}
\`\`\``;

    const contextPayload = JSON.stringify({
      schema: schemaResult,
      validation: validationResult,
      recordCounts: countResult,
    }, null, 2);

    const response = await this.svc.callClaude(
      SPEC_SYSTEM,
      `Generate a migration specification document based on this pre-flight data:\n\n${contextPayload}`,
      { maxTokens: 8192 }
    );

    return this.svc.extractJSON(response);
  }

  /**
   * Generate a post-migration summary report.
   *
   * @param {object} migrationResult  — final record counts from the engine
   * @param {object} countDiffReport  — from QueryRunner.buildCountDiff()
   * @param {object[]} errors         — error entries from engine stdout
   * @returns {Promise<object>}       — { markdown: string, passRate: number }
   */
  async generateMigrationReport(migrationResult, countDiffReport, errors = []) {
    const REPORT_SYSTEM = `You are OrgIQ's migration report writer.
Generate a post-migration summary report suitable for a Salesforce admin to
review and share with their team.

Be specific about what succeeded and what needs attention.
Return ONLY a JSON code block:
\`\`\`json
{
  "title": "Migration Report — [date]",
  "passRate": 99.8,
  "status": "completed_with_warnings",
  "markdown": "# Migration Report\\n\\n## Summary\\n..."
}
\`\`\`

Status values: "success", "completed_with_warnings", "completed_with_errors", "failed"`;

    const contextPayload = JSON.stringify({
      migrationResult,
      countDiff: countDiffReport,
      topErrors: errors.slice(0, 50),
      totalErrors: errors.length,
    }, null, 2);

    const response = await this.svc.callClaude(
      REPORT_SYSTEM,
      `Generate a post-migration report based on these results:\n\n${contextPayload}`,
      { maxTokens: 8192 }
    );

    return this.svc.extractJSON(response);
  }
}

module.exports = DocGenerator;
