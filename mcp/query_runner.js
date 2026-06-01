/**
 * mcp/query_runner.js
 * SOQL execution and post-migration validation via Claude + Salesforce MCP.
 *
 * Used in two contexts:
 *
 * 1. PRE-MIGRATION — Quick counts and data quality checks before bulk extraction.
 *    "How many Contacts don't have an AccountId? That'll cause FK failures."
 *
 * 2. POST-MIGRATION — Count comparison between source and target to verify completeness.
 *    "Source: 42,800 Accounts. Target: 42,800 Accounts. ✓"
 *    "Source: 18,200 Contacts. Target: 18,107 Contacts. 93 missing — check error log."
 *
 * Governor limit awareness:
 *   - Every SOQL call here counts toward the 101 SOQL per-transaction limit
 *   - For large orgs, prefer COUNT() queries over fetching records
 *   - Avoid SELECT * patterns — always specify needed fields
 *   - For record counts > 50K, use Bulk API (not handled here — that's engine's job)
 */

'use strict';

const SYSTEM_PROMPT = `You are OrgIQ's Salesforce SOQL query runner.

You have access to the Salesforce MCP tools. Use them to execute SOQL queries
and return structured results.

Rules:
- Always use the salesforce MCP query tool to execute SOQL
- For COUNT queries, return the count as an integer
- For record queries, return records as an array
- Never return more than 200 records in a single response (use LIMIT)
- If a query fails, return the Salesforce error code and message

Return ONLY a JSON code block.`;

const COUNT_SYSTEM = `You are OrgIQ's migration record counter.

Use the Salesforce MCP query tool to run COUNT() queries for each object requested.
Return ONLY a JSON code block:
\`\`\`json
{
  "counts": {
    "Account": 42800,
    "Contact": 18200,
    "Opportunity": 31500
  },
  "queriedAt": "2025-05-14T10:30:00Z"
}
\`\`\``;

class QueryRunner {
  constructor(mcpService) {
    this.svc = mcpService;
  }

  /**
   * Execute a SOQL query on the connected org.
   *
   * @param {string} soql — SOQL query string
   * @returns {Promise<object>} — { totalSize: int, done: bool, records: [...] }
   */
  async run(soql) {
    const QUERY_SYSTEM = `You are OrgIQ's Salesforce SOQL query runner.
Use the Salesforce MCP tools to execute the given SOQL query and return the result.
Return ONLY a JSON code block:
\`\`\`json
{
  "totalSize": 5,
  "done": true,
  "records": [
    { "Id": "001...", "Name": "Acme Corp" }
  ]
}
\`\`\``;

    const response = await this.svc.callClaude(
      QUERY_SYSTEM,
      `Execute this SOQL query on the connected org: ${soql}`,
      { maxTokens: 4096 }
    );

    return this.svc.extractJSON(response);
  }

  /**
   * Get record counts for a list of objects.
   * Runs COUNT() queries via MCP — much faster than fetching records.
   *
   * @param {string[]} objectNames
   * @returns {Promise<object>} — { counts: { Account: 42800, ... }, queriedAt: ISO string }
   */
  async getRecordCounts(objectNames) {
    if (!objectNames || objectNames.length === 0) {
      return { counts: {}, queriedAt: new Date().toISOString() };
    }

    const objectList = objectNames.join(', ');

    const response = await this.svc.callClaude(
      COUNT_SYSTEM,
      `Run SELECT COUNT() FROM {Object} queries for these objects: ${objectList}
Run a separate COUNT() query for each object and return all counts in one JSON block.
Use the Salesforce MCP query tool for each query.`,
      { maxTokens: 2048 }
    );

    return this.svc.extractJSON(response);
  }

  /**
   * Post-migration count comparison: compare source and target record counts.
   * Returns a diff report showing any discrepancies.
   *
   * @param {object} sourceCounts  — { Account: 42800, Contact: 18200 }
   * @param {object} targetCounts  — { Account: 42800, Contact: 18107 }
   * @returns {object}             — diff report with success/discrepancy per object
   */
  buildCountDiff(sourceCounts, targetCounts) {
    const report = {
      passed: [],
      discrepancies: [],
      summary: { totalObjects: 0, matched: 0, mismatched: 0 },
    };

    const allObjects = new Set([
      ...Object.keys(sourceCounts),
      ...Object.keys(targetCounts),
    ]);

    for (const obj of allObjects) {
      report.summary.totalObjects++;
      const sourceCount = sourceCounts[obj] ?? 0;
      const targetCount = targetCounts[obj] ?? 0;
      const diff        = targetCount - sourceCount;
      const pctDiff     = sourceCount > 0
        ? ((diff / sourceCount) * 100).toFixed(2)
        : null;

      const entry = {
        object: obj,
        sourceCount,
        targetCount,
        diff,
        pctDiff,
      };

      if (diff === 0) {
        report.passed.push(entry);
        report.summary.matched++;
      } else {
        report.discrepancies.push({
          ...entry,
          severity: Math.abs(diff) / sourceCount > 0.01 ? 'error' : 'warning',
          message: diff < 0
            ? `${Math.abs(diff)} records missing on target`
            : `${diff} extra records on target (unexpected)`,
        });
        report.summary.mismatched++;
      }
    }

    report.overallPass = report.summary.mismatched === 0;
    return report;
  }

  /**
   * Run a set of data-quality pre-checks before migration starts.
   * Returns issues that would cause FK failures or blank required fields.
   *
   * @param {string[]} objectNames  — objects in migration scope
   * @returns {Promise<object>}     — { checks: [{ name, passed, detail }] }
   */
  async runPreFlightDataChecks(objectNames) {
    const PREFLIGHT_SYSTEM = `You are OrgIQ's migration data quality analyst.

Use the Salesforce MCP query tool to run data quality checks on the source org.
For each object in scope, check:
1. Records with null required lookup fields (e.g. Contact without AccountId)
2. Duplicate external IDs or unique fields that would fail on upsert
3. Records with invalid picklist values (not in the field's defined values)

Return ONLY a JSON code block:
\`\`\`json
{
  "checks": [
    {
      "name": "Contacts with null AccountId",
      "object": "Contact",
      "soql": "SELECT COUNT() FROM Contact WHERE AccountId = null",
      "count": 234,
      "severity": "warning",
      "message": "234 Contacts have no AccountId. These will migrate but be orphaned in target.",
      "action": "Review these records or set a default AccountId in your mapping."
    }
  ],
  "overallPass": true
}
\`\`\``;

    const response = await this.svc.callClaude(
      PREFLIGHT_SYSTEM,
      `Run data quality pre-flight checks on these objects: ${objectNames.join(', ')}
Focus on null lookup fields, duplicate unique values, and orphaned records.
Use the Salesforce MCP query tool for each check.`,
      { maxTokens: 6144 }
    );

    return this.svc.extractJSON(response);
  }
}

module.exports = QueryRunner;
