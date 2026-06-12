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
const { getOrgSchemaContext }    = require("./schemaContext");
const { getOrgMetadataContext }  = require("./orgMetadata");

const { buildContext } = require('./brain');

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
  // Load schema + org metadata + brain context in parallel
  const [orgSchema, orgMeta, brainContext] = await Promise.all([
    getOrgSchemaContext(orgId, userInput, artifactType, sfClient),
    getOrgMetadataContext(orgId, artifactType, sfClient),
    buildContext({ userId, orgId, query: userInput, limit: 5 }),
  ]);

  // Build Phase 1 system prompt — append brain context if we have memories
  const basePrompt   = buildInterrogatorPrompt(orgSchema, artifactType, orgMeta);
  const systemPrompt = brainContext ? `${basePrompt}\n\n${brainContext}` : basePrompt;
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
    artifactType:  artifactType || detectArtifactType(questions),
    originalInput: userInput,
    orgSchema,
    orgMeta,
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
  // Count how many Q&A rounds have happened — if user already answered a substantive round, trust it.
  const qaRounds = updatedHistory.filter(m => m.role === 'user').length;

  const readinessCheck = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 50,
    system:     `You are evaluating whether enough information has been gathered to generate a Salesforce artifact.
Respond with ONLY the word 'READY' or 'MORE_QUESTIONS'. No other text.

Rules:
- If the user has answered at least one round of clarifying questions covering the core requirements (object, trigger, action, error handling, scale), say READY.
- Only say MORE_QUESTIONS if there is a CRITICAL missing piece that would make the artifact fail or behave incorrectly — not for nice-to-have detail.
- After ${qaRounds >= 2 ? 'two or more rounds of Q&A' : 'a good first round'}, default to READY unless something fundamental is missing.
- Do NOT ask for test coverage, sandbox validation, or production sign-off — those happen at deploy time.`,
    messages:   [
      {
        role:    "user",
        content: `Original requirement: ${session.originalInput}\n\nConversation so far:\n${updatedHistory.map(t => `${t.role}: ${t.content}`).join("\n\n")}\n\nIs there enough information to generate a working ${session.artifactType || 'Salesforce artifact'}? Answer READY or MORE_QUESTIONS only.`,
      },
    ],
  });

  const isReady = readinessCheck.content[0].text.trim().startsWith("READY");

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
  const { artifactType, originalInput, inputType, conversationHistory, orgSchema, orgId, userId } = session;

  // Fetch brain context relevant to this artifact type + input
  const brainContext = await buildContext({ userId, orgId, query: `${artifactType} ${originalInput}`, limit: 4 });

  // Build Phase 2 prompt — inject brain memories so Claude avoids known pitfalls
  const basePrompt   = buildGeneratorPrompt(artifactType, orgSchema);
  const systemPrompt = brainContext ? `${basePrompt}\n\n${brainContext}` : basePrompt;
  const userMessage  = buildGeneratorUserMessage({
    originalInput,
    inputType,
    conversationHistory,
    artifactType,
  });

  // Call Claude — Phase 2 — generate the artifact. Flow XML can be long, so
  // leave enough room for the required plan/checklist sections plus metadata.
  let response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 8000,
    system:     systemPrompt, // includes brain context if available
    messages:   [{ role: "user", content: userMessage }],
  });

  let fullResponse = response.content[0].text;

  // Parse the structured response. If Claude returned the plan but omitted the
  // artifact, retry once with a narrow correction prompt instead of handing the
  // frontend an undeployable result.
  let parsed = parseGeneratorResponse(fullResponse, artifactType);
  if (!parsed.artifactXml && !parsed.artifactApex) {
    response = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 8000,
      system:     systemPrompt,
      messages:   [
        { role: "user", content: userMessage },
        { role: "assistant", content: fullResponse },
        {
          role: "user",
          content: `Your previous response did not include the required complete ${artifactType} artifact code block.

Return the full structured response again. The ### GENERATED ARTIFACT section is mandatory and must include one complete deployable ${artifactType === "apex" ? "Apex" : "XML"} code block. Do not return a plan-only response.`,
        },
      ],
    });
    fullResponse = response.content[0].text;
    parsed = parseGeneratorResponse(fullResponse, artifactType);
  }

  if (!parsed.artifactXml && !parsed.artifactApex) {
    response = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 8000,
      system:     buildArtifactOnlyPrompt(artifactType, orgSchema),
      messages:   [{
        role: "user",
        content: `Generate ONLY the complete deployable ${artifactType === "apex" ? "Apex code" : "Salesforce metadata XML"} for this request.

Do not include a plan, markdown headings, tables, explanations, decision logs, or checklist text.
Return exactly one fenced ${artifactType === "apex" ? "apex" : "xml"} code block.

Original requirement:
${originalInput}

Clarification Q&A:
${conversationHistory.map((turn) => `${turn.role === "assistant" ? "SF Copilot" : "User"}: ${turn.content}`).join("\n\n")}

The previous plan-only response to convert into deployable metadata:
${fullResponse}`,
      }],
    });
    fullResponse = response.content[0].text;
    parsed = {
      ...parseGeneratorResponse(fullResponse, artifactType),
      plan: parsed.plan,
      decisions: parsed.decisions,
      checklist: parsed.checklist,
      warnings: parsed.warnings,
    };
  }

  if (!parsed.artifactXml && !parsed.artifactApex) {
    throw new Error("Generation failed: Claude returned a plan but no deployable artifact XML/code. Please try again.");
  }

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
  - Flow API names and <fullName> values must be one namespace-safe developer name:
    letters, numbers, and single underscores only. No dots, hyphens, spaces, or
    repeated double/triple underscores.
  - Flow XML must not include invalid elements such as <noMoreValuesToProcess>.
  - Flow XML comments are not needed; remove them if they risk invalid metadata.
  - Report metadata must deploy under a folder-qualified member name such as
    unfiled$public/Report_API_Name.
  - Report XML must include a valid <reportType> for the target org and should
    use Salesforce report column names, not guessed object field labels.
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
  const normalizedArtifactType = String(artifactType || "").toLowerCase();
  // Extract XML — try multiple fence formats Claude might use
  const xmlMatch =
    fullResponse.match(/```xml\n([\s\S]*?)```/i) ||       // ```xml
    fullResponse.match(/```XML\n([\s\S]*?)```/) ||         // ```XML
    fullResponse.match(/```\n(<\?xml[\s\S]*?)```/) ||      // ``` starting with <?xml
    fullResponse.match(/(<\?xml[\s\S]*?<\/(?:Flow|ValidationRule|Report|CustomField|PermissionSet|ApexClass|FlexiPage)>)/); // bare XML

  const apexMatch = fullResponse.match(/```apex\n([\s\S]*?)```/i) ||
    fullResponse.match(/```java\n([\s\S]*?)```/i);

  const artifactXml  = xmlMatch?.[1]?.trim() || null;
  const artifactApex = apexMatch?.[1]?.trim() || null;

  if (!artifactXml && !artifactApex) {
    console.warn('[generator] parseGeneratorResponse: no XML/Apex block found. Response preview:', fullResponse.slice(0, 300));
  } else {
    console.log('[generator] Parsed artifact — XML:', artifactXml ? `${artifactXml.length} chars` : 'none', '| Apex:', artifactApex ? `${artifactApex.length} chars` : 'none');
  }

  // Extract API name from XML
  let apiName = null;
  if (artifactXml) {
    const fullNameMatch = artifactXml.match(/<fullName>(.*?)<\/fullName>/);
    const reportNameMatch = artifactXml.match(/<name>(.*?)<\/name>/);
    const labelMatch = artifactXml.match(/<label>(.*?)<\/label>/);
    const isFlowXml = normalizedArtifactType === "flow" || /<Flow\b/i.test(artifactXml);
    if (isFlowXml) {
      apiName = fullNameMatch?.[1] || toDeveloperName(labelMatch?.[1]) || "OrgIQ_Generated_Flow";
    } else {
      apiName = fullNameMatch?.[1] || reportNameMatch?.[1] || toDeveloperName(labelMatch?.[1]) || "OrgIQ_Generated";
    }
  }

  // Extract sections
  const sections = {
    plan:      compactSection(extractSection(fullResponse, "GENERATION PLAN"), 650),
    decisions: compactSection(extractSection(fullResponse, "DECISION LOG"), 800),
    checklist: compactSection(extractSection(fullResponse, "PRE-DEPLOY CHECKLIST"), 900),
    warnings:  compactSection(extractSection(fullResponse, "WARNINGS"), 900),
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

function compactSection(text, maxChars) {
  if (!text) return null;
  const normalized = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, maxChars);
  const boundary = Math.max(clipped.lastIndexOf("\n"), clipped.lastIndexOf(". "));
  return `${clipped.slice(0, boundary > 160 ? boundary + 1 : maxChars).trim()}...`;
}

function buildArtifactOnlyPrompt(artifactType, orgSchema) {
  return `You are SF Copilot's Salesforce metadata generation engine.

Return only one complete deployable artifact code block. No prose.

Artifact type: ${artifactType}
API version: 59.0

Rules:
- Use exact object and field API names from the org schema.
- Do not include placeholders.
- For Flow XML, output a complete <Flow xmlns="http://soap.sforce.com/2006/04/metadata"> document.
- For Flow XML, include <apiVersion>59.0</apiVersion>, <label>, <processType>AutoLaunchedFlow</processType>, <status>Draft</status>, and a valid <start>.
- For record-triggered Flow that creates a related record from $Record, do not invent a $Record collection loop.
- For every DML element, include a faultConnector to a real action/element.

Org schema:
${orgSchema ? JSON.stringify(orgSchema, null, 2) : ""}`;
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

function toDeveloperName(value = "") {
  const normalized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || null;
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
