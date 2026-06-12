'use strict';

/**
 * deployWorker.js
 *
 * Processes Metadata API deploy jobs from the 'deploys' BullMQ queue.
 * Runs as a separate process: node workers/deployWorker.js
 *
 * Job types handled:
 *   object_full  — full object creation sequence (object → tab → fields → profile access)
 *   field_add    — single field add to existing object
 *   tab_create   — tab creation for existing object
 *   grant_access — profile access grant
 *
 * Each job writes progress to migration_jobs.phase_name so the frontend
 * can show meaningful status while polling.
 */

require('dotenv').config();
const { Worker } = require('bullmq');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const JSZip = require('jszip');

const { getRedisConnection } = require('./redisConnection');
const supabase = require('../lib/supabase');
const { getSalesforceOAuthConfig } = require('../lib/salesforceOAuth');
const SalesforceClient = require('../lib/SalesforceClient');
const { getCachedToken, setCachedToken } = require('../lib/tokenCache');
const { skillForType, formatSkillBlock } = require('../lib/skillLoader');

const anthropic = new Anthropic();

// ── Org token helper ──────────────────────────────────────────────────────────

async function getOrgClient(orgId) {
  // Check cache first
  const cached = await getCachedToken(orgId);
  if (cached) return new SalesforceClient({ accessToken: cached.access_token, instanceUrl: cached.instance_url });

  const { data: org } = await supabase
    .from('connected_orgs')
    .select('access_token, refresh_token, instance_url, org_type')
    .eq('id', orgId)
    .single();

  if (!org) throw new Error(`Org ${orgId} not found`);

  if (org.refresh_token) {
    try {
      const cfg = getSalesforceOAuthConfig(org.org_type);
      const { data: tok } = await axios.post(
        `${cfg.loginUrl}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'refresh_token', client_id: cfg.clientId,
          client_secret: cfg.clientSecret, refresh_token: org.refresh_token,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const token = { access_token: tok.access_token, instance_url: tok.instance_url || org.instance_url };
      await Promise.all([
        supabase.from('connected_orgs').update(token).eq('id', orgId),
        setCachedToken(orgId, token),
      ]);
      return new SalesforceClient(token);
    } catch { /* fall through */ }
  }
  return new SalesforceClient({ access_token: org.access_token, instance_url: org.instance_url });
}

// ── Job progress ──────────────────────────────────────────────────────────────

async function setPhase(jobId, phase, status = 'running') {
  await supabase.from('migration_jobs').update({ phase_name: phase, status }).eq('id', jobId);
}

async function completeJob(jobId, result) {
  await supabase.from('migration_jobs').update({
    status: 'completed',
    phase_name: 'Done',
    mapping_config: supabase.rpc ? undefined : undefined, // preserve existing
    completed_at: new Date().toISOString(),
    record_counts: { total: 1, succeeded: 1, failed: 0 },
    error_summary: { result },
  }).eq('id', jobId);
}

async function failJob(jobId, error) {
  await supabase.from('migration_jobs').update({
    status: 'failed',
    completed_at: new Date().toISOString(),
    error_summary: { error: String(error) },
  }).eq('id', jobId);
}

// ── XML builders (same as objects.js, extracted here for worker use) ──────────

function escapeXml(v = '') {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function toApiName(label = '') {
  const n = label.trim().replace(/[^a-zA-Z0-9 _]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return /^[A-Za-z]/.test(n) ? n : `X${n}`;
}

function toRelationshipName(f = '') { return toApiName(String(f).replace(/\..*$/, '').replace(/__c$/i, '')); }

function buildCustomObjectXml({ label, pluralLabel, apiName, nameFieldType = 'Text', nameFieldLabel = 'Name', sharingModel = 'ReadWrite', enableActivities = true, enableFeeds = false, enableReports = true, enableSearch = true, enableHistory = false, description = '' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>${escapeXml(label)}</label>
  <pluralLabel>${escapeXml(pluralLabel)}</pluralLabel>
  <nameField><label>${escapeXml(nameFieldLabel)}</label><type>${nameFieldType === 'AutoNumber' ? 'AutoNumber' : 'Text'}</type>${nameFieldType === 'AutoNumber' ? '<displayFormat>AN-{0000}</displayFormat><startingNumber>1</startingNumber>' : ''}</nameField>
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

function buildFieldBlock(field) {
  const { apiName, label, type, required = false, length = 255, precision = 18, scale = 0, picklistValues = [], referenceTo = '', formula = '', formulaReturnType = 'Text', helpText = '' } = field;
  const short = apiName.includes('.') ? apiName.split('.').pop() : apiName;
  let ts = '';
  switch (type) {
    case 'Text': ts = `<length>${length}</length>`; break;
    case 'Number': case 'Currency': case 'Percent': ts = `<precision>${precision}</precision><scale>${scale}</scale>`; break;
    case 'Picklist': ts = `<valueSet><restricted>false</restricted><valueSetDefinition><sorted>false</sorted>${(picklistValues.length ? picklistValues : ['Value1']).map((v, i) => `<value><fullName>${escapeXml(v)}</fullName><default>${i === 0}</default><label>${escapeXml(v)}</label></value>`).join('')}</valueSetDefinition></valueSet>`; break;
    case 'Lookup': case 'MasterDetail': ts = `<referenceTo>${escapeXml(referenceTo || 'Account')}</referenceTo><relationshipName>${escapeXml(toRelationshipName(short))}</relationshipName>`; break;
    case 'Formula': ts = `<formula>${escapeXml(formula || '"placeholder"')}</formula><formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>`; break;
    case 'LongTextArea': ts = `<length>32768</length><visibleLines>3</visibleLines>`; break;
  }
  const ft = type === 'Formula' ? (formulaReturnType || 'Text') : type;
  return `  <fields><fullName>${escapeXml(short)}</fullName><label>${escapeXml(label)}</label><type>${escapeXml(ft)}</type>${ts}${required && type !== 'Checkbox' ? '<required>true</required>' : ''}${helpText ? `<inlineHelpText>${escapeXml(helpText)}</inlineHelpText>` : ''}</fields>`;
}

function buildTabXml(objectApiName, motif = 'Custom34: Handshaking') {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomTab xmlns="http://soap.sforce.com/2006/04/metadata"><customObject>true</customObject><motif>${escapeXml(motif)}</motif></CustomTab>`;
}

function buildProfileXml(objectApiName, accessLevel) {
  const levels = { read: { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false }, edit: { allowRead: true, allowCreate: false, allowEdit: true, allowDelete: false }, full: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: true } };
  const p = levels[accessLevel]; if (!p) throw new Error(`Invalid level: ${accessLevel}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><objectPermissions><allowCreate>${p.allowCreate}</allowCreate><allowDelete>${p.allowDelete}</allowDelete><allowEdit>${p.allowEdit}</allowEdit><allowRead>${p.allowRead}</allowRead><modifyAllRecords>false</modifyAllRecords><object>${escapeXml(objectApiName)}</object><viewAllRecords>false</viewAllRecords></objectPermissions></Profile>`;
}

// ── Zip builders ──────────────────────────────────────────────────────────────

async function zipObject(apiName, xml) {
  const z = new JSZip();
  z.file(`objects/${apiName}.object`, xml);
  z.file('package.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>${escapeXml(apiName)}</members><name>CustomObject</name></types><version>62.0</version></Package>`);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function zipTab(apiName, xml) {
  const z = new JSZip();
  z.file(`tabs/${apiName}.tab`, xml);
  z.file('package.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>${escapeXml(apiName)}</members><name>CustomTab</name></types><version>62.0</version></Package>`);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function zipProfiles(profileFiles) {
  const z = new JSZip();
  profileFiles.forEach(({ name, xml }) => { z.file(`profiles/${name.replace(/[/:\\]/g, '_')}.profile`, xml); });
  z.file('package.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types>${profileFiles.map(({ name }) => `<members>${escapeXml(name)}</members>`).join('')}<name>Profile</name></types><version>62.0</version></Package>`);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ── Deploy + repair ───────────────────────────────────────────────────────────

async function deployZip(sf, zipBuf, checkOnly = false) {
  const base64 = zipBuf.toString('base64');
  const soap = (action, body) => `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata"><soapenv:Header><met:SessionHeader><met:sessionId>${sf.accessToken}</met:sessionId></met:SessionHeader></soapenv:Header><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

  const deployRes = await axios.post(`${sf.instanceUrl}/services/Soap/m/62.0`,
    soap('deploy', `<met:deploy><met:ZipFile>${base64}</met:ZipFile><met:DeployOptions><met:allowMissingFiles>false</met:allowMissingFiles><met:autoUpdatePackage>false</met:autoUpdatePackage><met:checkOnly>${checkOnly}</met:checkOnly><met:ignoreWarnings>true</met:ignoreWarnings><met:rollbackOnError>true</met:rollbackOnError><met:singlePackage>true</met:singlePackage></met:DeployOptions></met:deploy>`),
    { headers: { 'Content-Type': 'text/xml', SOAPAction: 'deploy' } }
  );
  const asyncId = deployRes.data.match(/<id>(.*?)<\/id>/)?.[1];
  if (!asyncId) throw new Error('Deploy failed to start');

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const sr = await axios.post(`${sf.instanceUrl}/services/Soap/m/62.0`,
      soap('checkDeployStatus', `<met:checkDeployStatus><met:asyncProcessId>${asyncId}</met:asyncProcessId><met:includeDetails>true</met:includeDetails></met:checkDeployStatus>`),
      { headers: { 'Content-Type': 'text/xml', SOAPAction: 'checkDeployStatus' } }
    );
    const xml = sr.data;
    if (xml.match(/<done>(.*?)<\/done>/)?.[1] !== 'true') continue;
    if (xml.match(/<success>(.*?)<\/success>/)?.[1] === 'true') return { success: true, asyncId };
    const errs = [];
    for (const m of xml.matchAll(/<message>(.*?)<\/message>/gs)) errs.push(m[1].trim());
    for (const m of xml.matchAll(/<problem>(.*?)<\/problem>/gs)) errs.push(m[1].trim());
    return { success: false, asyncId, errors: [...new Set(errs)] };
  }
  throw new Error('Deploy timed out');
}

async function repairAndDeploy({ sf, metadataType, xml, errors, buildZip, context }) {
  const skill = skillForType(metadataType);
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 2500,
    system: `You repair Salesforce Metadata API XML.\n${formatSkillBlock(skill)}\nReturn ONLY one complete XML document in a fenced xml code block. Fix only what the error requires.`,
    messages: [{ role: 'user', content: `Type: ${metadataType}\nErrors:\n${errors.join('\n')}\nXML:\n\`\`\`xml\n${xml}\n\`\`\`` }],
  });
  const text = resp.content?.[0]?.text || '';
  const repaired = text.match(/```xml\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (!repaired?.startsWith('<?xml')) throw new Error('Repair did not return valid XML');
  return deployZip(sf, await buildZip(repaired), false);
}

async function deployWithRepair({ sf, metadataType, xml, buildZip, context }) {
  let r = await deployZip(sf, await buildZip(xml), false);
  if (r.success) return { ...r, repaired: false };
  const retry = await repairAndDeploy({ sf, metadataType, xml, errors: r.errors || [], buildZip, context });
  return { ...retry, repaired: retry.success, originalErrors: r.errors };
}

// ── Job handler ───────────────────────────────────────────────────────────────

async function handleObjectFullDeploy(jobData, jobId) {
  const { orgId, userId, label, pluralLabel, apiNameSuffix, nameFieldType, nameFieldLabel, sharingModel, description, enableActivities, enableFeeds, enableReports, enableSearch, enableHistory, createTab, tabStyle, hasRelationship, relType, relParentObject, relFieldLabel, relFieldApiName, fields = [], profileAccess = {} } = jobData;

  const sf = await getOrgClient(orgId);
  const apiName = apiNameSuffix.replace(/__c$/i, '');
  const result = {};

  // Step 1: Create object
  await setPhase(jobId, 'Creating object…');
  const objectXml = buildCustomObjectXml({ label, pluralLabel: pluralLabel || `${label}s`, apiName, nameFieldType, nameFieldLabel, sharingModel, description, enableActivities, enableFeeds, enableReports, enableSearch, enableHistory });
  const objR = await deployWithRepair({ sf, metadataType: 'CustomObject', xml: objectXml, buildZip: (x) => zipObject(`${apiName}__c`, x), context: { apiName: `${apiName}__c` } });
  if (!objR.success) throw new Error(`Object creation failed: ${(objR.errors || []).join(' | ')}`);
  result.apiName = `${apiName}__c`;
  result.repaired = objR.repaired;

  // Step 2: Create tab
  if (createTab) {
    await setPhase(jobId, 'Creating tab…');
    const tabXml = buildTabXml(`${apiName}__c`, tabStyle);
    const tabR = await deployZip(sf, await zipTab(`${apiName}__c`, tabXml), false);
    result.tabCreated = tabR.success;
    if (!tabR.success) result.tabWarning = (tabR.errors || []).join(' | ');
  }

  // Step 3: Relationship field
  if (hasRelationship && relParentObject && relFieldLabel) {
    await setPhase(jobId, 'Adding relationship field…');
    const relApiName = relFieldApiName || `${toApiName(relFieldLabel)}__c`;
    const relBlock = buildFieldBlock({ apiName: relApiName, label: relFieldLabel, type: relType || 'Lookup', referenceTo: relParentObject });
    const relXml = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">${relBlock}</CustomObject>`;
    const relR = await deployWithRepair({ sf, metadataType: 'CustomObject.fields', xml: relXml, buildZip: (x) => zipObject(`${apiName}__c`, x), context: {} });
    if (!relR.success) throw new Error(`Relationship field failed: ${(relR.errors || []).join(' | ')}`);
  }

  // Step 4: Custom fields (batch — all in one deploy)
  const validFields = fields.filter(f => f.label && f.type);
  if (validFields.length > 0) {
    await setPhase(jobId, `Adding ${validFields.length} field${validFields.length !== 1 ? 's' : ''}…`);
    const blocks = validFields.map(f => buildFieldBlock({ ...f, apiName: f.apiName || `${toApiName(f.label)}__c` }));
    const batchXml = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">${blocks.join('\n')}</CustomObject>`;
    const fieldsR = await deployWithRepair({ sf, metadataType: 'CustomObject.fields', xml: batchXml, buildZip: (x) => zipObject(`${apiName}__c`, x), context: {} });
    result.fieldsDeployed = fieldsR.success;
    if (!fieldsR.success) result.fieldsWarning = (fieldsR.errors || []).join(' | ');
  }

  // Step 5: Profile access
  const accessEntries = Object.entries(profileAccess).filter(([, level]) => level);
  if (accessEntries.length > 0) {
    await setPhase(jobId, 'Granting profile access…');
    const safeIds = accessEntries.map(([id]) => `'${String(id).replace(/'/g, "\\'")}'`).join(',');
    const profResult = await sf.query(`SELECT Id, Name FROM Profile WHERE Id IN (${safeIds})`);
    const byId = Object.fromEntries((profResult.records || []).map(p => [p.Id, p]));
    const profileFiles = accessEntries.filter(([id]) => byId[id]).map(([id, level]) => ({
      name: byId[id].Name,
      xml: buildProfileXml(`${apiName}__c`, level),
    }));
    if (profileFiles.length > 0) {
      const accessR = await deployZip(sf, await zipProfiles(profileFiles), false);
      result.profilesGranted = accessR.success;
    }
  }

  result.setupUrl = `${sf.instanceUrl}/lightning/setup/ObjectManager/${apiName}__c/Details/view`;
  return result;
}

// ── Worker ────────────────────────────────────────────────────────────────────

const worker = new Worker('deploys', async (job) => {
  const { jobId, type, ...data } = job.data;
  console.log(`[deploy-worker] Starting ${type} job ${jobId}`);

  try {
    let result;
    if (type === 'object_full') result = await handleObjectFullDeploy(data, jobId);
    else throw new Error(`Unknown deploy job type: ${type}`);

    await completeJob(jobId, result);
    console.log(`[deploy-worker] Completed ${jobId}`);
    return result;
  } catch (err) {
    console.error(`[deploy-worker] Failed ${jobId}:`, err.message);
    await failJob(jobId, err.message);
    throw err; // let BullMQ handle retry
  }
}, {
  connection: getRedisConnection(),
  concurrency: parseInt(process.env.DEPLOY_WORKER_CONCURRENCY) || 5,
});

worker.on('completed', job => console.log(`[deploy-worker] Job ${job.id} done`));
worker.on('failed', (job, err) => console.error(`[deploy-worker] Job ${job?.id} failed:`, err.message));
worker.on('error', err => console.error('[deploy-worker] Worker error:', err));

console.log('SF Copilot deploy worker started — listening on queue: deploys');
