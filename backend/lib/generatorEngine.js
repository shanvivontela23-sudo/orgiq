/**
 * generatorEngine.js
 *
 * Orchestrates the two-phase generation pipeline:
 * Phase 1 — Interrogator (ask questions)
 * Phase 2 — Generator (build + deploy)
 *
 * Used by all artifact types: Flow, Report, Apex, ValidationRule, PermissionSet
 */

const Anthropic = require("@anthropic-ai/sdk");
const { buildInterrogatorPrompt, buildInterrogatorUserMessage } = require("../prompts/interrogatorPrompt");
const { buildGeneratorPrompt, buildGeneratorUserMessage } = require("../prompts/generatorPrompt");
const { getBestPractices } = require("../prompts/bestPractices");
const { deployArtifact } = require("./metadataDeployer");
const { getOrgSchemaContext } = require("./schemaContext");

const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY from env

// ─── PHASE 1: INTERROGATOR ────────────────────────────────────────────────────

/**
 * Start a new generation session.
 * Returns Claude's clarifying questions.
 * Does NOT generate anything yet.
 *
 * @param {object} params
 * @param {string} params.userInput - The user's requirement (any form)
 * @param {string} params.inputType - 'english' | 'workflowRule' | 'processBulder' | 'apexClass' | 'reportXml'
 * @param {string} params.artifactType - 'flow' | 'report' | 'apex' | 'validationRule' | 'permissionSet' | null
 * @param {string} params.orgId - Connected org ID (for schema context)
 * @param {string} params.userId - OrgIQ user ID
 */
async function startGeneration({ userInput, inputType, artifactType, orgId, userId, sfClient }) {
  // Load relevant schema context from org
  const orgSchema = await getOrgSchemaContext(orgId, userInput, artifactType, sfClient);

  // Build Phase 1 system prompt
  const systemPrompt = buildInterrogatorPrompt(orgSchema, artifactType);
  const userMessage  = buildInterrogatorUserMessage(userInput, inputType);

  // Call Claude — Phase 1
  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2000,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userMessage }],
  });

  const questions = response.content[0].text;

  // Return session state — caller stores this (Redis or DB)
  return {
    sessionId:     generateSessionId(),
    phase:         1,
    orgId,
    userId,
    inputType,
    artifactType:  artifactType || detectArtifactType(questions), // Claude may identify it
    originalInput: userInput,
    orgSchema,
    conversationHistory: [
      { role: "user",      content: userMessage },
      { role: "assistant", content: questions },
    ],
    questions, // what to show in the UI
  };
}

/**
 * Continue the conversation — user answered questions.
 * If more questions needed: returns follow-up questions.
 * If ready to generate: moves to Phase 2.
 *
 * @param {object} session - The session state from startGeneration or previous continueGeneration
 * @param {string} userAnswer - User's answers to the questions
 */
async function continueGeneration(session, userAnswer) {
  // Add user's answer to conversation history
  const updatedHistory = [
    ...session.conversationHistory,
    { role: "user", content: userAnswer },
  ];

  const readinessBestPractices = session.artifactType
    ? getBestPractices(session.artifactType)
    : "";

  // Check if we have enough information to generate
  // Ask Claude to decide: more questions OR ready to generate
  const readinessCheck = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 250,
    system:     `You are evaluating whether enough information has been gathered to generate a Salesforce artifact.
Respond with ONLY 'READY' or 'MORE_QUESTIONS'.

Before saying READY, verify that all artifact-specific best-practice questions are answered, including governor limits, scale, security, sharing, error handling, testing, deploy behavior, and production-risk scenarios.

Artifact-specific best practices:
${readinessBestPractices}`,
    messages:   [
      {
        role:    "user",
        content: `Original requirement: ${session.originalInput}\n\nConversation so far:\n${updatedHistory.map(t => `${t.role}: ${t.content}`).join("\n\n")}\n\nDo we have enough information to generate a production-ready ${session.artifactType}? Consider object names, field names, trigger/report conditions, run context, sharing/security, governor limits, bulk volume, row counts, loops, SOQL/Get Records, DML, callouts, CPU/heap, report performance, error/fault handling, testing, deployment risk, and every relevant best-practice question.`,
      },
    ],
  });

  const isReady = readinessCheck.content[0].text.trim() === "READY";

  if (!isReady) {
    // Need more information — continue Phase 1
    const followUpResponse = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 1500,
      system:     buildInterrogatorPrompt(session.orgSchema, session.artifactType),
      messages:   updatedHistory,
    });

    const followUpQuestions = followUpResponse.content[0].text;

    return {
      ...session,
      phase: 1,
      conversationHistory: [
        ...updatedHistory,
        { role: "assistant", content: followUpQuestions },
      ],
      questions:   followUpQuestions,
      readyToGenerate: false,
    };
  }

  // Ready — return updated session with flag
  return {
    ...session,
    phase: 2,
    conversationHistory: updatedHistory,
    readyToGenerate: true,
  };
}

// ─── PHASE 2: GENERATOR ───────────────────────────────────────────────────────

/**
 * Generate the artifact and optionally deploy it.
 *
 * @param {object} session - Session state with full conversation history
 * @param {object} deployOptions
 * @param {boolean} deployOptions.deploy - Whether to deploy immediately
 * @param {string}  deployOptions.targetOrgId - Which org to deploy to (may differ from source)
 * @param {boolean} deployOptions.activate - Whether to activate after deploy (Flows only)
 * @param {object}  sfClient - Authenticated SalesforceClient instance
 */
async function generateArtifact(session, deployOptions = {}, sfClient = null) {
  const { artifactType, originalInput, inputType, conversationHistory, orgSchema } = session;

  // Build Phase 2 prompt
  const systemPrompt = buildGeneratorPrompt(artifactType, orgSchema);
  const userMessage  = buildGeneratorUserMessage({
    originalInput,
    inputType,
    conversationHistory,
    artifactType,
  });

  // Call Claude — Phase 2 — generate the artifact
  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 4000,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userMessage }],
  });

  const fullResponse = response.content[0].text;

  // Parse the structured response
  const parsed = parseGeneratorResponse(fullResponse, artifactType);

  // If deploy requested and sfClient provided
  let deployResult = null;
  if (deployOptions.deploy && sfClient && parsed.artifactXml) {
    deployResult = await deployArtifact({
      artifactXml:  parsed.artifactXml,
      artifactType,
      apiName:      parsed.apiName,
      sfClient,
      activate:     deployOptions.activate || false,
    });
  }

  return {
    ...parsed,
    deployResult,
    sessionId: session.sessionId,
  };
}

async function repairGeneratedArtifact({
  artifactXml,
  artifactType,
  apiName,
  deployError,
  orgSchema = null,
}) {
  const systemPrompt = `You are OrgIQ's Salesforce metadata repair engine.
Repair the generated Salesforce ${artifactType} artifact so it deploys through Metadata API.

Rules:
- Return the same structured sections as the generator.
- In GENERATED ARTIFACT, return one complete deployable XML code block.
- Preserve the user's intended behavior. Only change what is needed to fix deployment.
- Apply Salesforce metadata limits deterministically:
  - ValidationRule description must be 255 characters or less.
  - XML text nodes must escape &, <, and >.
  - ValidationRule formulas must not include /* */ comments.
  - ValidationRule fullName must include the owning object when known, e.g. Account.Rule_Name.
- Do not introduce placeholders.

Org schema context:
${orgSchema ? JSON.stringify(orgSchema, null, 2) : ""}`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2500,
    system:     systemPrompt,
    messages:   [{
      role: "user",
      content: `API name: ${apiName}

Salesforce deploy error:
${JSON.stringify(deployError, null, 2)}

Artifact XML to repair:
\`\`\`xml
${artifactXml}
\`\`\`

Return the corrected artifact now.`,
    }],
  });

  return parseGeneratorResponse(response.content[0].text, artifactType);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Parse Claude's structured generator response into components
 */
function parseGeneratorResponse(fullResponse, artifactType) {
  // Extract XML/code block
  const xmlMatch = fullResponse.match(/```xml\n([\s\S]*?)```/);
  const apexMatch = fullResponse.match(/```apex\n([\s\S]*?)```/);

  const artifactXml  = xmlMatch?.[1]?.trim() || null;
  const artifactApex = apexMatch?.[1]?.trim() || null;

  // Extract API name from XML
  let apiName = null;
  if (artifactXml) {
    const nameMatch = artifactXml.match(/<fullName>(.*?)<\/fullName>/);
    const labelMatch = artifactXml.match(/<label>(.*?)<\/label>/);
    apiName = nameMatch?.[1] || labelMatch?.[1]?.replace(/\s+/g, "_") || "OrgIQ_Generated";
  }

  // Extract sections
  const sections = {
    plan:      extractSection(fullResponse, "GENERATION PLAN"),
    decisions: extractSection(fullResponse, "DECISION LOG"),
    checklist: extractSection(fullResponse, "PRE-DEPLOY CHECKLIST"),
    warnings:  extractSection(fullResponse, "WARNINGS"),
  };

  return {
    artifactXml,
    artifactApex,
    apiName,
    fullResponse,
    ...sections,
  };
}

/**
 * Extract a named section from Claude's response
 */
function extractSection(text, sectionName) {
  const regex = new RegExp(`###\\s*${sectionName}[\\s\\S]*?(?=###|$)`, "i");
  const match = text.match(regex);
  return match ? match[0].replace(/###\s*[A-Z\s]+\n/, "").trim() : null;
}

/**
 * Detect artifact type from Claude's interrogation response
 * (when user didn't specify)
 */
function detectArtifactType(claudeResponse) {
  const lower = claudeResponse.toLowerCase();
  if (lower.includes("record-triggered flow") || lower.includes("screen flow")) return "flow";
  if (lower.includes("apex trigger") || lower.includes("apex class")) return "apex";
  if (lower.includes("report")) return "report";
  if (lower.includes("validation rule")) return "validationRule";
  if (lower.includes("permission set")) return "permissionSet";
  return null;
}

function generateSessionId() {
  return `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  startGeneration,
  continueGeneration,
  generateArtifact,
  repairGeneratedArtifact,
};
