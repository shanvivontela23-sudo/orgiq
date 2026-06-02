/**
 * generator.routes.js
 *
 * API routes for the OrgIQ artifact generator.
 * Uses Server-Sent Events (SSE) to stream Claude's responses in real-time.
 *
 * Mount at: app.use("/api/generate", require("./routes/generator.routes"))
 */

const express  = require("express");
const router   = express.Router();

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
const { requireAuth }       = require("../middleware/auth");
const { withSalesforceClient } = require("../middleware/withSalesforceClient");
const { getSession, saveSession, deleteSession } = require("../lib/sessionStore");

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

function applyDeployDefaults(artifactXml, user) {
  if (!artifactXml || !user?.email) return artifactXml;

  return artifactXml
    .replace(/REPLACE_WITH_ADMIN_EMAIL@yourdomain\.com/gi, user.email)
    .replace(/admin@example\.com/gi, user.email);
}

// ── POST /api/generate/start ─────────────────────────────────────────────────
// Phase 1: User submits their requirement, Claude asks questions
router.post("/start", requireAuth, withSalesforceClient, async (req, res) => {
  const { userInput, inputType, artifactType } = req.body;

  if (!userInput?.trim()) {
    return res.status(400).json({ error: "userInput is required" });
  }

  try {
    const session = await startGeneration({
      userInput:    userInput.trim(),
      inputType:    inputType || "english",
      artifactType: artifactType || null, // null = Claude detects
      orgId:        req.orgConn.id,
      userId:       req.user.id,
      sfClient:     req.sf,
    });

    // Persist session (Redis, TTL 2 hours)
    await saveSession(session.sessionId, session);

    res.json({
      sessionId: session.sessionId,
      phase:     1,
      questions: session.questions,
      artifactType: session.artifactType,
    });

  } catch (err) {
    console.error("Generation start error:", err);
    res.status(500).json({ error: err.message || "Failed to start generation session" });
  }
});

// ── POST /api/generate/retrieve ───────────────────────────────────────────────
// Retrieve an existing metadata artifact so Claude can revise it.
router.post("/retrieve", requireAuth, withSalesforceClient, async (req, res) => {
  const { artifactType, fullName } = req.body;

  if (!artifactType || !fullName?.trim()) {
    return res.status(400).json({ error: "artifactType and fullName are required" });
  }

  if (artifactType !== "validationRule") {
    return res.status(400).json({
      error: "Retrieve/edit currently supports validationRule. Flow, Apex, and Report retrieval are next.",
    });
  }

  try {
    const normalizedFullName = fullName.trim();
    const ruleName = normalizedFullName.includes(".")
      ? normalizedFullName.split(".").pop()
      : normalizedFullName;

    const result = await req.sf.toolingQuery(
      `SELECT Id, FullName, ValidationName, Active, Description, ErrorDisplayField, ErrorMessage, Metadata
       FROM ValidationRule
       WHERE ValidationName = '${escapeSoql(ruleName)}'
       LIMIT 1`
    );

    const record = result.records?.[0];
    if (!record) {
      return res.status(404).json({ error: `Validation rule not found: ${normalizedFullName}` });
    }

    res.json({
      artifactType: "validationRule",
      fullName: record.FullName,
      apiName: record.ValidationName,
      artifactXml: validationRuleMetadataToXml(record),
      metadata: record.Metadata,
    });
  } catch (err) {
    console.error("Retrieve artifact error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/generate/answer ─────────────────────────────────────────────────
// User answers Claude's questions — may need more questions or ready to generate
router.post("/answer", requireAuth, async (req, res) => {
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
// Uses SSE to stream progress to the frontend
router.post("/build", requireAuth, withSalesforceClient, async (req, res) => {
  const { sessionId, deploy = false, activate = false } = req.body;

  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  // Set up SSE
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const session = await getSession(sessionId);
    if (!session) { send("error", { message: "Session not found" }); return res.end(); }
    if (session.userId !== req.user.id) { send("error", { message: "Forbidden" }); return res.end(); }

    // Step 1: Generating
    send("status", { step: "generating", message: "Reviewing best practices and generating artifact..." });

    const result = await generateArtifact(
      session,
      { deploy: false }, // generate first, deploy separately for better UX
      req.sf
    );

    // Step 2: Generated — send the result
    send("generated", {
      artifactXml:  result.artifactXml,
      artifactApex: result.artifactApex,
      apiName:      result.apiName,
      artifactType: session.artifactType,   // needed by frontend deploy call
      plan:         result.plan,
      decisions:    result.decisions,
      checklist:    result.checklist,
      warnings:     result.warnings,
    });

    // Step 3: Deploy if requested
    if (deploy && result.artifactXml) {
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

    // Clean up session
    await deleteSession(sessionId);
    send("complete", { success: true });

  } catch (err) {
    console.error("Build error:", err);
    send("error", { message: err.message });
  }

  res.end();
});

// ── POST /api/generate/preflight ─────────────────────────────────────────────
// Run local preflight checks without deploying — returns issues + dry run result
router.post("/preflight", requireAuth, withSalesforceClient, async (req, res) => {
  const { artifactXml, artifactType, apiName, orgSchema = {} } = req.body;
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
  const { artifactXml, artifactType, apiName, activate = false, orgSchema = {} } = req.body;

  if (!artifactXml || !artifactType || !apiName) {
    return res.status(400).json({ error: "artifactXml, artifactType, and apiName are required" });
  }

  try {
    const result = await runDeployLoop({
      artifactXml, artifactType, apiName, orgSchema,
      sfClient:   req.sf,
      realDeploy: true,
      activate,
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
