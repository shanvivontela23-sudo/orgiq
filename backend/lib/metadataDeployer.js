/**
 * metadataDeployer.js
 *
 * Deploys any Salesforce metadata artifact via the Metadata API.
 * Everything in memory — no filesystem. No manual upload.
 *
 * Supports: Flow, Report, Apex, ValidationRule, PermissionSet
 */

const JSZip = require("jszip");

// Artifact type → Metadata API folder and extension mapping
const ARTIFACT_CONFIG = {
  flow: {
    folder:    "flows",
    extension: "flow-meta.xml",
    metaType:  "Flow",
  },
  report: {
    folder:    "reports",
    extension: "report-meta.xml",
    metaType:  "Report",
  },
  apex: {
    folder:    "classes",
    extension: "cls",
    metaType:  "ApexClass",
  },
  validationRule: {
    folder:    "objects",
    extension: "object-meta.xml",
    metaType:  "ValidationRule",
  },
  permissionSet: {
    folder:    "permissionsets",
    extension: "permissionset-meta.xml",
    metaType:  "PermissionSet",
  },
};

/**
 * Deploy a generated artifact to Salesforce via Metadata API
 *
 * @param {object} params
 * @param {string} params.artifactXml   - The generated XML (or Apex code)
 * @param {string} params.artifactType  - 'flow' | 'report' | 'apex' | etc.
 * @param {string} params.apiName       - API name for the artifact (no spaces)
 * @param {object} params.sfClient      - Authenticated SalesforceClient
 * @param {boolean} params.activate     - Activate Flow after deploy? (Flows only)
 * @param {boolean} params.checkOnly    - Validate deploy package without changing the org
 */
async function deployArtifact({ artifactXml, artifactType, apiName, sfClient, activate = false, checkOnly = false }) {
  const config = ARTIFACT_CONFIG[artifactType];
  if (!config) throw new Error(`Unsupported artifact type: ${artifactType}`);

  // Sanitize API name — validation rules may be passed as Object.Rule_Name.
  const cleanApiName = cleanMetadataMemberName(apiName, artifactType);
  const preparedArtifactXml = normalizeArtifactForDeploy({
    artifactXml,
    artifactType,
    apiName: cleanApiName,
  });

  // Build the in-memory zip package
  const zipBuffer = await buildDeployPackage({
    artifactXml: preparedArtifactXml,
    artifactType,
    apiName: cleanApiName,
    config,
  });

  // Deploy via Metadata API
  const deployResult = await metadataDeploy(sfClient, zipBuffer, { checkOnly });

  // Activate Flow if requested and deploy succeeded
  if (!checkOnly && activate && artifactType === "flow" && deployResult.success) {
    await activateFlow(sfClient, cleanApiName);
  }

  return {
    ...deployResult,
    checkOnly,
  };
}

function normalizeArtifactForDeploy({ artifactXml, artifactType, apiName }) {
  if (artifactType === "flow") return normalizeFlowForDeploy(artifactXml, apiName);
  if (artifactType === "report") return normalizeReportForDeploy(artifactXml, apiName);
  if (artifactType !== "validationRule") return artifactXml;

  const fullName = extractXmlBlock(artifactXml, "fullName") || apiName;
  const objectName = inferValidationRuleObject(artifactXml, fullName);
  const normalizedFullName = fullName.includes(".") ? fullName : `${objectName}.${fullName}`;
  const active = extractXmlBlock(artifactXml, "active") || "true";
  const description = truncateDescription(extractXmlBlock(artifactXml, "description"), 240);
  const formula = stripFormulaComments(extractXmlBlock(artifactXml, "errorConditionFormula"));
  const errorDisplayField = extractXmlBlock(artifactXml, "errorDisplayField");
  const errorMessage = extractXmlBlock(artifactXml, "errorMessage");

  if (!normalizedFullName) throw new Error("Validation rule fullName is required.");
  if (!formula) throw new Error("Validation rule errorConditionFormula is required.");
  if (!errorMessage) throw new Error("Validation rule errorMessage is required.");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>${escapeMetadataXmlText(normalizedFullName)}</fullName>
  <active>${escapeMetadataXmlText(active)}</active>
  ${description ? `<description>${escapeMetadataXmlText(description)}</description>` : ""}
  <errorConditionFormula>${escapeMetadataXmlText(formula)}</errorConditionFormula>
  ${errorDisplayField ? `<errorDisplayField>${escapeMetadataXmlText(errorDisplayField)}</errorDisplayField>` : ""}
  <errorMessage>${escapeMetadataXmlText(errorMessage)}</errorMessage>
</ValidationRule>`;
}

function normalizeReportForDeploy(reportXml, apiName) {
  const reportName = String(apiName || "").split("/").pop();
  let normalized = stripXmlComments(reportXml)
    .replace(/<reportSummaries>[\s\S]*?<\/reportSummaries>\s*/gi, "")
    .replace(/<chart>[\s\S]*?<\/chart>\s*/gi, "")
    .replace(/\s*<language>[\s\S]*?<\/language>/gi, "")
    .replace(/\s*<booleanFilter>[\s\S]*?<\/booleanFilter>/gi, "");

  if (reportName) {
    normalized = normalized.replace(
      /<name>[\s\S]*?<\/name>/i,
      `<name>${escapeMetadataXmlText(reportName)}</name>`
    );
  }

  const groupedFields = extractReportGroupedFields(normalized);
  groupedFields.forEach((fieldName) => {
    normalized = removeReportColumn(normalized, fieldName);
    normalized = removeReportSortForField(normalized, fieldName);
  });

  // These owner aliases are commonly guessed by LLMs but rejected by the
  // standard Opportunity report type. Keep deploys moving until org-specific
  // report-column discovery is wired in.
  ["OWNER", "OPPORTUNITY_OWNER"].forEach((fieldName) => {
    normalized = removeReportColumn(normalized, fieldName);
  });

  return normalized;
}

function extractReportGroupedFields(reportXml) {
  const groupedFields = [];
  const groupingRegex = /<groupings(?:Down|Across)>[\s\S]*?<field>([\s\S]*?)<\/field>[\s\S]*?<\/groupings(?:Down|Across)>/gi;
  let match;
  while ((match = groupingRegex.exec(reportXml)) !== null) {
    groupedFields.push(match[1].trim());
  }
  return groupedFields;
}

function removeReportColumn(reportXml, fieldName) {
  const escapedField = escapeRegExp(fieldName);
  return reportXml.replace(
    new RegExp(`\\s*<columns>\\s*<field>${escapedField}</field>\\s*</columns>`, "gi"),
    ""
  );
}

function removeReportSortForField(reportXml, fieldName) {
  const escapedField = escapeRegExp(fieldName);
  const sortColumnRegex = new RegExp(`\\s*<sortColumn>${escapedField}</sortColumn>\\s*<sortOrder>[\\s\\S]*?</sortOrder>`, "gi");
  return reportXml
    .replace(sortColumnRegex, "")
    .replace(new RegExp(`\\s*<sortColumn>${escapedField}</sortColumn>`, "gi"), "");
}

function normalizeFlowForDeploy(flowXml, apiName) {
  const cleanApiName = sanitizeMetadataApiName(apiName);
  let normalized = stripXmlComments(flowXml)
    .replace(/<noMoreValuesToProcess>[\s\S]*?<\/noMoreValuesToProcess>\s*/gi, "")
    .replace(/<fullName>[\s\S]*?<\/fullName>/i, `<fullName>${escapeMetadataXmlText(cleanApiName)}</fullName>`);

  if (!/<fullName>[\s\S]*?<\/fullName>/i.test(normalized)) {
    normalized = normalized.replace(
      /<Flow(?:\s+xmlns="[^"]*")?\s*>/i,
      (match) => `${match}\n  <fullName>${escapeMetadataXmlText(cleanApiName)}</fullName>`
    );
  }

  return normalized;
}

/**
 * Build the in-memory zip package
 * Structure:
 *   package.xml
 *   flows/MyFlow.flow-meta.xml  (or other folder)
 */
async function buildDeployPackage({ artifactXml, artifactType, apiName, config }) {
  const zip = new JSZip();

  // Add the artifact file
  if (artifactType === "validationRule") {
    const objectApiName = inferValidationRuleObject(artifactXml, apiName);
    zip.file(`${config.folder}/${objectApiName}.object`, buildCustomObjectValidationRuleXml(artifactXml));
    zip.file("package.xml", buildPackageXml("CustomObject", objectApiName));
  } else if (artifactType === "report") {
    zip.file(`${config.folder}/${apiName}.${config.extension}`, artifactXml);
    zip.file("package.xml", buildPackageXml(config.metaType, apiName));
  } else {
    zip.file(`${config.folder}/${apiName}.${config.extension}`, artifactXml);
    zip.file("package.xml", buildPackageXml(config.metaType, apiName));
  }

  // Add Apex meta file if it's an Apex class
  if (artifactType === "apex") {
    zip.file(
      `${config.folder}/${apiName}.cls-meta.xml`,
      buildApexMetaXml(apiName)
    );
  }

  // Generate as Node buffer — never touches the filesystem
  return zip.generateAsync({
    type:               "nodebuffer",
    compression:        "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/**
 * Metadata API SOAP deploy — returns asyncResultId, then polls for completion
 */
async function metadataDeploy(sfClient, zipBuffer, { checkOnly = false } = {}) {
  const instanceUrl = sfClient.instanceUrl;
  const accessToken = sfClient.accessToken;

  // Base64 encode the zip
  const zipBase64 = zipBuffer.toString("base64");

  // SOAP envelope for deploy
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:CallOptions><met:client>OrgIQ</met:client></met:CallOptions>
    <met:SessionHeader><met:sessionId>${accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:deploy>
      <met:ZipFile>${zipBase64}</met:ZipFile>
      <met:DeployOptions>
        <met:allowMissingFiles>false</met:allowMissingFiles>
        <met:autoUpdatePackage>false</met:autoUpdatePackage>
        <met:checkOnly>${checkOnly ? "true" : "false"}</met:checkOnly>
        <met:ignoreWarnings>false</met:ignoreWarnings>
        <met:performRetrieve>false</met:performRetrieve>
        <met:purgeOnDelete>false</met:purgeOnDelete>
        <met:rollbackOnError>true</met:rollbackOnError>
        <met:singlePackage>true</met:singlePackage>
        <met:testLevel>NoTestRun</met:testLevel>
      </met:DeployOptions>
    </met:deploy>
  </soapenv:Body>
</soapenv:Envelope>`;

  // Initiate deploy
  const deployRes = await fetch(
    `${instanceUrl}/services/Soap/m/59.0`,
    {
      method:  "POST",
      headers: {
        "Content-Type": "text/xml",
        "SOAPAction":   "deploy",
      },
      body: soapBody,
    }
  );

  const deployText = await deployRes.text();
  const asyncId    = extractSoapValue(deployText, "id");

  if (!asyncId) {
    throw new Error(`Deploy initiation failed: ${deployText}`);
  }

  // Poll for completion
  return pollDeployStatus(sfClient, asyncId);
}

/**
 * Poll Metadata API until deploy is complete
 */
async function pollDeployStatus(sfClient, asyncId, maxAttempts = 60) {
  const instanceUrl = sfClient.instanceUrl;
  const accessToken = sfClient.accessToken;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(3000); // poll every 3 seconds

    const statusBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:checkDeployStatus>
      <met:asyncProcessId>${asyncId}</met:asyncProcessId>
      <met:includeDetails>true</met:includeDetails>
    </met:checkDeployStatus>
  </soapenv:Body>
</soapenv:Envelope>`;

    const statusRes  = await fetch(`${instanceUrl}/services/Soap/m/59.0`, {
      method:  "POST",
      headers: { "Content-Type": "text/xml", "SOAPAction": "checkDeployStatus" },
      body:    statusBody,
    });

    const statusText = await statusRes.text();
    const done       = extractSoapValue(statusText, "done");
    const success    = extractSoapValue(statusText, "success");
    const status     = extractSoapValue(statusText, "status");

    if (done === "true") {
      if (success === "true") {
        return { success: true, status, asyncId, message: "Deployment successful" };
      } else {
        // Extract error details
        const errorMessage  = extractSoapValue(statusText, "problem") ||
                              extractSoapValue(statusText, "message") ||
                              "Unknown error";
        const errorType     = extractSoapValue(statusText, "problemType") || "Error";
        const errorLine     = extractSoapValue(statusText, "lineNumber");
        const errorColumn   = extractSoapValue(statusText, "columnNumber");
        const errorFileName = extractSoapValue(statusText, "fileName");

        return {
          success: false,
          status,
          asyncId,
          error: {
            message:  errorMessage,
            type:     errorType,
            line:     errorLine,
            column:   errorColumn,
            fileName: errorFileName,
          },
        };
      }
    }

    // Still in progress — log status for long-running deploys
    if (attempt % 5 === 0) {
      console.log(`Deploy ${asyncId}: ${status} (attempt ${attempt + 1})`);
    }
  }

  throw new Error(`Deploy ${asyncId} timed out after ${maxAttempts * 3} seconds`);
}

/**
 * Activate a deployed Flow via Tooling API
 * Deployed Flows start as Draft — activation is a separate step
 */
async function activateFlow(sfClient, flowApiName) {
  // Find the FlowDefinition
  const result = await sfClient.toolingQuery(
    `SELECT Id FROM FlowDefinition WHERE DeveloperName = '${flowApiName}' LIMIT 1`
  );

  if (!result.records?.length) {
    console.warn(`Could not find FlowDefinition for ${flowApiName} to activate`);
    return;
  }

  const flowDefId = result.records[0].Id;

  // Set active version
  await sfClient.fetch(`/services/data/v59.0/tooling/sobjects/FlowDefinition/${flowDefId}`, {
    method: "PATCH",
    body:   JSON.stringify({ Metadata: { activeVersionNumber: 1 } }),
  });

  console.log(`Flow ${flowApiName} activated`);
}

// ─── XML BUILDERS ─────────────────────────────────────────────────────────────

function buildPackageXml(metaType, apiName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>${apiName}</members>
    <name>${metaType}</name>
  </types>
  <version>59.0</version>
</Package>`;
}

function buildApexMetaXml(apiName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <status>Active</status>
</ApexClass>`;
}

function inferValidationRuleObject(artifactXml, apiName) {
  const fullName = extractXmlValue(artifactXml, "fullName") || apiName;
  if (fullName.includes(".")) return fullName.split(".")[0];

  // The generator currently describes object context in the rule request, but
  // Metadata API validation-rule XML needs an owning object in the package.
  // Account is the safe inference for the built-in Type/Phone combination.
  if (/\b(?:Type|Phone)\b/.test(artifactXml)) return "Account";

  throw new Error(
    "Could not infer the object for this validation rule. Generate the rule with a fullName like Account.Rule_API_Name."
  );
}

function buildCustomObjectValidationRuleXml(validationRuleXml) {
  const fullName = extractXmlBlock(validationRuleXml, "fullName")
    .replace(/^[^.]+\./, "");
  const active = extractXmlBlock(validationRuleXml, "active") || "true";
  const description = truncateDescription(extractXmlBlock(validationRuleXml, "description"), 240);
  const formula = stripFormulaComments(extractXmlBlock(validationRuleXml, "errorConditionFormula"));
  const errorDisplayField = extractXmlBlock(validationRuleXml, "errorDisplayField");
  const errorMessage = extractXmlBlock(validationRuleXml, "errorMessage");

  const childXml = [
    `<fullName>${escapeMetadataXmlText(fullName)}</fullName>`,
    `<active>${escapeMetadataXmlText(active)}</active>`,
    description ? `<description>${escapeMetadataXmlText(description)}</description>` : null,
    `<errorConditionFormula>${escapeMetadataXmlText(formula)}</errorConditionFormula>`,
    errorDisplayField ? `<errorDisplayField>${escapeMetadataXmlText(errorDisplayField)}</errorDisplayField>` : null,
    `<errorMessage>${escapeMetadataXmlText(errorMessage)}</errorMessage>`,
  ].filter(Boolean).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <validationRules>
${indentXml(childXml, 4)}
  </validationRules>
</CustomObject>`;
}

function extractXmlBlock(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return decodeXmlEntities(match?.[1]?.trim() || "");
}

function stripFormulaComments(formula) {
  return formula
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function truncateDescription(description, maxLength) {
  if (!description || description.length <= maxLength) return description;
  return `${description.slice(0, maxLength - 3).trimEnd()}...`;
}

function sanitizeMetadataApiName(value = "OrgIQ_Generated") {
  const sanitized = String(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&[^;\s]+;/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withLeadingLetter = /^[a-zA-Z]/.test(sanitized)
    ? sanitized
    : `OrgIQ_${sanitized || "Generated"}`;

  return withLeadingLetter.replace(/__+/g, "_").slice(0, 80);
}

function cleanMetadataMemberName(apiName, artifactType) {
  if (artifactType === "validationRule") return apiName;
  if (artifactType === "report") return normalizeReportMemberName(apiName);
  return sanitizeMetadataApiName(apiName);
}

function normalizeReportMemberName(apiName = "OrgIQ_Generated_Report") {
  const raw = String(apiName).trim();
  const [rawFolder, rawName] = raw.includes("/")
    ? raw.split("/", 2)
    : ["unfiled$public", raw];
  const folder = rawFolder === "unfiled$public"
    ? "unfiled$public"
    : sanitizeMetadataApiName(rawFolder || "unfiled_public");
  const name = sanitizeMetadataApiName(rawName || "OrgIQ_Generated_Report").slice(0, 40);

  return `${folder}/${name}`;
}

function stripXmlComments(xml = "") {
  return String(xml).replace(/<!--[\s\S]*?-->\s*/g, "");
}

function escapeMetadataXmlText(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeXmlEntities(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractXmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return match?.[1]?.trim() || null;
}

function indentXml(xml, spaces) {
  const pad = " ".repeat(spaces);
  return xml.split("\n").map((line) => `${pad}${line}`).join("\n");
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function extractSoapValue(xml, tag) {
  const match = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([^<]*)<`));
  return match?.[1]?.trim() || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Attach metadataDeploy to sfClient prototype for convenience
// Called as: sfClient.metadataDeploy(zipBuffer)
function attachToClient(SalesforceClient) {
  SalesforceClient.prototype.metadataDeploy = function (zipBuffer) {
    return metadataDeploy(this, zipBuffer);
  };
}

module.exports = {
  deployArtifact,
  buildDeployPackage,
  normalizeArtifactForDeploy,
  sanitizeMetadataApiName,
  normalizeReportMemberName,
  activateFlow,
  attachToClient,
};
