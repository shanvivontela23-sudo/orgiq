'use strict';
/**
 * test-skills.js
 * Calls the repair function with deliberately broken XMLs.
 * Each test has a known wrong value and a known correct value.
 * Run: node test-skills.js
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { skillForType, formatSkillBlock } = require('./lib/skillLoader');

const anthropic = new Anthropic();

const TESTS = [
  {
    name: 'Flow — wrong processType (Workflow → AutoLaunchedFlow)',
    metadataType: 'flow',
    errors: ['The process type is not supported for this trigger type', 'Invalid enum value: Workflow for field processType'],
    wrong: 'Workflow',
    correct: 'AutoLaunchedFlow',
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <processType>Workflow</processType>
  <start>
    <locationX>176</locationX>
    <locationY>0</locationY>
    <object>Account</object>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
  <status>Draft</status>
  <label>Update Account Rating</label>
</Flow>`,
  },
  {
    name: 'Flow — wrong triggerType enum (AfterSave → RecordAfterSave)',
    metadataType: 'flow',
    errors: ['Invalid enum value: AfterSave for field triggerType'],
    wrong: '<triggerType>AfterSave</triggerType>',
    correct: 'RecordAfterSave',
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <processType>AutoLaunchedFlow</processType>
  <start>
    <locationX>176</locationX>
    <locationY>0</locationY>
    <object>Opportunity</object>
    <recordTriggerType>Create</recordTriggerType>
    <triggerType>AfterSave</triggerType>
  </start>
  <status>Draft</status>
  <label>New Opp Flow</label>
</Flow>`,
  },
  {
    name: 'Validation Rule — unescaped < in formula (Amount < 0)',
    metadataType: 'validationRule',
    errors: ['Error parsing field: errorConditionFormula', 'XML parse error near "<"'],
    wrong: 'Amount < 0',
    correct: 'Amount &lt; 0',
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Opportunity.Negative_Amount</fullName>
  <active>true</active>
  <description>Block negative amounts</description>
  <errorConditionFormula>Amount < 0</errorConditionFormula>
  <errorMessage>Amount cannot be negative.</errorMessage>
</ValidationRule>`,
  },
  {
    name: 'Custom Field — TextFormula type (→ Text for text-returning formula)',
    metadataType: 'CustomField',
    errors: ['Invalid type: TextFormula', 'Invalid field type: TextFormula'],
    wrong: 'TextFormula',
    correct: 'Text',
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <fields>
    <fullName>Full_Name__c</fullName>
    <label>Full Name</label>
    <type>TextFormula</type>
    <formula>FirstName &amp; " " &amp; LastName</formula>
    <formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>
  </fields>
</CustomObject>`,
  },
  {
    name: 'Custom Field — missing precision/scale on Currency',
    metadataType: 'CustomField',
    errors: ['Field Annual_Revenue__c: Precision and Scale required for field type Currency'],
    wrong: null,
    correct: '<precision>',
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <fields>
    <fullName>Annual_Revenue__c</fullName>
    <label>Annual Revenue</label>
    <type>Currency</type>
  </fields>
</CustomObject>`,
  },
];

async function repairXml({ metadataType, xml, errors, context }) {
  const skill = skillForType(metadataType);
  const skillBlock = formatSkillBlock(skill);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `You repair Salesforce Metadata API XML for SF Copilot.
${skillBlock}
Rules:
- Return ONLY one complete XML document in a fenced xml code block.
- Preserve the user's intent and metadata member name.
- Fix only what is needed for the Salesforce deploy error.
- Use Metadata API v62.0-compatible XML.`,
    messages: [{
      role: 'user',
      content: `Metadata type: ${metadataType}

Salesforce deploy errors:
${errors.join('\n')}

XML to repair:
\`\`\`xml
${xml}
\`\`\``,
    }],
  });

  const text = response.content?.[0]?.text || '';
  const match = text.match(/```xml\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || text;
}

async function run() {
  console.log('='.repeat(60));
  console.log('SF Copilot — Skill Repair Tests');
  console.log('='.repeat(60));

  let passed = 0, failed = 0;

  for (const test of TESTS) {
    process.stdout.write(`\n▶ ${test.name}\n`);
    try {
      const repaired = await repairXml({
        metadataType: test.metadataType,
        xml: test.xml,
        errors: test.errors,
      });

      const stillHasWrong = test.wrong && repaired.includes(test.wrong);
      const hasCorrect    = repaired.includes(test.correct);

      if (!stillHasWrong && hasCorrect) {
        console.log(`  ✅ PASS — wrong value gone, correct value present`);
        // Show the relevant fixed line
        const fixedLine = repaired.split('\n').find(l => l.includes(test.correct));
        if (fixedLine) console.log(`  → ${fixedLine.trim()}`);
        passed++;
      } else {
        console.log(`  ❌ FAIL`);
        if (stillHasWrong) console.log(`  → Wrong value "${test.wrong}" still present`);
        if (!hasCorrect)   console.log(`  → Expected "${test.correct}" not found in output`);
        // Print relevant XML snippet
        const lines = repaired.split('\n').slice(0, 20);
        console.log('  Output (first 20 lines):');
        lines.forEach(l => console.log('    ' + l));
        failed++;
      }
    } catch (err) {
      console.log(`  💥 ERROR — ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${TESTS.length} tests`);
  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

run();
