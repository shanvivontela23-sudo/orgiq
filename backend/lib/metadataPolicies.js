"use strict";

const METADATA_POLICIES = {
  flow: {
    displayName: "Flow",
    interrogationMustAsk: [
      "Flow type, triggering object, trigger timing, and create/update/delete scope.",
      "Entry criteria, change-detection rules, and recursion/idempotency guard.",
      "Bulk volume, imports/API updates, loops, Get Records, DML count, callouts, CPU/heap risk, and async needs.",
      "Fault handling path for every DML/action/get that can fail.",
      "Run context/security expectations and whether user permissions should matter.",
      "Existing automation on the same object and whether logic should consolidate.",
      "Activation preference: Draft review first or activate immediately.",
    ],
    generationMustDo: [
      "Use before-save only for same-record field updates; use after-save for creating/updating other records, email, or side effects.",
      "Use entry criteria and ISCHANGED-style logic to prevent repeated execution.",
      "Never place Get/Create/Update/Delete inside a loop; collect then write outside the loop.",
      "Add fault connectors for DML/actions and route to a concrete handler.",
      "Avoid hardcoded IDs; use DeveloperName, Custom Metadata, Custom Settings, or user-provided config.",
      "Generate Draft by default and require explicit activation.",
      "Use namespace-safe API names with single underscores only.",
    ],
    deployPreflight: [
      "Strip invalid Flow metadata elements and XML comments.",
      "Normalize API names and fullName.",
      "Replace placeholder recipients/values before deploy.",
      "Classify Flow schema, action configuration, and activation errors.",
    ],
  },

  validationRule: {
    displayName: "Validation Rule",
    interrogationMustAsk: [
      "Exact object, field API names, triggering conditions, and expected error field.",
      "For structured fields, valid/invalid formats, placeholders, min/max length, country/locale, and bypass requirements.",
      "Whether admins, integrations, API users, data loads, or permission sets need a bypass.",
      "Whether one combined rule/message or multiple specific rules/messages is preferred.",
      "Impact on imports, integrations, user experience, and existing validation rules.",
    ],
    generationMustDo: [
      "Formula returns TRUE only when the record must be blocked.",
      "Use correct formula functions such as ISBLANK, ISPICKVAL, ISCHANGED, REGEX, AND/OR/NOT.",
      "Keep descriptions under 255 characters.",
      "Escape XML-sensitive formula characters and remove comments from formula XML.",
      "Use fullName with owning object, e.g. Account.Rule_API_Name.",
      "Avoid broad bypasses unless explicitly approved.",
    ],
    deployPreflight: [
      "Truncate long descriptions.",
      "Escape formula XML text.",
      "Strip formula comments.",
      "Infer/require owning object for package structure.",
      "Classify formula syntax, description limit, and malformed XML errors.",
    ],
  },

  report: {
    displayName: "Report",
    interrogationMustAsk: [
      "Report folder and who should see the report.",
      "Report type, objects, columns, filters, date range, grouping, format, and sort order.",
      "Dashboard/subscription needs and whether summary or matrix format is required.",
      "Expected row volume, date filters, performance risk, and whether high-volume objects are involved.",
      "PII/confidential fields, FLS/security, and sharing implications.",
    ],
    generationMustDo: [
      "Use a valid reportType from the target org.",
      "Use Salesforce report column names, not guessed field labels.",
      "Avoid high-volume reports without bounded filters and date ranges.",
      "Use relative dates where possible so reports stay useful.",
      "Deploy under a folder-qualified member name such as unfiled$public/Report_API_Name.",
      "Do not place sensitive reports into broad shared folders unless explicitly approved.",
    ],
    deployPreflight: [
      "Normalize report member names into a folder-qualified path.",
      "Require reportType.",
      "Classify report folder and reportType failures.",
      "Flag reports without filters or with likely high-volume sources.",
    ],
  },

  apex: {
    displayName: "Apex",
    interrogationMustAsk: [
      "Exact trigger/class purpose, object scope, operation scope, and transaction volume.",
      "Security model: with/inherited/without sharing, CRUD/FLS, user-mode SOQL/DML, and stripInaccessible needs.",
      "Governor limits: SOQL, DML, rows, CPU, heap, callouts, mixed DML, async/chaining, and retries.",
      "Error handling, partial success vs atomic behavior, idempotency, and logging.",
      "Test scenarios including bulk 200 records, negative paths, async, sharing/security, and limits.",
    ],
    generationMustDo: [
      "Use one trigger per object and handler/service patterns.",
      "No SOQL/DML in loops; bulkify all collections.",
      "No hardcoded IDs; query by DeveloperName or use Custom Metadata.",
      "Use bind variables and allowlists for dynamic SOQL.",
      "Apply sharing and CRUD/FLS/user-mode checks where appropriate.",
      "Generate meaningful test classes with positive, negative, bulk, and edge-case coverage.",
      "Never use SeeAllData=true unless explicitly justified.",
    ],
    deployPreflight: [
      "Require test class/code block for Apex generation.",
      "Classify compile errors, missing tests, coverage, governor-limit anti-patterns, and security anti-patterns.",
    ],
  },

  permissionSet: {
    displayName: "Permission Set",
    interrogationMustAsk: [
      "Target user persona/license and whether the license supports requested access.",
      "Exact object, field, Apex class, Visualforce, tab, app, system, and custom permissions needed.",
      "Least-privilege constraints and whether View All/Modify All/Manage permissions are truly required.",
      "Whether access is read-only, edit, create, delete, or admin-level.",
      "Dependencies on managed packages, features, user licenses, and existing permission sets.",
    ],
    generationMustDo: [
      "Grant only explicitly requested permissions.",
      "Default View All, Modify All, and broad system permissions to false unless approved.",
      "Include userLicense only when appropriate for the target user population.",
      "Use object and field API names exactly.",
      "Avoid profile-style broad access; prefer composable least-privilege permission sets.",
    ],
    deployPreflight: [
      "Classify license mismatch, missing object/field, invalid permission, and broad-access risk.",
      "Flag dangerous permissions before deploy.",
    ],
  },
};

function getMetadataPolicy(artifactType) {
  return METADATA_POLICIES[artifactType] || null;
}

function formatMetadataPolicy(artifactType) {
  const policy = getMetadataPolicy(artifactType);
  if (!policy) return "";
  return formatPolicyBlock(policy);
}

function formatAllMetadataPolicies() {
  return Object.values(METADATA_POLICIES)
    .map(formatPolicyBlock)
    .join("\n\n");
}

function formatPolicyBlock(policy) {
  return `### ${policy.displayName} Creation Policy
Must ask before generation:
${policy.interrogationMustAsk.map((item) => `- ${item}`).join("\n")}

Must apply during generation:
${policy.generationMustDo.map((item) => `- ${item}`).join("\n")}

Must enforce during deploy/preflight:
${policy.deployPreflight.map((item) => `- ${item}`).join("\n")}`;
}

module.exports = {
  METADATA_POLICIES,
  getMetadataPolicy,
  formatMetadataPolicy,
  formatAllMetadataPolicies,
};
