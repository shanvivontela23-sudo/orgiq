'use strict';

/**
 * errorClassifier.js
 *
 * Every Salesforce deploy error maps to a known category.
 * Each category has:
 *   - a deterministic fix (or null if Claude must handle it)
 *   - a question to ask the user if we can't fix it automatically
 *   - a prompt rule to inject into the repair prompt
 */

const ERROR_PATTERNS = [
  // ── Field errors ────────────────────────────────────────────────────────────
  {
    category:    'MISSING_FIELD_OR_OBJECT',
    regex:       /No such column '([^']+)' on entity '([^']+)'/i,
    deterministic: false,
    rootCause:   (m) => `Field ${m[1]} does not exist or is not queryable on ${m[2]}.`,
    repairStrategy: () => 'Retrieve object describe/report metadata and ask the user to choose a valid replacement field.',
    question:    (m) => `Salesforce rejected field \`${m[1]}\` on \`${m[2]}\`. Should I remove it, or retrieve valid fields for ${m[2]} from the org?`,
    promptRule:  (m) => `Field ${m[1]} does not exist on ${m[2]}. Use only fields confirmed to exist in the org schema.`,
  },
  {
    category:    'MISSING_FIELD_OR_OBJECT',
    regex:       /field '([^']+)' does not exist/i,
    deterministic: false,
    rootCause:   (m) => `Field ${m[1]} does not exist in the selected org.`,
    repairStrategy: () => 'Ask for a replacement field or remove the field from the artifact.',
    question:    (m) => `Field \`${m[1]}\` doesn't exist in this org. Should I remove it or substitute a standard field?`,
    promptRule:  (m) => `Field ${m[1]} does not exist. Replace with a valid field or remove it.`,
  },

  // ── Report type errors ───────────────────────────────────────────────────────
  {
    category:    'MISSING_FIELD_OR_OBJECT',
    regex:       /invalid report type '([^']+)'/i,
    deterministic: false,
    rootCause:   (m) => `Report type ${m[1]} is not available in the target org.`,
    repairStrategy: () => 'Retrieve available report types and rebuild the report using a valid report type.',
    question:    (m) => `Report type \`${m[1]}\` is not valid in this org. Should I retrieve the available report types and pick the closest match?`,
    promptRule:  (m) => `Report type ${m[1]} is invalid. Use a report type that exists in the org.`,
  },
  {
    category:    'MISSING_FIELD_OR_OBJECT',
    regex:       /column '([^']+)' is not valid/i,
    deterministic: false,
    rootCause:   (m) => `Report column ${m[1]} is not valid for the selected report type.`,
    repairStrategy: () => 'Retrieve valid columns for the report type and ask/repair with a compatible column.',
    question:    (m) => `Report column \`${m[1]}\` was rejected by Salesforce. Should I retrieve valid columns for this report type and rebuild the column list?`,
    promptRule:  (m) => `Column ${m[1]} is not valid for this report type. Use only columns confirmed valid from org metadata.`,
  },

  // ── XML / structure errors ───────────────────────────────────────────────────
  {
    category:    'INVALID_XML',
    regex:       /element '([^']+)' is unexpected/i,
    deterministic: true,
    rootCause:   (m) => `XML element ${m[1]} is not valid in this metadata location.`,
    repairStrategy: (m) => `Remove <${m[1]}> and rerun dry run.`,
    fix:         (xml, m) => removeXmlElement(xml, m[1]),
    question:    (m) => `XML element \`${m[1]}\` is not allowed in this metadata type. I can remove it automatically — confirm?`,
    promptRule:  (m) => `XML element <${m[1]}> is not valid in this metadata. Do not include it.`,
  },
  {
    category:    'INVALID_XML',
    regex:       /unexpected element '([^']+)'/i,
    deterministic: true,
    rootCause:   (m) => `XML element ${m[1]} is unexpected for this metadata type.`,
    repairStrategy: (m) => `Remove <${m[1]}> and rerun dry run.`,
    fix:         (xml, m) => removeXmlElement(xml, m[1]),
    question:    (m) => `XML element \`${m[1]}\` is not allowed. Removing it automatically.`,
    promptRule:  (m) => `Do not include <${m[1]}> in the generated XML.`,
  },
  {
    category:    'FLOW_STRUCTURE_ERROR',
    regex:       /Element \{[^}]+}([a-zA-Z0-9_]+) invalid at this location in type ([a-zA-Z0-9_]+)/i,
    deterministic: true,
    rootCause:   (m) => `${m[2]} metadata does not allow <${m[1]}> at that location.`,
    repairStrategy: (m) => `Remove <${m[1]}> from ${m[2]} metadata and rerun dry run.`,
    fix:         (xml, m) => removeXmlElement(xml, m[1]),
    question:    (m) => `Salesforce rejected XML element \`${m[1]}\` for ${m[2]}. SF Copilot removed it automatically and will retry dry run.`,
    promptRule:  (m) => `Do not include <${m[1]}> in ${m[2]} metadata. Salesforce rejects it at that location.`,
  },
  {
    category:    'INVALID_XML',
    regex:       /Content is not allowed in prolog|XML parse error|invalid xml/i,
    deterministic: true,
    rootCause:   () => 'The XML is malformed or contains invalid leading/encoding characters.',
    repairStrategy: () => 'Clean invalid characters and ensure the XML declaration is valid.',
    fix:         (xml) => xml.replace(/^\s+/, '').replace(/[^\x09\x0A\x0D\x20-퟿-�]/g, ''),
    question:    () => `The XML has encoding issues. I can clean it automatically.`,
    promptRule:  () => `Ensure the XML starts with <?xml version="1.0" encoding="UTF-8"?> and contains no invalid characters.`,
  },

  // ── Name / length errors ─────────────────────────────────────────────────────
  {
    category:    'PLATFORM_CONSTRAINT',
    regex:       /name exceeds maximum length|API name.*too long|fullName.*too long/i,
    deterministic: true,
    rootCause:   () => 'Salesforce rejected the component name because it exceeds platform length limits.',
    repairStrategy: () => 'Shorten the API/fullName to fit Salesforce metadata limits.',
    fix:         (xml) => shortenApiName(xml),
    question:    () => `The API name is too long (Salesforce max is 40 chars). I'll shorten it automatically.`,
    promptRule:  () => `API names must be 40 characters or fewer. Shorten the fullName/label.`,
  },
  {
    category:    'PLATFORM_CONSTRAINT',
    regex:       /description.*too long|description exceeds/i,
    deterministic: true,
    rootCause:   () => 'Salesforce rejected a description that exceeds platform length limits.',
    repairStrategy: () => 'Truncate the description and rerun dry run.',
    fix:         (xml) => truncateDescription(xml, 255),
    question:    () => `Description exceeds 255 characters. Truncating automatically.`,
    promptRule:  () => `Descriptions must be 255 characters or fewer.`,
  },

  // ── Missing required metadata ────────────────────────────────────────────────
  {
    category:    'INVALID_XML',
    regex:       /required field is missing '([^']+)'/i,
    deterministic: false,
    rootCause:   (m) => `Required metadata field ${m[1]} is missing.`,
    repairStrategy: () => 'Regenerate or ask for the missing required value.',
    question:    (m) => `Required field \`${m[1]}\` is missing from the metadata. Can you provide a value for it?`,
    promptRule:  (m) => `Field ${m[1]} is required. It must be included in the generated metadata.`,
  },
  {
    category:    'MISSING_FOLDER',
    regex:       /folder '([^']+)' does not exist|report folder.*not found/i,
    deterministic: false,
    rootCause:   (m) => `Report folder ${m[1] || ''} does not exist or is inaccessible.`,
    repairStrategy: () => 'Retrieve report folders and require the user to pick a valid folder before generating report XML.',
    question:    (m) => `Report folder \`${m[1]}\` doesn't exist in the org. Should I use "Public Reports" or a different folder?`,
    promptRule:  (m) => `Folder ${m[1]} does not exist. Use an existing folder or "Public Reports".`,
  },

  // ── Flow errors ──────────────────────────────────────────────────────────────
  {
    category:    'FLOW_STRUCTURE_ERROR',
    regex:       /invalid reference to node '([^']+)'/i,
    deterministic: false,
    rootCause:   (m) => `Flow connector references missing element ${m[1]}.`,
    repairStrategy: () => 'Regenerate the flow graph or retrieve a simpler template before deploy.',
    question:    (m) => `Flow element \`${m[1]}\` is referenced but not defined. Should I regenerate the flow structure?`,
    promptRule:  (m) => `Every connector must reference a real element. Element ${m[1]} is missing.`,
  },
  {
    category:    'FLOW_STRUCTURE_ERROR',
    regex:       /DML.*no fault connector|fault path.*required/i,
    deterministic: false,
    rootCause:   () => 'A Flow DML element is missing fault handling.',
    repairStrategy: () => 'Add a fault connector or ask the user how faults should be handled.',
    question:    () => `A DML element is missing a fault path. Should I add a fault handler that logs or notifies on error?`,
    promptRule:  () => `Every DML element (Create/Update/Delete Records) must have a faultConnector. No exceptions.`,
  },

  // ── Apex errors ──────────────────────────────────────────────────────────────
  {
    category:    'PLATFORM_CONSTRAINT',
    regex:       /compile error at line (\d+) column (\d+): (.+)/i,
    deterministic: false,
    rootCause:   (m) => `Apex compile failed at line ${m[1]} column ${m[2]}.`,
    repairStrategy: (m) => `Repair Apex compile error: ${m[3]}`,
    question:    (m) => `Apex compile error at line ${m[1]}: "${m[3]}". I'll send this to Claude to fix.`,
    promptRule:  (m) => `Fix compile error at line ${m[1]} column ${m[2]}: ${m[3]}`,
  },
  {
    category:    'PLATFORM_CONSTRAINT',
    regex:       /code coverage.*below|insufficient test coverage/i,
    deterministic: false,
    rootCause:   () => 'Apex deployment does not meet Salesforce test coverage requirements.',
    repairStrategy: () => 'Add/repair tests and rerun deployment validation.',
    question:    () => `Apex test coverage is below 75%. Should I add more test cases to the test class?`,
    promptRule:  () => `Increase test coverage to at least 75%. Add more @isTest methods covering edge cases.`,
  },

  // ── Permission / license ─────────────────────────────────────────────────────
  {
    category:    'PERMISSION_OR_TOKEN',
    regex:       /insufficient privileges|permission.*denied|license.*required/i,
    deterministic: false,
    rootCause:   () => 'The connected Salesforce user lacks permission for this deploy action, or the org/license does not support it.',
    repairStrategy: () => 'Reconnect with an admin user or grant the required Salesforce permissions.',
    question:    () => `The connected org doesn't have permission to deploy this metadata type. Check the connected app permissions or org edition.`,
    promptRule:  () => `This org may not support this metadata type. Consider an alternative approach.`,
  },

  // ── Duplicate / conflict ─────────────────────────────────────────────────────
  {
    category:    'DUPLICATE_COMPONENT',
    regex:       /already exists|duplicate.*name|component.*exists/i,
    deterministic: false,
    rootCause:   (m, apiName) => `A component named ${apiName} already exists.`,
    repairStrategy: () => 'Ask whether to update the existing component or generate a new API name.',
    question:    (m, apiName) => `A component named \`${apiName}\` already exists in this org. Should I rename it (add _v2) or overwrite the existing one?`,
    promptRule:  () => `A component with this name already exists. Use a unique API name.`,
  },
];

/**
 * Classify a Salesforce deploy error message.
 * Returns the matching category entry, or an UNKNOWN entry.
 */
function classifyError(errorMessage, artifactType, apiName = '') {
  for (const pattern of ERROR_PATTERNS) {
    const match = errorMessage.match(pattern.regex);
    if (match) {
      const rootCause = typeof pattern.rootCause === 'function'
        ? pattern.rootCause(match, apiName, artifactType)
        : pattern.rootCause;
      const repairStrategy = typeof pattern.repairStrategy === 'function'
        ? pattern.repairStrategy(match, apiName, artifactType)
        : pattern.repairStrategy;
      return {
        category:      pattern.category,
        deterministic: pattern.deterministic,
        fix:           pattern.fix   ? (xml) => pattern.fix(xml, match) : null,
        question:      pattern.question(match, apiName),
        promptRule:    pattern.promptRule(match),
        rawError:      errorMessage,
        rootCause,
        repairStrategy,
        safeToAutoRepair: Boolean(pattern.deterministic && pattern.fix),
        confidence: pattern.deterministic && pattern.fix ? 0.9 : 0.68,
        match,
      };
    }
  }

  return {
    category:      'UNKNOWN',
    deterministic: false,
    fix:           null,
    question:      `Salesforce returned an unrecognized error: "${errorMessage}". I'll log this as a new failure pattern and ask Claude to repair it.`,
    promptRule:    `Fix this Salesforce deploy error: ${errorMessage}`,
    rawError:      errorMessage,
    rootCause:     'SF Copilot has not seen this Salesforce error pattern yet.',
    repairStrategy:'Store the failure pattern, ask Claude to repair, and convert the successful fix into a reusable memory.',
    safeToAutoRepair: false,
    confidence:    0.4,
    isNew:         true,
  };
}

/**
 * Classify all errors from a deploy result.
 */
function classifyDeployResult(deployResult, artifactType, apiName) {
  if (deployResult.success) return [];

  const errors = [];

  if (deployResult.error?.message) {
    errors.push(classifyError(deployResult.error.message, artifactType, apiName));
  }

  if (Array.isArray(deployResult.errors)) {
    for (const err of deployResult.errors) {
      errors.push(classifyError(err.message || String(err), artifactType, apiName));
    }
  }

  return errors;
}

// ── Deterministic fix helpers ─────────────────────────────────────────────────

function removeXmlElement(xml, elementName) {
  const regex = new RegExp(`\\s*<${elementName}[^>]*>[\\s\\S]*?</${elementName}>`, 'gi');
  return xml.replace(regex, '');
}

function shortenApiName(xml) {
  return xml.replace(/<fullName>([^<]{41,})<\/fullName>/gi, (_, name) => {
    return `<fullName>${name.slice(0, 40)}</fullName>`;
  });
}

function truncateDescription(xml, maxLen = 255) {
  return xml.replace(/<description>([^<]+)<\/description>/gi, (_, desc) => {
    if (desc.length <= maxLen) return `<description>${desc}</description>`;
    return `<description>${desc.slice(0, maxLen - 3).trimEnd()}...</description>`;
  });
}

module.exports = { classifyError, classifyDeployResult };
