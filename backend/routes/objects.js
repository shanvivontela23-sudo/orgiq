'use strict';

/**
 * routes/objects.js
 * Custom Object Builder — OBJ-01 to OBJ-04
 *
 * POST /api/objects/create        — create a custom object + optional tab
 * POST /api/objects/add-field     — add a custom field to an existing object
 * GET  /api/objects/list          — list custom objects in the org
 * GET  /api/objects/tab-styles    — list available tab icon styles
 */

const express = require('express');
const router  = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

const { requireAuth }          = require('../middleware/auth');
const { withSalesforceClient } = require('../middleware/withSalesforceClient');
const { withRateLimit }        = require('../lib/rateLimiter');
const { buildDeployPackage, metadataDeployCheckOnly } = require('../lib/metadataDeployer');
const { skillForType, formatSkillBlock } = require('../lib/skillLoader');
const { deployQueue } = require('../workers/queue');
const supabase = require('../lib/supabase');

const SF_API = '/services/data/v62.0';
const SAFE_TAB_STYLE = 'Custom34: Handshaking';
const anthropic = new Anthropic();

// ── Helpers ───────────────────────────────────────────────────────────────────

function toApiName(label = '') {
  const normalized = label.trim()
    .replace(/[^a-zA-Z0-9 _]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return /^[A-Za-z]/.test(normalized) ? normalized : `X${normalized}`;
}

function toCustomFieldName(field = {}) {
  const base = String(field.apiName || `${toApiName(field.label)}__c`)
    .replace(/\..*$/g, '')
    .replace(/__c$/i, '');
  return `${toApiName(base)}__c`;
}

function toRelationshipName(fieldApiName = '') {
  return toApiName(String(fieldApiName).replace(/\..*$/g, '').replace(/__c$/i, ''));
}

function escapeXml(v = '') {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function deployZip(sfClient, zipBuffer, checkOnly = false) {
  const JSZip = require('jszip');
  const axios = require('axios');

  // Convert JSZip buffer to base64
  const base64 = zipBuffer.toString('base64');

  const soapEnv = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:CallOptions><met:client>SFCopilot</met:client></met:CallOptions>
    <met:SessionHeader><met:sessionId>${sfClient.accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:deploy>
      <met:ZipFile>${base64}</met:ZipFile>
      <met:DeployOptions>
        <met:allowMissingFiles>false</met:allowMissingFiles>
        <met:autoUpdatePackage>false</met:autoUpdatePackage>
        <met:checkOnly>${checkOnly}</met:checkOnly>
        <met:ignoreWarnings>true</met:ignoreWarnings>
        <met:performRetrieve>false</met:performRetrieve>
        <met:purgeOnDelete>false</met:purgeOnDelete>
        <met:rollbackOnError>true</met:rollbackOnError>
        <met:singlePackage>true</met:singlePackage>
      </met:DeployOptions>
    </met:deploy>
  </soapenv:Body>
</soapenv:Envelope>`;

  const deployRes = await axios.post(
    `${sfClient.instanceUrl}/services/Soap/m/62.0`,
    soapEnv,
    { headers: { 'Content-Type': 'text/xml', 'SOAPAction': 'deploy' } }
  );

  const asyncIdMatch = deployRes.data.match(/<id>(.*?)<\/id>/);
  const asyncId = asyncIdMatch?.[1];
  if (!asyncId) throw new Error('Deploy failed to start: ' + deployRes.data.slice(0, 500));

  // Poll until done
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusSoap = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${sfClient.accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:checkDeployStatus>
      <met:asyncProcessId>${asyncId}</met:asyncProcessId>
      <met:includeDetails>true</met:includeDetails>
    </met:checkDeployStatus>
  </soapenv:Body>
</soapenv:Envelope>`;

    const statusRes = await axios.post(
      `${sfClient.instanceUrl}/services/Soap/m/62.0`,
      statusSoap,
      { headers: { 'Content-Type': 'text/xml', 'SOAPAction': 'checkDeployStatus' } }
    );

    const xml = statusRes.data;
    const done    = xml.match(/<done>(.*?)<\/done>/)?.[1] === 'true';
    const success = xml.match(/<success>(.*?)<\/success>/)?.[1] === 'true';

    if (!done) continue;

    if (success) return { success: true, asyncId };

    // Extract error messages
    const errorMsgs = [];
    const msgMatches = xml.matchAll(/<message>(.*?)<\/message>/gs);
    for (const m of msgMatches) errorMsgs.push(m[1].trim());
    const problemMatches = xml.matchAll(/<problem>(.*?)<\/problem>/gs);
    for (const m of problemMatches) errorMsgs.push(m[1].trim());

    return { success: false, asyncId, errors: [...new Set(errorMsgs)] };
  }
  throw new Error('Deploy timed out after 3 minutes');
}

async function buildObjectPackage(objectXml, apiName, extraFiles = []) {
  const JSZip = require('jszip');
  const zip = new JSZip();

  const members = [`${apiName}__c`];
  const types = [`<types><members>${apiName}__c</members><name>CustomObject</name></types>`];

  zip.file(`objects/${apiName}__c.object`, objectXml);

  for (const f of extraFiles) {
    zip.file(f.path, f.content);
    if (f.type && f.member) {
      types.push(`<types><members>${f.member}</members><name>${f.type}</name></types>`);
    }
  }

  const pkg = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  ${types.join('\n  ')}
  <version>62.0</version>
</Package>`;
  zip.file('package.xml', pkg);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function buildCustomObjectPackage(objectApiName, objectXml) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file(`objects/${objectApiName}.object`, objectXml);
  zip.file('package.xml', `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>${escapeXml(objectApiName)}</members><name>CustomObject</name></types>
  <version>62.0</version>
</Package>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function buildProfilePackage(profileFiles) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  profileFiles.forEach(({ name, xml }) => {
    zip.file(`profiles/${profileFileName(name)}.profile`, xml);
  });
  zip.file('package.xml', `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    ${profileFiles.map(({ name }) => `<members>${escapeXml(name)}</members>`).join('\n    ')}
    <name>Profile</name>
  </types>
  <version>62.0</version>
</Package>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function repairMetadataXml({ metadataType, xml, errors, context }) {
  const skill = skillForType(metadataType);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: `You repair Salesforce Metadata API XML for SF Copilot.
${formatSkillBlock(skill)}
Rules:
- Return ONLY one complete XML document in a fenced xml code block.
- Preserve the user's intent and metadata member name.
- Do not add placeholders.
- Fix only what is needed for the Salesforce deploy error.
- Use Metadata API 62.0-compatible XML.
- For CustomObject field deploy wrappers, preserve the root <CustomObject> and <fields> structure.
- For Formula fields, <type> is the return type such as Text, Number, Date, DateTime, Checkbox, Currency, or Percent, not TextFormula.
- For CustomTab, use a valid <motif> value.
- For Profile objectPermissions, do not grant View All or Modify All unless they already exist in the XML.`,
    messages: [{
      role: 'user',
      content: `Metadata type: ${metadataType}

Context:
${JSON.stringify(context || {}, null, 2)}

Salesforce deploy errors:
${(errors || []).join('\n')}

XML to repair:
\`\`\`xml
${xml}
\`\`\``,
    }],
  });

  const text = response.content?.[0]?.text || '';
  const xmlMatch = text.match(/```xml\s*([\s\S]*?)```/i) || text.match(/(<\?xml[\s\S]*)/i);
  const repaired = xmlMatch?.[1]?.trim();
  if (!repaired || !repaired.startsWith('<?xml')) {
    throw new Error('Claude repair did not return a complete XML document.');
  }
  return repaired;
}

async function deployWithSingleClaudeRepair({ sfClient, metadataType, xml, buildZip, context }) {
  let result = await deployZip(sfClient, await buildZip(xml));
  if (result.success) return { ...result, repaired: false, finalXml: xml };

  const repairedXml = await repairMetadataXml({
    metadataType,
    xml,
    errors: result.errors || [],
    context,
  });
  const retryResult = await deployZip(sfClient, await buildZip(repairedXml));
  return {
    ...retryResult,
    repaired: retryResult.success,
    repairAttempted: true,
    originalErrors: result.errors || [],
    finalXml: repairedXml,
  };
}

function buildCustomObjectXml({
  label, pluralLabel, apiName,
  nameFieldType = 'Text', nameFieldLabel = 'Name',
  sharingModel = 'ReadWrite',
  enableActivities = true, enableFeeds = false,
  enableReports = true, enableSearch = true,
  enableHistory = false, description = '',
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>${escapeXml(label)}</label>
  <pluralLabel>${escapeXml(pluralLabel)}</pluralLabel>
  <nameField>
    <label>${escapeXml(nameFieldLabel)}</label>
    <type>${nameFieldType === 'AutoNumber' ? 'AutoNumber' : 'Text'}</type>
    ${nameFieldType === 'AutoNumber' ? '<displayFormat>AN-{0000}</displayFormat><startingNumber>1</startingNumber>' : ''}
  </nameField>
  <sharingModel>${sharingModel}</sharingModel>
  <description>${escapeXml(description)}</description>
  <enableActivities>${enableActivities}</enableActivities>
  <enableFeeds>${enableFeeds}</enableFeeds>
  <enableReports>${enableReports}</enableReports>
  <enableSearch>${enableSearch}</enableSearch>
  <enableHistory>${enableHistory}</enableHistory>
  <deploymentStatus>Deployed</deploymentStatus>
</CustomObject>`;
}

function buildCustomFieldXml(field) {
  const {
    apiName, label, type, required = false, unique = false,
    externalId = false, helpText = '', description = '',
    length = 255, precision = 18, scale = 0,
    picklistValues = [], referenceTo = '',
    formula = '', formulaReturnType = 'Text',
  } = field;

  let typeSpecific = '';
  switch (type) {
    case 'Text':
      typeSpecific = `<length>${length}</length>`;
      break;
    case 'Number':
    case 'Currency':
    case 'Percent':
      typeSpecific = `<precision>${precision}</precision><scale>${scale}</scale>`;
      break;
    case 'Picklist':
      typeSpecific = `<valueSet><restricted>false</restricted><valueSetDefinition><sorted>false</sorted>${
        picklistValues.map((v, i) => `<value><fullName>${escapeXml(v)}</fullName><default>${i === 0}</default><label>${escapeXml(v)}</label></value>`).join('')
      }</valueSetDefinition></valueSet>`;
      break;
    case 'Lookup':
    case 'MasterDetail':
      typeSpecific = `<referenceTo>${escapeXml(referenceTo)}</referenceTo><relationshipName>${escapeXml(toRelationshipName(apiName))}</relationshipName>`;
      break;
    case 'Formula':
      typeSpecific = `<formula>${escapeXml(formula)}</formula><formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>`;
      break;
    case 'LongTextArea':
      typeSpecific = `<length>32768</length><visibleLines>3</visibleLines>`;
      break;
    default:
      break;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>${escapeXml(apiName)}</fullName>
  <label>${escapeXml(label)}</label>
  <type>${type === 'Formula' ? formulaReturnType : type}</type>
  ${typeSpecific}
  ${required && type !== 'Checkbox' ? '<required>true</required>' : ''}
  ${unique ? '<unique>true</unique>' : ''}
  ${externalId ? '<externalId>true</externalId>' : ''}
  ${helpText ? `<inlineHelpText>${escapeXml(helpText)}</inlineHelpText>` : ''}
  ${description ? `<description>${escapeXml(description)}</description>` : ''}
</CustomField>`;
}

function buildTabXml(objectApiName, motif = 'Custom34: Handshaking') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata">
  <customObject>true</customObject>
  <motif>${escapeXml(motif)}</motif>
</CustomTab>`;
}

async function deployTab({ sfClient, objectApiName, tabStyle }) {
  const JSZip = require('jszip');
  const zip   = new JSZip();
  zip.file(`tabs/${objectApiName}.tab`, buildTabXml(objectApiName, tabStyle));
  zip.file('package.xml', `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>${objectApiName}</members><name>CustomTab</name></types>
  <version>62.0</version>
</Package>`);

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return deployZip(sfClient, zipBuffer);
}

function buildProfileXml(objectApiName, accessLevel) {
  const levels = {
    read: { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false },
    edit: { allowRead: true, allowCreate: false, allowEdit: true, allowDelete: false },
    full: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: true },
  };
  const perms = levels[accessLevel];
  if (!perms) throw new Error(`Unsupported profile access level: ${accessLevel}`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <objectPermissions>
    <allowCreate>${perms.allowCreate}</allowCreate>
    <allowDelete>${perms.allowDelete}</allowDelete>
    <allowEdit>${perms.allowEdit}</allowEdit>
    <allowRead>${perms.allowRead}</allowRead>
    <modifyAllRecords>false</modifyAllRecords>
    <object>${escapeXml(objectApiName)}</object>
    <viewAllRecords>false</viewAllRecords>
  </objectPermissions>
</Profile>`;
}

function profileFileName(profileName) {
  return String(profileName).replace(/[/:\\]/g, '_');
}

async function recordAdminOp({ userId, orgId, jobType, label, status, detail }) {
  try {
    const now = new Date().toISOString();
    await supabase.from('migration_jobs').insert({
      id: `admin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      user_id: userId, source_org_id: orgId, target_org_id: orgId,
      mapping_config: { jobType, label, detail },
      is_dry_run: false, status,
      current_phase: 1, phase_name: label,
      record_counts: { total: 1, succeeded: status === 'completed' ? 1 : 0, failed: status === 'failed' ? 1 : 0 },
      started_at: now, completed_at: now, created_at: now,
    });
  } catch { /* non-critical */ }
}

// ── GET /api/objects/list ─────────────────────────────────────────────────────
router.get('/list', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const result = await req.sf.query(
      `SELECT QualifiedApiName, Label, IsCustomizable FROM EntityDefinition
       WHERE IsCustomSetting = false AND IsCustomizable = true AND QualifiedApiName LIKE '%__c'
       ORDER BY Label ASC LIMIT 200`
    );
    res.json({
      objects: (result.records || []).map(o => ({
        apiName: o.QualifiedApiName,
        label:   o.Label,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/objects/tab-styles ───────────────────────────────────────────────
router.get('/tab-styles', requireAuth, withSalesforceClient, async (req, res) => {
  // Common Salesforce tab motifs
  const TAB_STYLES = [
    { value: 'Custom34: Handshaking',         label: '🤝 Handshaking' },
    { value: 'Custom35: Briefcase',            label: '💼 Briefcase' },
    { value: 'Custom36: Person',               label: '👤 Person' },
    { value: 'Custom37: Globe',                label: '🌐 Globe' },
    { value: 'Custom38: Gear',                 label: '⚙️ Gear' },
    { value: 'Custom39: Building',             label: '🏢 Building' },
    { value: 'Custom40: Box',                  label: '📦 Box' },
    { value: 'Custom41: Phone',                label: '📞 Phone' },
    { value: 'Custom42: Star',                 label: '⭐ Star' },
    { value: 'Custom43: Checkmark',            label: '✅ Checkmark' },
    { value: 'Custom44: Lightning',            label: '⚡ Lightning' },
    { value: 'Custom45: Chart',                label: '📊 Chart' },
    { value: 'Custom46: Cloud',                label: '☁️ Cloud' },
    { value: 'Custom47: Lock',                 label: '🔒 Lock' },
    { value: 'Custom48: Key',                  label: '🔑 Key' },
    { value: 'Custom49: Document',             label: '📄 Document' },
    { value: 'Custom50: Folder',               label: '📁 Folder' },
    { value: 'Custom51: Calendar',             label: '📅 Calendar' },
    { value: 'Custom52: Flag',                 label: '🚩 Flag' },
    { value: 'Custom53: Tag',                  label: '🏷️ Tag' },
  ];
  res.json({ tabStyles: TAB_STYLES });
});

// ── POST /api/objects/create ──────────────────────────────────────────────────
router.post('/create', requireAuth, withRateLimit('object_create', 2), withSalesforceClient, async (req, res) => {
  const {
    label, pluralLabel, apiNameSuffix,
    nameFieldType = 'Text', nameFieldLabel = 'Name',
    sharingModel = 'ReadWrite', description = '',
    enableActivities = true, enableFeeds = false,
    enableReports = true, enableSearch = true, enableHistory = false,
  } = req.body;

  if (!label || !apiNameSuffix) {
    return res.status(400).json({ error: 'label and apiNameSuffix are required' });
  }

  const apiName = toApiName(apiNameSuffix.replace(/__c$/i, '')); // strip __c if user added it

  try {
    const objectXml = buildCustomObjectXml({
      label, pluralLabel: pluralLabel || `${label}s`,
      apiName, nameFieldType, nameFieldLabel,
      sharingModel, description,
      enableActivities, enableFeeds, enableReports, enableSearch, enableHistory,
    });

    const result = await deployWithSingleClaudeRepair({
      sfClient: req.sf,
      metadataType: 'CustomObject',
      xml: objectXml,
      buildZip: (xml) => buildObjectPackage(xml, apiName, []),
      context: { apiName: `${apiName}__c`, label, pluralLabel, sharingModel, nameFieldType },
    });

    const status = result.success ? 'completed' : 'failed';
    await recordAdminOp({
      userId: req.user.id, orgId: req.orgConn.id,
      jobType: 'object_create',
      label: `Create object ${apiName}__c`,
      status,
      detail: { apiName: `${apiName}__c`, label, repaired: result.repaired, originalErrors: result.originalErrors, errors: result.errors },
    });

    if (!result.success) {
      return res.status(422).json({ error: result.errors?.join(' | ') || 'Deploy failed', errors: result.errors });
    }

    res.status(201).json({
      apiName:  `${apiName}__c`,
      label,
      tabCreated: false,
      repaired: !!result.repaired,
      setupUrl: `${req.orgConn.instance_url}/lightning/setup/ObjectManager/${apiName}__c/Details/view`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/objects/add-field ───────────────────────────────────────────────
router.post('/add-field', requireAuth, withRateLimit('field_create', 5), withSalesforceClient, async (req, res) => {
  const { objectApiName, field } = req.body;
  if (!objectApiName || !field?.label || !field?.type) {
    return res.status(400).json({ error: 'objectApiName, field.label and field.type are required' });
  }

  const fieldApiName = toCustomFieldName(field);
  const fullFieldName = `${objectApiName}.${fieldApiName}`;

  try {
    const fieldXml = buildCustomFieldXml({ ...field, apiName: fullFieldName });

    // Use object XML that only contains the field
    const objectWrapper = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <fields>
    <fullName>${escapeXml(fieldApiName)}</fullName>
    <label>${escapeXml(field.label)}</label>
    <type>${field.type === 'Formula' ? (field.formulaReturnType || 'Text') : field.type}</type>
    ${field.type === 'Text' ? `<length>${field.length || 255}</length>` : ''}
    ${field.type === 'Number' || field.type === 'Currency' || field.type === 'Percent' ? `<precision>${field.precision || 18}</precision><scale>${field.scale || 0}</scale>` : ''}
    ${field.type === 'Picklist' ? `<valueSet><restricted>false</restricted><valueSetDefinition><sorted>false</sorted>${(field.picklistValues || []).map((v, i) => `<value><fullName>${escapeXml(v)}</fullName><default>${i === 0}</default><label>${escapeXml(v)}</label></value>`).join('')}</valueSetDefinition></valueSet>` : ''}
    ${field.type === 'Lookup' || field.type === 'MasterDetail' ? `<referenceTo>${escapeXml(field.referenceTo)}</referenceTo><relationshipName>${escapeXml(toRelationshipName(fieldApiName))}</relationshipName>` : ''}
    ${field.type === 'Formula' ? `<formula>${escapeXml(field.formula || '')}</formula><formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>` : ''}
    ${field.type === 'LongTextArea' ? '<length>32768</length><visibleLines>3</visibleLines>' : ''}
    ${field.required && field.type !== 'Checkbox' ? '<required>true</required>' : ''}
    ${field.helpText ? `<inlineHelpText>${escapeXml(field.helpText)}</inlineHelpText>` : ''}
  </fields>
</CustomObject>`;

    const result = await deployWithSingleClaudeRepair({
      sfClient: req.sf,
      metadataType: 'CustomObject.fields',
      xml: objectWrapper,
      buildZip: (xml) => buildCustomObjectPackage(objectApiName, xml),
      context: { objectApiName, fieldApiName, field },
    });

    await recordAdminOp({
      userId: req.user.id, orgId: req.orgConn.id,
      jobType: 'object_create', label: `Add field ${fieldApiName} to ${objectApiName}`,
      status: result.success ? 'completed' : 'failed',
      detail: { objectApiName, fieldApiName, type: field.type, repaired: result.repaired, originalErrors: result.originalErrors },
    });

    if (!result.success) {
      return res.status(422).json({ error: result.errors?.join(' | ') || 'Deploy failed', errors: result.errors });
    }

    res.status(201).json({ fieldApiName, objectApiName, label: field.label, repaired: !!result.repaired });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/objects/create-tab ─────────────────────────────────────────────
router.post('/create-tab', requireAuth, withRateLimit('tab_create', 3), withSalesforceClient, async (req, res) => {
  const { objectApiName, tabStyle = SAFE_TAB_STYLE } = req.body;
  if (!objectApiName) return res.status(400).json({ error: 'objectApiName is required' });

  try {
    let result = await deployTab({ sfClient: req.sf, objectApiName, tabStyle });
    let finalTabStyle = tabStyle;
    let repaired = false;
    let originalErrors = result.errors || [];

    if (!result.success && tabStyle !== SAFE_TAB_STYLE) {
      result = await deployTab({ sfClient: req.sf, objectApiName, tabStyle: SAFE_TAB_STYLE });
      finalTabStyle = SAFE_TAB_STYLE;
      repaired = result.success;
    }

    if (!result.success) {
      return res.status(422).json({ error: result.errors?.join(' | ') || 'Deploy failed', errors: result.errors });
    }

    res.status(201).json({
      objectApiName,
      tabCreated: true,
      tabStyle: finalTabStyle,
      repaired,
      repairReason: repaired ? `Selected tab style failed, so SF Copilot retried with ${SAFE_TAB_STYLE}.` : null,
      originalErrors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/objects/grant-access ───────────────────────────────────────────
router.post('/grant-access', requireAuth, withRateLimit('object_profile_access', 3), withSalesforceClient, async (req, res) => {
  const { objectApiName, profileAccess } = req.body;
  if (!objectApiName || !profileAccess || typeof profileAccess !== 'object') {
    return res.status(400).json({ error: 'objectApiName and profileAccess are required' });
  }

  const entries = Object.entries(profileAccess)
    .filter(([, level]) => ['read', 'edit', 'full'].includes(level));
  if (!entries.length) {
    return res.status(400).json({ error: 'Select at least one profile access level.' });
  }

  try {
    const safeProfileIds = entries
      .map(([id]) => String(id).replace(/'/g, "\\'"))
      .map(id => `'${id}'`)
      .join(',');
    const profileResult = await req.sf.query(`SELECT Id, Name FROM Profile WHERE Id IN (${safeProfileIds})`);
    const profileById = Object.fromEntries((profileResult.records || []).map(p => [p.Id, p]));

    const missing = entries.filter(([id]) => !profileById[id]).map(([id]) => id);
    if (missing.length) {
      return res.status(400).json({ error: `Profile(s) not found: ${missing.join(', ')}` });
    }

    const profileFiles = [];

    for (const [profileId, level] of entries) {
      const profile = profileById[profileId];
      profileFiles.push({
        id: profileId,
        name: profile.Name,
        level,
        xml: buildProfileXml(objectApiName, level),
      });
    }

    let result = await deployZip(req.sf, await buildProfilePackage(profileFiles));
    let repaired = false;
    let originalErrors = result.errors || [];

    if (!result.success) {
      const repairedFiles = [];
      for (const file of profileFiles) {
        repairedFiles.push({
          ...file,
          xml: await repairMetadataXml({
            metadataType: 'Profile',
            xml: file.xml,
            errors: result.errors || [],
            context: { objectApiName, profileName: file.name, accessLevel: file.level },
          }),
        });
      }
      result = await deployZip(req.sf, await buildProfilePackage(repairedFiles));
      repaired = result.success;
    }

    await recordAdminOp({
      userId: req.user.id, orgId: req.orgConn.id,
      jobType: 'object_profile_access',
      label: `Grant profile access for ${objectApiName}`,
      status: result.success ? 'completed' : 'failed',
      detail: {
        objectApiName,
        profiles: entries.map(([id, level]) => ({ id, name: profileById[id].Name, level })),
        repaired,
        originalErrors,
        errors: result.errors,
      },
    });

    if (!result.success) {
      return res.status(422).json({ error: result.errors?.join(' | ') || 'Profile access deploy failed', errors: result.errors });
    }

    res.json({
      objectApiName,
      repaired,
      updatedProfiles: entries.map(([id, level]) => ({ id, name: profileById[id].Name, level })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/objects/deploy-full ─────────────────────────────────────────────
// Enqueues a full object creation sequence (object → tab → fields → profile access)
// as a single BullMQ job. Returns { jobId } immediately — frontend polls /api/jobs/:jobId.
// Replaces chaining multiple synchronous endpoints which time out under proxy defaults.
router.post('/deploy-full', requireAuth, async (req, res) => {
  const { orgId, userId } = req.body;
  if (!orgId) return res.status(400).json({ error: 'orgId is required' });
  if (!req.body.label || !req.body.apiNameSuffix) return res.status(400).json({ error: 'label and apiNameSuffix are required' });

  const jobId = `deploy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now   = new Date().toISOString();

  // Write pending job to Supabase so poll endpoint can find it immediately
  await supabase.from('migration_jobs').insert({
    id: jobId,
    user_id: req.user.id,
    source_org_id: orgId, target_org_id: orgId,
    mapping_config: { jobType: 'object_full', label: `Create ${req.body.label}` },
    is_dry_run: false, status: 'pending',
    current_phase: 0, phase_name: 'Queued…',
    record_counts: { total: 1, succeeded: 0, failed: 0 },
    started_at: now, created_at: now,
  });

  // Enqueue the deploy job
  await deployQueue.add('object_full', {
    type: 'object_full',
    jobId,
    orgId,
    userId: req.user.id,
    ...req.body,
  });

  res.status(202).json({ jobId, status: 'queued' });
});

module.exports = router;
