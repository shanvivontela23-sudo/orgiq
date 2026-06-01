/**
 * mcp/validator.js
 * Pre-flight mapping validation via Claude + Salesforce MCP.
 *
 * Runs before the Python engine starts bulk extraction. Catches issues that
 * would cause silent failures or 4am support tickets:
 *
 *   - Source fields that don't exist on the source object
 *   - Target fields that don't exist on the target object
 *   - Type mismatches (e.g. mapping a Picklist → Text — valid but flagged)
 *   - Required fields on target that have no mapping
 *   - Lookup fields where the referenced object isn't in migration scope
 *   - Formula / autonumber / system fields that can't be written
 *
 * Claude uses MCP describe tools on BOTH source and target orgs in a single
 * conversation, making it easy to produce a cross-org diff.
 *
 * Governor limit note: describe calls don't count against SOQL 101 limit.
 */

'use strict';

const SYSTEM_PROMPT = `You are OrgIQ's migration pre-flight validator.

You have access to the Salesforce MCP tools connected to the source and target orgs.
Your job is to validate a field mapping configuration and return a structured
validation report as JSON.

Validation checks to perform:
1. SOURCE_FIELD_MISSING    — source field does not exist on the source object
2. TARGET_FIELD_MISSING    — target field does not exist on the target object
3. NOT_CREATEABLE          — target field is not createable (formula, autonumber, system)
4. TYPE_MISMATCH           — source and target field types differ (warning, not error)
5. PICKLIST_MISMATCH       — source picklist values not present on target (warning)
6. REQUIRED_UNMAPPED       — required target field has no incoming mapping (error)
7. LOOKUP_OUT_OF_SCOPE     — lookup target object is not in the migration object list
8. PII_FIELD_DETECTED      — field name pattern suggests PII (SSN, DOB, email, phone)

Severity levels:
- "error"   — will cause migration to fail or corrupt data; must be fixed
- "warning" — migration will proceed but data quality may be affected
- "info"    — informational, no action needed

Return ONLY a JSON code block:
\`\`\`json
{
  "valid": true,
  "errorCount": 0,
  "warningCount": 2,
  "issues": [
    {
      "severity": "warning",
      "code": "TYPE_MISMATCH",
      "object": "Contact",
      "sourceField": "LeadSource",
      "targetField": "Lead_Source__c",
      "message": "Source is Picklist, target is Text(255). Values will be copied as strings.",
      "action": "Verify target picklist values cover all source values, or change target field type."
    }
  ],
  "piiFields": ["Contact.Email", "Contact.Phone", "Contact.MobilePhone"],
  "summary": "2 warnings found. Migration can proceed but review type mismatches."
}
\`\`\``;

class Validator {
  constructor(mcpService) {
    this.svc = mcpService;
  }

  /**
   * Validate a mapping config against both source and target org schemas.
   *
   * @param {object}   mappingConfig          — user's mapping configuration
   * @param {object}   mappingConfig.objects  — array of { sourceObject, targetObject, fields: [{source, target}] }
   * @param {string[]} objectsInScope         — all object API names in this migration
   * @returns {Promise<object>}               — validation result with issues array
   */
  async validateMapping(mappingConfig, objectsInScope = []) {
    const mappingJSON = JSON.stringify(mappingConfig, null, 2);
    const scopeList   = objectsInScope.join(', ');

    const userMessage = `Please validate the following OrgIQ migration mapping configuration.

Objects in migration scope: ${scopeList || '(derived from mapping config)'}

Mapping configuration:
${mappingJSON}

Steps:
1. Use the Salesforce MCP describe tools to fetch schema for each source object and each target object
2. Check each mapped field against the field lists for its respective object
3. Flag any issues per the validation rules in your instructions
4. Return the full validation report as JSON`;

    const response = await this.svc.callClaude(SYSTEM_PROMPT, userMessage, {
      maxTokens: 8192,
    });

    return this.svc.extractJSON(response);
  }

  /**
   * Quick connectivity and API version check — confirms the MCP server is
   * responsive and the org is accessible before we start any real work.
   *
   * @returns {Promise<object>}  — { reachable: bool, apiVersion: string, orgId: string }
   */
  async checkConnectivity() {
    const CONN_SYSTEM = `You are checking basic Salesforce org connectivity via MCP.
Use the MCP tools to run a simple query: SELECT Id, Name FROM Organization LIMIT 1
Return ONLY a JSON code block:
\`\`\`json
{
  "reachable": true,
  "orgId": "00D...",
  "orgName": "My Org",
  "apiVersion": "v62.0",
  "instanceUrl": "https://myorg.my.salesforce.com"
}
\`\`\``;

    try {
      const response = await this.svc.callClaude(
        CONN_SYSTEM,
        'Run SELECT Id, Name, InstanceName, OrganizationType, ApiVersion FROM Organization LIMIT 1 and return the result as JSON.',
        { maxTokens: 1024 }
      );
      return this.svc.extractJSON(response);
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }

  /**
   * Check whether all objects in a migration scope exist and are accessible.
   * Catches typos in object API names before the engine starts.
   *
   * @param {string[]} objectNames
   * @returns {Promise<object>}  — { valid: bool, missing: [], accessible: [] }
   */
  async validateObjectScope(objectNames) {
    const OBJ_SYSTEM = `You are OrgIQ's migration pre-flight validator.
Use the Salesforce MCP global describe tool to check which objects exist and are queryable.
Return ONLY a JSON code block:
\`\`\`json
{
  "valid": true,
  "accessible": ["Account", "Contact"],
  "missing": [],
  "notQueryable": []
}
\`\`\``;

    const response = await this.svc.callClaude(
      OBJ_SYSTEM,
      `Check whether these Salesforce objects exist and are queryable in the connected org: ${objectNames.join(', ')}
Use the global describe or individual describe MCP tools to verify each object.`,
      { maxTokens: 2048 }
    );

    return this.svc.extractJSON(response);
  }
}

module.exports = Validator;
