"use strict";

const FAILURE_RULES = [
  {
    code: "FLOW_INVALID_METADATA_ELEMENT",
    category: "metadata_schema",
    artifactTypes: ["flow"],
    match: /noMoreValuesToProcess invalid|Element .* invalid at this location in type Flow/i,
    summary: "Flow XML contains an element that is not valid for Salesforce Metadata API.",
    deterministicFixAvailable: true,
    systemFix: "Strip unsupported Flow elements before package creation and add the element name to the Flow normalizer denylist.",
  },
  {
    code: "METADATA_UNSAFE_API_NAME",
    category: "metadata_identity",
    artifactTypes: ["flow", "report", "apex", "permissionSet"],
    match: /Cannot create a new component with the namespace|same namespace as the organization/i,
    summary: "The component API name looks like it contains a namespace or invalid developer-name pattern.",
    deterministicFixAvailable: true,
    systemFix: "Normalize metadata API names to letters, numbers, and single underscores before deploy.",
  },
  {
    code: "VALIDATION_RULE_DESCRIPTION_LIMIT",
    category: "metadata_limit",
    artifactTypes: ["validationRule"],
    match: /Validation rule description cannot be longer than 255/i,
    summary: "Validation rule description exceeds Salesforce's 255-character limit.",
    deterministicFixAvailable: true,
    systemFix: "Truncate validation rule descriptions before package creation.",
  },
  {
    code: "REPORT_INVALID_METADATA_ELEMENT",
    category: "metadata_schema",
    artifactTypes: ["report"],
    match: /Element .*?(reportSummaries|aggregate|chart).* invalid at this location in type Report|Element .*?aggregate invalid at this location in type ReportAggregate/i,
    summary: "Report XML contains summary/chart metadata in a shape Salesforce Metadata API does not accept.",
    deterministicFixAvailable: true,
    systemFix: "Strip unsupported reportSummaries/chart blocks and prefer simple Summary/Tabular metadata until report aggregate templates are validated.",
  },
  {
    code: "REPORT_NAME_TOO_LONG",
    category: "metadata_limit",
    artifactTypes: ["report"],
    match: /Value too long for field:\s*Name maximum length is:40|Name maximum length is:40/i,
    summary: "Report API name is longer than Salesforce's 40-character report name limit.",
    deterministicFixAvailable: true,
    systemFix: "Truncate the report member name and XML name to 40 Salesforce-safe characters before deploy.",
  },
  {
    code: "XML_NOT_WELL_FORMED",
    category: "xml_syntax",
    artifactTypes: ["flow", "validationRule", "report", "permissionSet"],
    match: /Error parsing file|well-formed character data|markup/i,
    summary: "Generated XML is not well formed or contains unescaped XML-sensitive characters.",
    deterministicFixAvailable: true,
    systemFix: "Escape XML text nodes and strip comments/placeholders before deploy.",
  },
  {
    code: "FLOW_ACTION_CONFIGURATION",
    category: "flow_action",
    artifactTypes: ["flow"],
    match: /actionCall|actionName|emailSimple|inputParameter|Email/i,
    summary: "A Flow action is configured in a way Salesforce cannot deploy.",
    deterministicFixAvailable: false,
    systemFix: "Add action-specific Flow templates and validators for email, Apex actions, subflows, and invocable actions.",
  },
  {
    code: "REPORT_FOLDER_REQUIRED",
    category: "report_folder",
    artifactTypes: ["report"],
    match: /folder|reports\/.*report-meta\.xml|unfiled|public/i,
    summary: "Report metadata needs a valid Salesforce report folder path.",
    deterministicFixAvailable: true,
    systemFix: "Deploy reports under a folder-qualified member name such as unfiled$public/Report_API_Name.",
  },
  {
    code: "REPORT_TYPE_INVALID",
    category: "report_type",
    artifactTypes: ["report"],
    match: /reportType|invalid report type|Report Type/i,
    summary: "The report references a report type Salesforce does not recognize in this org.",
    deterministicFixAvailable: false,
    systemFix: "Retrieve available report types from the org before generation and restrict Claude to valid reportType values.",
  },
  {
    code: "REPORT_FIELD_FILTER_INVALID",
    category: "report_field_filter",
    artifactTypes: ["report"],
    match: /columns-field|sortColumn|filterlanguage|criteriaItems|Invalid value specified/i,
    summary: "Report XML references report columns, sort fields, or filter metadata Salesforce does not accept for this report type.",
    deterministicFixAvailable: true,
    systemFix: "Normalize report columns/filter logic before deploy and remove invalid guessed report fields until org-specific report type columns are retrieved.",
  },
  {
    code: "APEX_COMPILE_ERROR",
    category: "apex_compile",
    artifactTypes: ["apex"],
    match: /ApexClass|compile|unexpected token|Invalid type|Variable does not exist|Method does not exist/i,
    summary: "Apex did not compile in Salesforce.",
    deterministicFixAvailable: false,
    systemFix: "Capture compiler diagnostics and add Apex parser/static analysis before deploy.",
  },
  {
    code: "APEX_TEST_COVERAGE",
    category: "test_coverage",
    artifactTypes: ["apex"],
    match: /test coverage|RunLocalTests|code coverage|No test methods/i,
    summary: "Apex deployment failed because tests or coverage are insufficient.",
    deterministicFixAvailable: false,
    systemFix: "Require generated test classes and run check-only deploy before real deploy.",
  },
  {
    code: "PERMISSION_SET_INVALID_PERMISSION",
    category: "permission_set",
    artifactTypes: ["permissionSet"],
    match: /Unknown user permission|invalid.*permission|Cannot find object|Cannot find field|user license/i,
    summary: "Permission set contains an invalid permission, object, field, or license mismatch.",
    deterministicFixAvailable: false,
    systemFix: "Validate requested permissions against org metadata and target user license before generation.",
  },
  {
    code: "MISSING_REQUIRED_METADATA",
    category: "metadata_required_field",
    artifactTypes: ["flow", "validationRule", "report", "permissionSet"],
    match: /Required fields are missing|required field missing|required.*missing/i,
    summary: "Salesforce says required metadata is missing.",
    deterministicFixAvailable: false,
    systemFix: "Add artifact-type required-field validators before deploy.",
  },
  {
    code: "UNKNOWN_SALESFORCE_DEPLOY_FAILURE",
    category: "unknown",
    artifactTypes: ["flow", "validationRule", "report", "apex", "permissionSet"],
    match: /.*/i,
    summary: "Salesforce rejected the deploy for a reason OrgIQ has not classified yet.",
    deterministicFixAvailable: false,
    systemFix: "Capture the error and add a classifier plus deterministic validator when the pattern repeats.",
  },
];

function classifyDeployFailure({ error, artifactType }) {
  const message = [
    error?.message,
    error?.type,
    error?.fileName,
    error?.line,
    error?.column,
  ].filter(Boolean).join(" ");

  const rule = FAILURE_RULES.find((candidate) => {
    return candidate.artifactTypes.includes(artifactType) && candidate.match.test(message);
  }) || FAILURE_RULES[FAILURE_RULES.length - 1];

  return {
    code: rule.code,
    category: rule.category,
    artifactType,
    summary: rule.summary,
    salesforceMessage: error?.message || "Unknown error",
    fileName: error?.fileName || null,
    line: error?.line || null,
    column: error?.column || null,
    deterministicFixAvailable: rule.deterministicFixAvailable,
    recommendedSystemFix: rule.systemFix,
    repairStrategy: rule.deterministicFixAvailable
      ? "deterministic_normalizer"
      : "claude_assisted_repair",
  };
}

function inspectArtifactBeforeDeploy({ artifactXml, artifactType, apiName }) {
  const issues = [];
  const xml = artifactXml || "";

  if (artifactType === "flow") {
    if (/__+/.test(apiName) || /[^a-zA-Z0-9_]/.test(apiName)) {
      issues.push({
        code: "METADATA_UNSAFE_API_NAME",
        category: "metadata_identity",
        summary: "Flow API name will be normalized before deploy.",
        deterministicFixAvailable: true,
      });
    }

    if (/<noMoreValuesToProcess>/i.test(xml)) {
      issues.push({
        code: "FLOW_INVALID_METADATA_ELEMENT",
        category: "metadata_schema",
        summary: "Unsupported Flow element will be removed before deploy.",
        deterministicFixAvailable: true,
      });
    }

    if (/REPLACE_WITH_ADMIN_EMAIL@yourdomain\.com|admin@example\.com/i.test(xml)) {
      issues.push({
        code: "PLACEHOLDER_EMAIL_RECIPIENT",
        category: "placeholder",
        summary: "Placeholder admin email will be replaced with the signed-in user's email.",
        deterministicFixAvailable: true,
      });
    }
  }

  if (artifactType === "validationRule") {
    const description = extractXmlValue(xml, "description");
    if (description.length > 255) {
      issues.push({
        code: "VALIDATION_RULE_DESCRIPTION_LIMIT",
        category: "metadata_limit",
        summary: "Validation rule description will be shortened before deploy.",
        deterministicFixAvailable: true,
      });
    }

    if (/<errorConditionFormula>[\s\S]*?[^&]<[^/][\s\S]*?<\/errorConditionFormula>/i.test(xml)) {
      issues.push({
        code: "XML_NOT_WELL_FORMED",
        category: "xml_syntax",
        summary: "Formula may contain raw XML-sensitive characters and will be escaped before deploy.",
        deterministicFixAvailable: true,
      });
    }
  }

  if (artifactType === "report") {
    if (!apiName.includes("/")) {
      issues.push({
        code: "REPORT_FOLDER_REQUIRED",
        category: "report_folder",
        summary: "Report will be placed in unfiled$public because no folder was specified.",
        deterministicFixAvailable: true,
      });
    }

    if (!/<reportType>[\s\S]+?<\/reportType>/i.test(xml)) {
      issues.push({
        code: "REPORT_TYPE_INVALID",
        category: "report_type",
        summary: "Report XML does not include a reportType.",
        deterministicFixAvailable: false,
      });
    }

    if (/<reportSummaries>|<chart>/i.test(xml)) {
      issues.push({
        code: "REPORT_INVALID_METADATA_ELEMENT",
        category: "metadata_schema",
        summary: "Unsupported report summary/chart blocks will be removed before deploy.",
        deterministicFixAvailable: true,
      });
    }
  }

  if (artifactType === "apex") {
    if (
      /\bfor\s*\([^)]*\)\s*\{[\s\S]*?\b(SELECT|insert|update|delete|upsert)\b/i.test(xml) ||
      /\b(SELECT|insert|update|delete|upsert)\b[\s\S]*?\bfor\s*\(/i.test(xml)
    ) {
      issues.push({
        code: "APEX_LIMIT_ANTIPATTERN",
        category: "governor_limits",
        summary: "Apex appears to contain SOQL or DML near a loop. Review bulkification before deploy.",
        deterministicFixAvailable: false,
      });
    }

    if (!/@isTest/i.test(xml)) {
      issues.push({
        code: "APEX_TEST_MISSING",
        category: "test_coverage",
        summary: "Generated Apex does not include a visible test class block.",
        deterministicFixAvailable: false,
      });
    }

    if (/SeeAllData\s*=\s*true/i.test(xml)) {
      issues.push({
        code: "APEX_SEE_ALL_DATA",
        category: "test_isolation",
        summary: "Apex test uses SeeAllData=true, which should be avoided unless explicitly justified.",
        deterministicFixAvailable: false,
      });
    }
  }

  if (artifactType === "permissionSet") {
    if (/<modifyAllRecords>true<\/modifyAllRecords>|<viewAllRecords>true<\/viewAllRecords>|<ModifyAllData>true<\/ModifyAllData>/i.test(xml)) {
      issues.push({
        code: "PERMISSION_SET_BROAD_ACCESS",
        category: "least_privilege",
        summary: "Permission set grants broad access. Confirm this was explicitly approved.",
        deterministicFixAvailable: false,
      });
    }

    if (/<userPermissions>[\s\S]*?<enabled>true<\/enabled>[\s\S]*?<\/userPermissions>/i.test(xml)) {
      issues.push({
        code: "PERMISSION_SET_SYSTEM_PERMISSION",
        category: "least_privilege",
        summary: "Permission set includes system permissions. Review for least privilege before deploy.",
        deterministicFixAvailable: false,
      });
    }
  }

  return issues;
}

function extractXmlValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match?.[1]?.trim() || "";
}

module.exports = {
  classifyDeployFailure,
  inspectArtifactBeforeDeploy,
};
