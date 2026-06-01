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
 */
async function deployArtifact({ artifactXml, artifactType, apiName, sfClient, activate = false }) {
  const config = ARTIFACT_CONFIG[artifactType];
  if (!config) throw new Error(`Unsupported artifact type: ${artifactType}`);

  // Sanitize API name — no spaces, no special chars
  const cleanApiName = apiName.replace(/[^a-zA-Z0-9_]/g, "_");

  // Build the in-memory zip package
  const zipBuffer = await buildDeployPackage({
    artifactXml,
    artifactType,
    apiName: cleanApiName,
    config,
  });

  // Deploy via Metadata API
  const deployResult = await metadataDeploy(sfClient, zipBuffer);

  // Activate Flow if requested and deploy succeeded
  if (activate && artifactType === "flow" && deployResult.success) {
    await activateFlow(sfClient, cleanApiName);
  }

  return deployResult;
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
async function metadataDeploy(sfClient, zipBuffer) {
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
        <met:checkOnly>false</met:checkOnly>
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
  const childXml = validationRuleXml
    .replace(/<\?xml[^>]*>\s*/i, "")
    .replace(/<\/?ValidationRule(?:\s+xmlns="[^"]*")?\s*>/g, "")
    .replace(/<fullName>([^.<]+)\.([^<]+)<\/fullName>/, "<fullName>$2</fullName>")
    .trim();

  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <validationRules>
${indentXml(childXml, 4)}
  </validationRules>
</CustomObject>`;
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

module.exports = { deployArtifact, buildDeployPackage, activateFlow, attachToClient };
