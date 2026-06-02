'use strict';

/**
 * preflightValidator.js
 *
 * Pure local checks — no API calls. Runs before every deploy attempt.
 * Returns a list of issues, each with severity (error | warning) and
 * an optional deterministic repair.
 */

// ── Validators ────────────────────────────────────────────────────────────────

function validateApiName(apiName, artifactType) {
  const issues = [];

  if (!apiName) {
    issues.push({ severity: 'error', code: 'MISSING_API_NAME', message: 'API name is required.' });
    return issues;
  }

  if (apiName.length > 40) {
    issues.push({
      severity: 'error',
      code:     'API_NAME_TOO_LONG',
      message:  `API name "${apiName}" is ${apiName.length} chars — max is 40.`,
      fix:      () => apiName.slice(0, 40),
    });
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(apiName.replace(/^[^.]+\./, ''))) {
    issues.push({
      severity: 'error',
      code:     'INVALID_API_NAME_CHARS',
      message:  `API name "${apiName}" contains invalid characters. Only letters, numbers, underscores, starting with a letter.`,
    });
  }

  if (artifactType === 'validationRule' && !apiName.includes('.')) {
    issues.push({
      severity: 'error',
      code:     'VALIDATION_RULE_MISSING_OBJECT',
      message:  `Validation rule API name must include the object: "Account.${apiName}"`,
      fix:      () => `Account.${apiName}`,
    });
  }

  return issues;
}

function validateXmlStructure(xml, artifactType) {
  const issues = [];

  if (!xml) {
    issues.push({ severity: 'error', code: 'EMPTY_XML', message: 'No XML was generated.' });
    return issues;
  }

  if (!xml.trim().startsWith('<?xml')) {
    issues.push({
      severity: 'warning',
      code:     'MISSING_XML_DECLARATION',
      message:  'XML declaration missing.',
      fix:      () => `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`,
    });
  }

  // Check for unmatched tags (basic)
  const openTags  = (xml.match(/<[a-zA-Z][^/!>]*>/g) || []).length;
  const closeTags = (xml.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
  const selfClose = (xml.match(/<[^>]+\/>/g) || []).length;
  if (Math.abs(openTags - closeTags - selfClose) > 2) {
    issues.push({ severity: 'warning', code: 'UNBALANCED_TAGS', message: 'XML may have unbalanced tags.' });
  }

  // Check for placeholder values
  const placeholders = xml.match(/YOUR_[A-Z_]+|PLACEHOLDER|TODO:|<your/gi);
  if (placeholders) {
    issues.push({
      severity: 'error',
      code:     'PLACEHOLDER_VALUES',
      message:  `XML contains placeholder values: ${[...new Set(placeholders)].join(', ')}`,
    });
  }

  // Artifact-specific checks
  if (artifactType === 'flow') {
    if (!xml.includes('<processType>')) {
      issues.push({ severity: 'error', code: 'FLOW_MISSING_PROCESS_TYPE', message: 'Flow is missing <processType>.' });
    }
    if (!xml.includes('<status>Draft</status>') && !xml.includes('<status>Active</status>')) {
      issues.push({ severity: 'error', code: 'FLOW_MISSING_STATUS', message: 'Flow is missing <status>.' });
    }
    if (xml.includes('<status>Active</status>')) {
      issues.push({
        severity: 'warning',
        code:     'FLOW_DEPLOYING_ACTIVE',
        message:  'Flow status is Active — it will fire immediately on deploy. Consider deploying as Draft first.',
        fix:      (x) => x.replace('<status>Active</status>', '<status>Draft</status>'),
      });
    }
    if (!xml.includes('<apiVersion>')) {
      issues.push({ severity: 'error', code: 'FLOW_MISSING_API_VERSION', message: 'Flow is missing <apiVersion>.' });
    }
    // Check for DML elements without fault connectors
    const dmlElements = xml.match(/<recordCreates>|<recordUpdates>|<recordDeletes>/g) || [];
    const faultConnectors = xml.match(/<faultConnector>/g) || [];
    if (dmlElements.length > faultConnectors.length) {
      issues.push({
        severity: 'warning',
        code:     'FLOW_MISSING_FAULT_PATHS',
        message:  `${dmlElements.length} DML element(s) found but only ${faultConnectors.length} fault connector(s). Every DML should have a fault path.`,
      });
    }
    // Check for loops with DML inside (bulkification)
    if (xml.includes('<loops>') && (xml.includes('<recordCreates>') || xml.includes('<recordUpdates>'))) {
      issues.push({
        severity: 'warning',
        code:     'FLOW_POSSIBLE_DML_IN_LOOP',
        message:  'Flow has both loops and DML elements — verify DML is NOT inside the loop to avoid governor limit failures.',
      });
    }
  }

  if (artifactType === 'validationRule') {
    if (!xml.includes('<errorConditionFormula>')) {
      issues.push({ severity: 'error', code: 'VR_MISSING_FORMULA', message: 'Validation rule is missing <errorConditionFormula>.' });
    }
    if (!xml.includes('<errorMessage>')) {
      issues.push({ severity: 'error', code: 'VR_MISSING_ERROR_MESSAGE', message: 'Validation rule is missing <errorMessage>.' });
    }
    const desc = xml.match(/<description>([^<]+)<\/description>/)?.[1];
    if (desc && desc.length > 255) {
      issues.push({
        severity: 'error',
        code:     'VR_DESCRIPTION_TOO_LONG',
        message:  `Description is ${desc.length} chars — max is 255.`,
        fix:      (x) => x.replace(/<description>[^<]+<\/description>/, `<description>${desc.slice(0, 252)}...</description>`),
      });
    }
    if (xml.includes('/*') || xml.includes('*/')) {
      issues.push({
        severity: 'error',
        code:     'VR_FORMULA_HAS_COMMENTS',
        message:  'Validation rule formula contains /* */ comments — Salesforce will reject these.',
        fix:      (x) => x.replace(/\/\*[\s\S]*?\*\//g, ''),
      });
    }
    // Check for unescaped < > & in formula
    const formulaMatch = xml.match(/<errorConditionFormula>([\s\S]*?)<\/errorConditionFormula>/);
    if (formulaMatch) {
      const formula = formulaMatch[1];
      if (formula.includes('<') && !formula.includes('&lt;')) {
        issues.push({
          severity: 'error',
          code:     'VR_UNESCAPED_XML',
          message:  'Validation rule formula contains unescaped < characters. Use &lt; instead.',
          fix:      (x) => x.replace(/<errorConditionFormula>([\s\S]*?)<\/errorConditionFormula>/,
            (_, f) => `<errorConditionFormula>${f.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&amp;/g, '&amp;').replace(/&/g, '&amp;')}</errorConditionFormula>`
          ),
        });
      }
    }
  }

  if (artifactType === 'report') {
    if (!xml.includes('<reportType>')) {
      issues.push({ severity: 'error', code: 'REPORT_MISSING_TYPE', message: 'Report is missing <reportType>.' });
    }
    if (!xml.includes('<format>')) {
      issues.push({ severity: 'error', code: 'REPORT_MISSING_FORMAT', message: 'Report is missing <format>.' });
    }
  }

  if (artifactType === 'apex') {
    if (!xml.includes('@isTest') && !xml.includes('class ') && !xml.includes('trigger ')) {
      issues.push({ severity: 'warning', code: 'APEX_NO_TEST_CLASS', message: 'No test class was generated. Apex requires 75% test coverage to deploy to production.' });
    }
  }

  return issues;
}

function validateFieldNames(xml, orgSchema) {
  const issues = [];
  if (!orgSchema || Object.keys(orgSchema).length === 0) return issues;

  // Extract field references from the XML
  const fieldRefs = xml.match(/\{!\$Record\.([a-zA-Z0-9_]+)\}/g) || [];
  const inputFields = xml.match(/<field>([^<]+)<\/field>/g) || [];

  for (const ref of fieldRefs) {
    const fieldName = ref.replace('{!$Record.', '').replace('}', '');
    const objectName = Object.keys(orgSchema)[0]; // best guess — first object in schema
    const schemaObj = orgSchema[objectName];
    if (schemaObj?.fields) {
      const exists = schemaObj.fields.some(f => f.apiName === fieldName);
      if (!exists) {
        issues.push({
          severity: 'warning',
          code:     'FIELD_NOT_IN_SCHEMA',
          message:  `Field "${fieldName}" referenced in the artifact was not found in the org schema for ${objectName}. Verify it exists.`,
        });
      }
    }
  }

  return issues;
}

/**
 * Run all preflight checks. Returns issues array and auto-repaired XML.
 */
function runPreflight(xml, artifactType, apiName, orgSchema = {}) {
  const allIssues = [
    ...validateApiName(apiName, artifactType),
    ...validateXmlStructure(xml, artifactType),
    ...validateFieldNames(xml, orgSchema),
  ];

  // Apply all deterministic fixes
  let repairedXml = xml;
  let repairedApiName = apiName;
  const appliedFixes = [];

  for (const issue of allIssues) {
    if (issue.fix) {
      const before = repairedXml;
      try {
        if (issue.code === 'MISSING_API_NAME' || issue.code === 'API_NAME_TOO_LONG' || issue.code === 'VALIDATION_RULE_MISSING_OBJECT') {
          repairedApiName = issue.fix();
        } else {
          repairedXml = issue.fix(repairedXml) || repairedXml;
        }
        if (repairedXml !== before || repairedApiName !== apiName) {
          appliedFixes.push(issue.code);
        }
      } catch (e) {
        // Fix failed — leave as-is
      }
    }
  }

  const errors   = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');

  return {
    passed:        errors.length === 0,
    issues:        allIssues,
    errors,
    warnings,
    repairedXml,
    repairedApiName,
    appliedFixes,
  };
}

module.exports = { runPreflight, validateApiName, validateXmlStructure };
