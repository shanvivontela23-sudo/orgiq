/**
 * test_generator.js
 *
 * End-to-end test of the OrgIQ generation pipeline.
 * Tests Phase 1 (interrogator) and Phase 2 (generator) directly.
 * No web server, Redis, or Salesforce org needed.
 *
 * Run: node test_generator.js
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { buildInterrogatorPrompt, buildInterrogatorUserMessage } = require('./prompts/interrogatorPrompt');
const { buildGeneratorPrompt, buildGeneratorUserMessage } = require('./prompts/generatorPrompt');

const anthropic = new Anthropic();
const MODEL = 'claude-sonnet-4-6';

// ── Test requirement ──────────────────────────────────────────────────────────
const TEST_INPUT = "When an Opportunity is moved to Closed Won, automatically create a follow-up Task assigned to the Opportunity owner due in 7 days.";
const ARTIFACT_TYPE = 'flow';

// Minimal mock org schema — enough for Claude to work with
const MOCK_SCHEMA = {
  Opportunity: {
    objectApiName: 'Opportunity',
    objectLabel: 'Opportunity',
    fields: [
      { apiName: 'Id', label: 'Opportunity ID', type: 'id', required: true, picklist: [], referenceTo: [] },
      { apiName: 'Name', label: 'Opportunity Name', type: 'string', required: true, picklist: [], referenceTo: [] },
      { apiName: 'StageName', label: 'Stage', type: 'picklist', required: true, picklist: ['Prospecting','Qualification','Proposal/Price Quote','Negotiation/Review','Closed Won','Closed Lost'], referenceTo: [] },
      { apiName: 'CloseDate', label: 'Close Date', type: 'date', required: true, picklist: [], referenceTo: [] },
      { apiName: 'OwnerId', label: 'Owner ID', type: 'reference', required: true, picklist: [], referenceTo: ['User'] },
      { apiName: 'AccountId', label: 'Account ID', type: 'reference', required: false, picklist: [], referenceTo: ['Account'] },
      { apiName: 'Amount', label: 'Amount', type: 'currency', required: false, picklist: [], referenceTo: [] },
    ]
  },
  Task: {
    objectApiName: 'Task',
    objectLabel: 'Task',
    fields: [
      { apiName: 'Subject', label: 'Subject', type: 'string', required: true, picklist: [], referenceTo: [] },
      { apiName: 'OwnerId', label: 'Assigned To', type: 'reference', required: true, picklist: [], referenceTo: ['User'] },
      { apiName: 'WhatId', label: 'Related To', type: 'reference', required: false, picklist: [], referenceTo: ['Opportunity'] },
      { apiName: 'ActivityDate', label: 'Due Date', type: 'date', required: false, picklist: [], referenceTo: [] },
      { apiName: 'Status', label: 'Status', type: 'picklist', required: true, picklist: ['Not Started','In Progress','Completed','Waiting on someone else','Deferred'], referenceTo: [] },
      { apiName: 'Priority', label: 'Priority', type: 'picklist', required: true, picklist: ['High','Normal','Low'], referenceTo: [] },
    ]
  }
};

// ── Simulated answers for Phase 1 questions ───────────────────────────────────
// In production the user answers these in the UI. Here we hardcode good answers.
const SIMULATED_ANSWERS = `
1. Trigger: After Save (we need to create a Task, which is a different record)
2. Trigger condition: Only when StageName changes TO "Closed Won" (not every save)
3. Task subject: "Follow-up after Closed Won: {Opportunity Name}"
4. Task assigned to: Opportunity OwnerId
5. Task due date: Today + 7 days
6. Task status: Not Started
7. Task priority: High
8. Link task to opportunity: Yes, set WhatId = Opportunity Id
9. Should this run on existing records that are already Closed Won: No, only new transitions
10. No additional filters needed — apply to all Opportunity record types
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────
function section(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function check(label, value) {
  const pass = !!value;
  console.log(`  ${pass ? '✅' : '❌'} ${label}`);
  return pass;
}

// ── Main test ─────────────────────────────────────────────────────────────────
async function runTest() {
  console.log('\n🧪 OrgIQ Generator Pipeline Test');
  console.log(`   Model: ${MODEL}`);
  console.log(`   Input: "${TEST_INPUT}"`);

  // ── PHASE 1: INTERROGATOR ─────────────────────────────────────────────────
  section('PHASE 1: INTERROGATOR');
  console.log('  Calling Claude for clarifying questions...\n');

  const systemP1 = buildInterrogatorPrompt(MOCK_SCHEMA, ARTIFACT_TYPE);
  const userP1   = buildInterrogatorUserMessage(TEST_INPUT, 'english');

  const p1Start = Date.now();
  const p1Response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 2000,
    system:     systemP1,
    messages:   [{ role: 'user', content: userP1 }],
  });
  const p1Ms = Date.now() - p1Start;

  const questions = p1Response.content[0].text;
  console.log('  Claude asked:\n');
  console.log(questions.split('\n').map(l => '  ' + l).join('\n'));
  console.log(`\n  ⏱  ${p1Ms}ms | ~${p1Response.usage.output_tokens} output tokens`);

  // Validate Phase 1
  section('PHASE 1 VALIDATION');
  let p1Pass = 0;
  p1Pass += check('Response is non-empty', questions.length > 100);
  p1Pass += check('Did NOT generate XML (interrogator should ask, not build)', !questions.includes('<?xml') && !questions.includes('<Flow'));
  p1Pass += check('Asks about trigger timing (before/after save)', questions.toLowerCase().includes('after') || questions.toLowerCase().includes('before') || questions.toLowerCase().includes('trigger'));
  p1Pass += check('Mentions bulkification or bulk considerations', questions.toLowerCase().includes('bulk') || questions.toLowerCase().includes('multiple') || questions.toLowerCase().includes('collection'));
  p1Pass += check('Mentions fault path or error handling', questions.toLowerCase().includes('fault') || questions.toLowerCase().includes('error') || questions.toLowerCase().includes('fail'));
  console.log(`\n  Result: ${p1Pass}/5 checks passed`);

  // Build conversation history for Phase 2
  const conversationHistory = [
    { role: 'user',      content: userP1 },
    { role: 'assistant', content: questions },
    { role: 'user',      content: SIMULATED_ANSWERS },
  ];

  // ── PHASE 2: GENERATOR ────────────────────────────────────────────────────
  section('PHASE 2: GENERATOR');
  console.log('  Calling Claude to generate the Flow XML...\n');

  const systemP2 = buildGeneratorPrompt(ARTIFACT_TYPE, MOCK_SCHEMA);
  const userP2   = buildGeneratorUserMessage({
    originalInput:       TEST_INPUT,
    inputType:           'english',
    conversationHistory,
    artifactType:        ARTIFACT_TYPE,
  });

  const p2Start = Date.now();
  const p2Response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 4000,
    system:     systemP2,
    messages:   [{ role: 'user', content: userP2 }],
  });
  const p2Ms = Date.now() - p2Start;

  const fullResponse = p2Response.content[0].text;

  // Extract XML
  const xmlMatch  = fullResponse.match(/```xml\n([\s\S]*?)```/);
  const artifactXml = xmlMatch?.[1]?.trim() || null;

  // ── PHASE 2 VALIDATION ────────────────────────────────────────────────────
  section('PHASE 2 VALIDATION');
  let p2Pass = 0;
  p2Pass += check('Response is non-empty', fullResponse.length > 200);
  p2Pass += check('Contains XML code block', !!artifactXml);
  p2Pass += check('XML has <Flow xmlns> tag', artifactXml?.includes('<Flow xmlns'));
  p2Pass += check('XML has correct API version (59.0)', artifactXml?.includes('59.0'));
  p2Pass += check('Status is Draft (not Active)', artifactXml?.includes('<status>Draft</status>'));
  p2Pass += check('Trigger type is RecordAfterSave (creating another record)', artifactXml?.includes('RecordAfterSave'));
  p2Pass += check('References Opportunity object', artifactXml?.includes('Opportunity'));
  p2Pass += check('Has Create Records element for Task', artifactXml?.includes('createRecords') || artifactXml?.includes('Create_Task') || artifactXml?.includes('recordCreates'));
  p2Pass += check('Has fault connector (error handling)', artifactXml?.includes('faultConnector') || artifactXml?.includes('faultPath'));
  p2Pass += check('Has GENERATION PLAN section', fullResponse.includes('GENERATION PLAN'));
  p2Pass += check('Has DECISION LOG section', fullResponse.includes('DECISION LOG'));
  p2Pass += check('Has PRE-DEPLOY CHECKLIST section', fullResponse.includes('PRE-DEPLOY CHECKLIST'));
  console.log(`\n  Result: ${p2Pass}/12 checks passed`);
  console.log(`  ⏱  ${p2Ms}ms | ~${p2Response.usage.output_tokens} output tokens`);

  // ── PRINT GENERATED XML ───────────────────────────────────────────────────
  if (artifactXml) {
    section('GENERATED FLOW XML (first 80 lines)');
    artifactXml.split('\n').slice(0, 80).forEach(l => console.log('  ' + l));
    if (artifactXml.split('\n').length > 80) console.log('  ... (truncated)');
  } else {
    section('⚠️  NO XML EXTRACTED');
    console.log('  Full response snippet:');
    console.log(fullResponse.slice(0, 500));
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  section('SUMMARY');
  const totalPass = p1Pass + p2Pass;
  const totalChecks = 5 + 12;
  console.log(`  Phase 1: ${p1Pass}/5`);
  console.log(`  Phase 2: ${p2Pass}/12`);
  console.log(`  Total:   ${totalPass}/${totalChecks}`);
  console.log(`  Status:  ${totalPass >= 15 ? '🟢 PASS' : totalPass >= 12 ? '🟡 PARTIAL' : '🔴 FAIL'}\n`);
}

runTest().catch(err => {
  console.error('\n❌ Test crashed:', err.message);
  if (err.status) console.error('   API status:', err.status);
  process.exit(1);
});
