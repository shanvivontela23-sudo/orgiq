/**
 * generator.routes.js
 *
 * API routes for the SF Copilot artifact generator.
 * Uses Server-Sent Events (SSE) to stream Claude's responses in real-time.
 *
 * Mount at: app.use("/api/generate", require("./routes/generator.routes"))
 */

const express  = require("express");
const router   = express.Router();
const JSZip    = require("jszip");

const {
  startGeneration,
  continueGeneration,
  generateArtifact,
  repairGeneratedArtifact,
} = require("../lib/generatorEngine");
const { deployArtifact }       = require("../lib/metadataDeployer");
const { runDeployLoop }        = require("../lib/deployLoop");
const { runPreflight }         = require("../lib/preflightValidator");
const { classifyDeployResult } = require("../lib/errorClassifier");
// Legacy diagnostics — kept for backwards compat
let classifyDeployFailure, inspectArtifactBeforeDeploy;
try {
  const diag = require("../lib/deployDiagnostics");
  classifyDeployFailure       = diag.classifyDeployFailure;
  inspectArtifactBeforeDeploy = diag.inspectArtifactBeforeDeploy;
} catch {
  classifyDeployFailure       = (e) => e;
  inspectArtifactBeforeDeploy = () => [];
}
const { requireAuth }          = require("../middleware/auth");
const { withSalesforceClient } = require("../middleware/withSalesforceClient");
const { getSession, saveSession, deleteSession } = require("../lib/sessionStore");
const { withRateLimit }        = require("../lib/rateLimiter");
const {
  createDeploymentRun,
  recordGeneratedArtifact,
  recordArtifactVersion,
  recordDeploymentErrors,
  finalizeDeploymentRun,
} = require("../lib/deploymentAudit");
const { rememberDeployFailure } = require("../lib/brain");
const { DEPLOYMENT_STATES } = require("../lib/deploymentState");

function escapeSoql(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function validationRuleMetadataToXml(record) {
  const metadata = record.Metadata || {};
  return `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${escapeXml(record.FullName)}</fullName>
    <active>${metadata.active !== false}</active>
    <description>${escapeXml(metadata.description || record.Description || "")}</description>
    <errorConditionFormula>${escapeXml(metadata.errorConditionFormula || "")}</errorConditionFormula>
    <errorDisplayField>${escapeXml(metadata.errorDisplayField || record.ErrorDisplayField || "")}</errorDisplayField>
    <errorMessage>${escapeXml(metadata.errorMessage || record.ErrorMessage || "")}</errorMessage>
</ValidationRule>`;
}

function getErrorMessage(err) {
  const data = err.response?.data;
  if (Array.isArray(data) && data[0]?.message) return data[0].message;
  if (data?.message) return data.message;
  if (typeof data === "string") return data;
  return err.message || "Unknown error";
}

function applyDeployDefaults(artifactXml, user) {
  if (!artifactXml || !user?.email) return artifactXml;

  return artifactXml
    .replace(/REPLACE_WITH_ADMIN_EMAIL@yourdomain\.com/gi, user.email)
    .replace(/admin@example\.com/gi, user.email);
}

function toDeveloperName(value = "") {
  const normalized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || null;
}

function normalizeIncomingApiName({ artifactXml, artifactType, apiName }) {
  const isFlow = String(artifactType || "").toLowerCase() === "flow" || /<Flow\b/i.test(artifactXml || "");
  if (!isFlow) return apiName;

  const fullName = artifactXml?.match(/<fullName>(.*?)<\/fullName>/)?.[1];
  const label = artifactXml?.match(/<Flow\b[\s\S]*?<label>(.*?)<\/label>/i)?.[1];
  const inferred = fullName || toDeveloperName(label);
  const looksLikeFlowResource = /^(formula|var|create|update|delete|get|decision|loop|assignment|send)_/i.test(apiName || "");
  return inferred && (!apiName || looksLikeFlowResource) ? inferred : apiName;
}

function extractSoapValue(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1] || null;
}

async function retrieveMetadataMember(sfClient, metadataType, memberName) {
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${sfClient.accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:retrieve>
      <met:retrieveRequest>
        <met:apiVersion>59.0</met:apiVersion>
        <met:singlePackage>true</met:singlePackage>
        <met:unpackaged>
          <met:types>
            <met:members>${escapeXml(memberName)}</met:members>
            <met:name>${escapeXml(metadataType)}</met:name>
          </met:types>
          <met:version>59.0</met:version>
        </met:unpackaged>
      </met:retrieveRequest>
    </met:retrieve>
  </soapenv:Body>
</soapenv:Envelope>`;

  const retrieveRes = await fetch(`${sfClient.instanceUrl}/services/Soap/m/59.0`, {
    method: "POST",
    headers: { "Content-Type": "text/xml", "SOAPAction": "retrieve" },
    body: soapBody,
  });
  const retrieveText = await retrieveRes.text();
  const asyncId = extractSoapValue(retrieveText, "id");
  if (!asyncId) throw new Error(`Metadata retrieve failed to start: ${retrieveText}`);

  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const statusBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${sfClient.accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:checkRetrieveStatus>
      <met:asyncProcessId>${asyncId}</met:asyncProcessId>
      <met:includeZip>true</met:includeZip>
    </met:checkRetrieveStatus>
  </soapenv:Body>
</soapenv:Envelope>`;

    const statusRes = await fetch(`${sfClient.instanceUrl}/services/Soap/m/59.0`, {
      method: "POST",
      headers: { "Content-Type": "text/xml", "SOAPAction": "checkRetrieveStatus" },
      body: statusBody,
    });
    const statusText = await statusRes.text();
    if (extractSoapValue(statusText, "done") !== "true") continue;
    if (extractSoapValue(statusText, "success") !== "true") {
      throw new Error(extractSoapValue(statusText, "problem") || "Metadata retrieve failed.");
    }

    const zipBase64 = extractSoapValue(statusText, "zipFile");
    if (!zipBase64) throw new Error("Metadata retrieve completed without a zip file.");
    const zip = await JSZip.loadAsync(Buffer.from(zipBase64, "base64"));
    const expectedSuffixes = metadataType === "Flow"
      ? [`flows/${memberName}.flow-meta.xml`, `flows/${memberName}.flow`]
      : [];
    const fileName = Object.keys(zip.files).find(name => (
      expectedSuffixes.length
        ? expectedSuffixes.some(suffix => name.endsWith(suffix))
        : name.endsWith(`${memberName}.xml`)
    ));
    if (!fileName) throw new Error(`Retrieved package did not contain ${metadataType}:${memberName}.`);
    return zip.files[fileName].async("string");
  }

  throw new Error(`Metadata retrieve timed out for ${metadataType}:${memberName}.`);
}

function inferArtifactTypeFromInput(userInput = "", explicitType = null) {
  if (explicitType) return explicitType;
  const text = String(userInput);
  if (/<Flow\b/i.test(text)) return "flow";
  if (/<ValidationRule\b/i.test(text)) return "validationRule";
  if (/<Report\b/i.test(text)) return "report";
  if (/<PermissionSet\b/i.test(text)) return "permissionSet";
  if (/@isTest\b|public\s+(?:with\s+sharing\s+|without\s+sharing\s+)?class\b|private\s+class\b/i.test(text)) return "apex";
  return null;
}

function reviewIsReadyWithoutQuestions(text = "") {
  const normalized = String(text).toLowerCase();
  return normalized.includes("i have no questions") ||
    normalized.includes("no questions") && normalized.includes("ready to generate");
}

function flowSearchTerms(value) {
  const trimmed = String(value || "").trim();
  const labelish = trimmed.replace(/_/g, " ");
  return [...new Set([trimmed, labelish].filter(Boolean))];
}

async function findFlowDefinition(sfClient, normalized) {
  const exact = await sfClient.toolingQuery(
    `SELECT Id, DeveloperName, LatestVersionId, ActiveVersionId
     FROM FlowDefinition
     WHERE DeveloperName = '${escapeSoql(normalized)}'
     LIMIT 1`
  );
  if (exact.records?.[0]) return exact.records[0];

  for (const term of flowSearchTerms(normalized)) {
    const likeTerm = `%${escapeSoql(term)}%`;
    const result = await sfClient.toolingQuery(
      `SELECT Id, DeveloperName, LatestVersionId, ActiveVersionId
       FROM FlowDefinition
       WHERE DeveloperName LIKE '${likeTerm}' OR MasterLabel LIKE '${likeTerm}'
       ORDER BY DeveloperName ASC
       LIMIT 10`
    );
    if (result.records?.length === 1) return result.records[0];
    if (result.records?.length > 1) {
      const options = result.records.map(r => r.DeveloperName).join(", ");
      throw Object.assign(new Error(`Multiple Flows matched "${normalized}". Use one of: ${options}`), { statusCode: 409 });
    }
  }

  return null;
}

// ── POST /api/generate/start ─────────────────────────────────────────────────
// Phase 1: User submits their requirement, Claude asks questions
router.post("/start", requireAuth, withRateLimit('generate_start', 2), withSalesforceClient, async (req, res) => {
  const { userInput, inputType, artifactType } = req.body;

  if (!userInput?.trim()) {
    return res.status(400).json({ error: "userInput is required" });
  }

  try {
    const session = await startGeneration({
      userInput:    userInput.trim(),
      inputType:    inputType || "english",
      artifactType: inferArtifactTypeFromInput(userInput, artifactType), // null = Claude detects
      orgId:        req.orgConn.id,
      userId:       req.user.id,
      sfClient:     req.sf,
    });

    if (reviewIsReadyWithoutQuestions(session.questions)) {
      session.phase = 2;
      session.readyToGenerate = true;
      session.questions = "✅ Existing component loaded. The requested change is clear. Ready to generate.";
    }

    // Persist session (Redis, TTL 2 hours)
    await saveSession(session.sessionId, session);

    res.json({
      sessionId: session.sessionId,
      phase:     session.phase,
      questions: session.questions,
      artifactType: session.artifactType,
      readyToGenerate: Boolean(session.readyToGenerate),
    });

  } catch (err) {
    console.error("Generation start error:", err);
    res.status(500).json({ error: err.message || "Failed to start generation session" });
  }
});

// ── GET /api/generate/folders ─────────────────────────────────────────────────
// Return report folders accessible to the current user — for the report folder picker.
router.get("/folders", requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const result = await req.sf.query(
      `SELECT Id, Name, DeveloperName, Type, AccessType
       FROM Folder
       WHERE Type = 'Report' AND AccessType != 'Hidden'
       ORDER BY Name ASC
       LIMIT 200`
    );
    res.json({ folders: (result.records || []).map(f => ({
      id:   f.Id,
      name: f.Name,
      developerName: f.DeveloperName,
      type: f.Type,
    })) });
  } catch (err) {
    console.error("Fetch report folders error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/generate/report-types ───────────────────────────────────────────
// Return available report types for the report builder.
router.get("/report-types", requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const result = await req.sf.query(
      `SELECT Id, Name, DeveloperName, Description
       FROM ReportType
       WHERE IsActive = true
       ORDER BY Name ASC
       LIMIT 200`
    );
    res.json({ reportTypes: (result.records || []).map(r => ({
      id:   r.Id,
      name: r.Name,
      developerName: r.DeveloperName,
      description: r.Description,
    })) });
  } catch (err) {
    console.error("Fetch report types error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/generate/retrieve ───────────────────────────────────────────────
// Retrieve an existing metadata artifact so Claude can revise it.
router.post("/retrieve", requireAuth, withSalesforceClient, async (req, res) => {
  const { artifactType, fullName } = req.body;

  if (!artifactType || !fullName?.trim()) {
    return res.status(400).json({ error: "artifactType and fullName are required" });
  }

  const normalized = fullName.trim();

  try {
    // ── Validation Rule ───────────────────────────────────────────────────────
    if (artifactType === "validationRule") {
      const ruleName = normalized.includes(".") ? normalized.split(".").pop() : normalized;
      const result = await req.sf.toolingQuery(
        `SELECT Id, FullName, ValidationName, Active, Description, ErrorDisplayField, ErrorMessage, Metadata
         FROM ValidationRule
         WHERE ValidationName = '${escapeSoql(ruleName)}'
         LIMIT 1`
      );
      const record = result.records?.[0];
      if (!record) return res.status(404).json({ error: `Validation rule not found: ${normalized}` });
      return res.json({
        artifactType: "validationRule",
        fullName: record.FullName,
        apiName: record.ValidationName,
        artifactXml: validationRuleMetadataToXml(record),
        metadata: record.Metadata,
      });
    }

    // ── Flow ─────────────────────────────────────────────────────────────────
    if (artifactType === "flow") {
      const definition = await findFlowDefinition(req.sf, normalized);
      if (!definition) return res.status(404).json({ error: `Flow not found: ${normalized}. Search by Flow API name or label, for example Account_Rating_Hot_Create_Follow_Up_Task.` });

      const versionId = definition.LatestVersionId || definition.ActiveVersionId;
      if (!versionId) return res.status(404).json({ error: `Flow has no retrievable versions: ${normalized}` });

      const versionResult = await req.sf.toolingQuery(
        `SELECT Id, FullName, MasterLabel, ProcessType, Status, Description, VersionNumber
         FROM Flow
         WHERE Id = '${escapeSoql(versionId)}'
         LIMIT 1`
      );
      const record = versionResult.records?.[0];
      if (!record) return res.status(404).json({ error: `Flow version not found for: ${normalized}` });

      const artifactXml = await retrieveMetadataMember(req.sf, "Flow", definition.DeveloperName);

      return res.json({
        artifactType: "flow",
        fullName: definition.DeveloperName,
        apiName: definition.DeveloperName,
        label: record.MasterLabel,
        processType: record.ProcessType,
        status: record.Status,
        description: record.Description,
        versionNumber: record.VersionNumber,
        artifactXml,
      });
    }

    // ── Report ────────────────────────────────────────────────────────────────
    if (artifactType === "report") {
      const result = await req.sf.query(
        `SELECT Id, Name, DeveloperName, Description, FolderName, OwnerId, LastModifiedDate
         FROM Report
         WHERE DeveloperName = '${escapeSoql(normalized)}'
         LIMIT 1`
      );
      const record = result.records?.[0];
      if (!record) return res.status(404).json({ error: `Report not found: ${normalized}` });
      return res.json({
        artifactType: "report",
        fullName: record.DeveloperName,
        apiName: record.DeveloperName,
        label: record.Name,
        folderName: record.FolderName,
        description: record.Description,
        artifactXml: `<!-- Report: ${record.Name} in folder: ${record.FolderName} -->`,
      });
    }

    return res.status(400).json({ error: `Retrieve not yet supported for artifactType: ${artifactType}` });

  } catch (err) {
    const message = getErrorMessage(err);
    console.error("Retrieve artifact error:", message);
    res.status(err.statusCode || 500).json({ error: message });
  }
});

// ── POST /api/generate/answer ─────────────────────────────────────────────────
// User answers Claude's questions — may need more questions or ready to generate
router.post("/answer", requireAuth, withRateLimit('generate_answer', 1), async (req, res) => {
  const { sessionId, answer } = req.body;

  if (!sessionId || !answer?.trim()) {
    return res.status(400).json({ error: "sessionId and answer are required" });
  }

  try {
    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found or expired" });
    if (session.userId !== req.user.id) return res.status(403).json({ error: "Forbidden" });

    const updatedSession = await continueGeneration(session, answer.trim());
    await saveSession(sessionId, updatedSession);

    res.json({
      sessionId,
      phase:          updatedSession.phase,
      readyToGenerate: updatedSession.readyToGenerate,
      questions:      updatedSession.readyToGenerate ? null : updatedSession.questions,
    });

  } catch (err) {
    console.error("Answer processing error:", err);
    res.status(500).json({ error: "Failed to process answer" });
  }
});

// ── POST /api/generate/build ─────────────────────────────────────────────────
// Phase 2: Generate the artifact (and optionally deploy)
// Uses SSE to stream progress to the frontend.
// Aborts the Claude API call if the client disconnects — stops burning tokens.
router.post("/build", requireAuth, withRateLimit('generate_build', 1), withSalesforceClient, async (req, res) => {
  const { sessionId, deploy = false, activate = false } = req.body;

  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  // Set up SSE
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");

  // ── Abort controller — kills in-flight Claude calls when client disconnects ──
  const ac = new AbortController();
  let clientGone = false;

  req.on('close', () => {
    clientGone = true;
    ac.abort();
    console.log(`[generator] Client disconnected for session ${sessionId} — aborting Claude calls`);
  });

  const send = (event, data) => {
    if (clientGone) return; // don't write to a closed socket
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* ignore write-after-close */ }
  };

  try {
    const session = await getSession(sessionId);
    if (!session) { send("error", { message: "Session not found" }); return res.end(); }
    if (session.userId !== req.user.id) { send("error", { message: "Forbidden" }); return res.end(); }
    if (!session.artifactType) {
      send("error", { message: "Select a metadata type before generating." });
      return res.end();
    }

    send("status", { step: "generating", message: "Reviewing best practices and generating artifact..." });

    const result = await generateArtifact(session, { deploy: false }, req.sf, ac.signal);

    if (clientGone) return res.end(); // client left during generation — don't continue

    const apiName = normalizeIncomingApiName({
      artifactXml: result.artifactXml,
      artifactType: session.artifactType,
      apiName: result.apiName,
    });

    send("generated", {
      artifactXml:  result.artifactXml,
      artifactApex: result.artifactApex,
      apiName,
      artifactType: session.artifactType,
      plan:         result.plan,
      decisions:    result.decisions,
      checklist:    result.checklist,
      warnings:     result.warnings,
      orgSchema:    session.orgSchema || {},
    });

    if (deploy && result.artifactXml && !clientGone) {
      send("status", { step: "deploying", message: "Deploying to Salesforce..." });

      const deployResult = await deployArtifact({
        artifactXml:  applyDeployDefaults(result.artifactXml, req.user),
        artifactType: session.artifactType,
        apiName:      result.apiName,
        sfClient:     req.sf,
        activate,
      });

      send("deployed", deployResult);
    }

    send("complete", { success: true });

  } catch (err) {
    if (err.name === 'AbortError' || clientGone) {
      console.log(`[generator] Generation aborted for session ${sessionId}`);
    } else {
      console.error("Build error:", err);
      send("error", { message: err.message });
    }
  } finally {
    // Clean up session immediately — don't wait for TTL expiry
    // Exception: keep alive if user will click Deploy separately (no deploy in this call)
    if (!deploy) {
      // Session still needed for the separate /deploy call — keep it
    } else {
      await deleteSession(sessionId).catch(() => {});
    }
  }

  res.end();
});

// ── POST /api/generate/preflight ─────────────────────────────────────────────
// Run local preflight checks without deploying — returns issues + dry run result
router.post("/preflight", requireAuth, withSalesforceClient, async (req, res) => {
  const { artifactXml, artifactType, orgSchema = {} } = req.body;
  const apiName = normalizeIncomingApiName(req.body);
  if (!artifactXml || !artifactType || !apiName)
    return res.status(400).json({ error: "artifactXml, artifactType, and apiName are required" });

  try {
    const result = await runDeployLoop({
      artifactXml, artifactType, apiName, orgSchema,
      sfClient:   req.sf,
      realDeploy: false,
    });
    res.json(result);
  } catch (err) {
    console.error("Preflight error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/generate/deploy ─────────────────────────────────────────────────
// Full deploy loop: preflight → dry run → repair → real deploy
router.post("/deploy", requireAuth, withSalesforceClient, async (req, res) => {
  const { artifactXml, artifactType, activate = false, orgSchema = {} } = req.body;
  const apiName = normalizeIncomingApiName(req.body);

  if (!artifactXml || !artifactType || !apiName) {
    return res.status(400).json({ error: "artifactXml, artifactType, and apiName are required" });
  }

  try {
    const deploymentRunId = await createDeploymentRun({
      userId: req.user.id,
      orgId: req.orgConn.id,
      metadataType: artifactType,
      componentName: apiName,
      requestedAction: activate ? "deploy_and_activate" : "deploy",
      currentStage: DEPLOYMENT_STATES.PREFLIGHT_RUNNING,
      finalDeployConfirmed: true,
    });

    const artifactId = await recordGeneratedArtifact({
      deploymentRunId,
      metadataType: artifactType,
      componentName: apiName,
      artifactXml,
      generatedSummary: "Artifact submitted to deploy loop.",
    });

    const result = await runDeployLoop({
      artifactXml, artifactType, apiName, orgSchema,
      sfClient:   req.sf,
      realDeploy: true,
      activate,
    });

    if (result.finalXml && result.finalXml !== artifactXml) {
      await recordArtifactVersion({
        artifactId,
        versionNumber: 2,
        changeReason: `Auto-repair during ${result.stage || "deploy loop"}`,
        diffFromPrevious: "Artifact changed by SF Copilot deploy loop auto-repair.",
        artifactXml: result.finalXml,
      });
    }

    const allClassified = [
      ...(result.classified || []),
      ...(result.remainingClassified || []),
    ];
    await recordDeploymentErrors({
      deploymentRunId,
      stage: result.stage,
      classified: allClassified,
    });
    for (const classified of allClassified) {
      await rememberDeployFailure({
        userId: req.user.id,
        orgId: req.orgConn.id,
        metadataType: artifactType,
        classifiedError: classified,
        repairSucceeded: Boolean(result.success && result.repairedIssues),
      });
    }
    await finalizeDeploymentRun({
      deploymentRunId,
      result,
      dryRunPassed: Boolean(result.dryRun?.success || result.dryRun2?.success),
      summary: {
        stage: result.stage,
        success: result.success,
        readyToDeploy: result.readyToDeploy,
        repairedIssues: result.repairedIssues || 0,
      },
    });

    // If loop says it needs Claude to repair, call repairGeneratedArtifact
    if (!result.success && result.needsClaudeRepair && result.repairHints?.length) {
      console.log('[deploy] Claude repair needed for:', result.repairHints);
      try {
        const repaired = await repairGeneratedArtifact({
          artifactXml:  result.finalXml,
          artifactType,
          apiName:      result.finalName,
          deployError:  { message: result.repairHints.join('\n') },
          orgSchema,
        });

        if (repaired.artifactXml) {
          // Re-run the loop with repaired XML
          const retryResult = await runDeployLoop({
            artifactXml: repaired.artifactXml,
            artifactType,
            apiName:     repaired.apiName || result.finalName,
            orgSchema,
            sfClient:    req.sf,
            realDeploy:  true,
            activate,
          });
          await recordArtifactVersion({
            artifactId,
            versionNumber: 3,
            changeReason: "Claude repair after classified dry-run failure",
            diffFromPrevious: "Rebuilt artifact from deploy error hints.",
            artifactXml: repaired.artifactXml,
          });
          await recordDeploymentErrors({
            deploymentRunId,
            stage: retryResult.stage,
            classified: retryResult.classified || [],
          });
          for (const classified of retryResult.classified || []) {
            await rememberDeployFailure({
              userId: req.user.id,
              orgId: req.orgConn.id,
              metadataType: artifactType,
              classifiedError: classified,
              repairSucceeded: Boolean(retryResult.success),
            });
          }
          await finalizeDeploymentRun({
            deploymentRunId,
            result: retryResult,
            dryRunPassed: Boolean(retryResult.dryRun?.success || retryResult.dryRun2?.success),
            summary: {
              stage: retryResult.stage,
              success: retryResult.success,
              claudeRepairAttempted: true,
            },
          });
          return res.json({ ...retryResult, claudeRepairAttempted: true, repairedXml: repaired.artifactXml });
        }
      } catch (repairErr) {
        console.error('[deploy] Claude repair failed:', repairErr.message);
      }
    }

    res.json(result);
  } catch (err) {
    console.error("Deploy error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/generate/session/:sessionId ─────────────────────────────────────
// Get current session state (for page refresh recovery)
router.get("/session/:sessionId", requireAuth, async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session || session.userId !== req.user.id) {
    return res.status(404).json({ error: "Session not found" });
  }
  // Return safe subset — no tokens
  res.json({
    sessionId:    session.sessionId,
    phase:        session.phase,
    artifactType: session.artifactType,
    readyToGenerate: session.readyToGenerate,
  });
});

module.exports = router;
