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

const { startGeneration, continueGeneration, generateArtifact } = require("../lib/generatorEngine");
const { deployArtifact }    = require("../lib/metadataDeployer");
const { requireAuth }       = require("../middleware/auth");
const { withSalesforceClient } = require("../middleware/withSalesforceClient");
const { getSession, saveSession, deleteSession } = require("../lib/sessionStore");

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
        artifactXml:  result.artifactXml,
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

// ── POST /api/generate/deploy ─────────────────────────────────────────────────
// Deploy a previously generated artifact (user reviewed it first)
router.post("/deploy", requireAuth, withSalesforceClient, async (req, res) => {
  const { artifactXml, artifactType, apiName, activate = false } = req.body;

  if (!artifactXml || !artifactType || !apiName) {
    return res.status(400).json({ error: "artifactXml, artifactType, and apiName are required" });
  }

  try {
    const result = await deployArtifact({
      artifactXml,
      artifactType,
      apiName,
      sfClient: req.sf,
      activate,
    });

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
