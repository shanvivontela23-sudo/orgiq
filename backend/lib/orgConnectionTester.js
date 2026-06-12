'use strict';

const axios = require('axios');
const supabase = require('./supabase');
const SalesforceClient = require('./SalesforceClient');
const { deployArtifact } = require('./metadataDeployer');
const { getSalesforceOAuthConfig } = require('./salesforceOAuth');

const API_VERSION = '62.0';

function isMissingTableError(err) {
  const message = err?.message || String(err || '');
  return /does not exist|schema cache|could not find the table|relation .*org_connection_tests/i.test(message);
}

function remediationFor(testType) {
  return {
    identity: 'Reconnect this org so SF Copilot can verify the connected Salesforce user.',
    rest_api: 'Confirm the user has API Enabled permission and the Connected App includes the API scope.',
    metadata_api: 'Confirm the user has Customize Application / Modify Metadata-style permissions for setup metadata access.',
    deploy_access: 'Use an admin/deployment-capable user, or grant deploy/customize metadata permissions before deploying.',
    token_refresh: 'Reconnect the org and ensure refresh_token/offline_access scope is enabled.',
    api_version: 'Use a Salesforce org that supports the configured API version or lower the API version.',
  }[testType] || 'Review Salesforce permissions and reconnect the org.';
}

function summarizeError(err) {
  const body = err?.response?.data;
  if (typeof body === 'string') return body.slice(0, 500);
  if (Array.isArray(body)) return body.map((e) => e.message || JSON.stringify(e)).join('; ').slice(0, 500);
  if (body?.message) return body.message;
  return err?.message || 'Unknown error';
}

async function recordTest({ org, userId, testType, status, errorCode, errorMessage, latencyMs, details = {} }) {
  try {
    await supabase.from('org_connection_tests').insert({
      connected_org_id: org.id,
      user_id: userId || org.user_id,
      test_type: testType,
      status,
      error_code: errorCode || null,
      error_message: errorMessage || null,
      remediation: status === 'pass' ? null : remediationFor(testType),
      latency_ms: latencyMs,
      details,
    });
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[org-test] record failed:', err.message);
  }
}

async function runCheck(org, userId, testType, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    const result = {
      testType,
      status: 'pass',
      latencyMs: Date.now() - started,
      details: details || {},
    };
    await recordTest({ org, userId, testType, status: 'pass', latencyMs: result.latencyMs, details: result.details });
    return result;
  } catch (err) {
    const result = {
      testType,
      status: 'fail',
      latencyMs: Date.now() - started,
      errorCode: err?.response?.status ? `HTTP_${err.response.status}` : err.code || 'ERROR',
      errorMessage: summarizeError(err),
      remediation: remediationFor(testType),
    };
    await recordTest({
      org,
      userId,
      testType,
      status: 'fail',
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      latencyMs: result.latencyMs,
    });
    return result;
  }
}

async function refreshOrgToken(org) {
  if (!org.refresh_token) throw new Error('No refresh token stored for this org.');
  const oauthConfig = getSalesforceOAuthConfig(org.org_type);
  const { data } = await axios.post(
    `${oauthConfig.loginUrl}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
      refresh_token: org.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  await supabase.from('connected_orgs').update({
    access_token: data.access_token,
    instance_url: data.instance_url || org.instance_url,
    token_status: 'valid',
  }).eq('id', org.id);

  return {
    ...org,
    access_token: data.access_token,
    instance_url: data.instance_url || org.instance_url,
  };
}

async function testOrgConnection(orgId, userId) {
  const { data: org, error } = await supabase
    .from('connected_orgs')
    .select('id, user_id, org_id, org_name, org_type, instance_url, access_token, refresh_token')
    .eq('id', orgId)
    .single();

  if (error || !org) throw new Error(`Connected org not found: ${error?.message || orgId}`);
  if (userId && org.user_id !== userId) throw new Error('Org does not belong to the signed-in user.');

  let workingOrg = org;
  const refreshResult = await runCheck(org, userId, 'token_refresh', async () => {
    workingOrg = await refreshOrgToken(org);
    return { instanceUrl: workingOrg.instance_url };
  });

  const sf = new SalesforceClient({
    accessToken: workingOrg.access_token,
    instanceUrl: workingOrg.instance_url,
  });

  const results = [refreshResult];

  results.push(await runCheck(workingOrg, userId, 'identity', async () => {
    const { data } = await axios.get(`${workingOrg.instance_url}/services/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${workingOrg.access_token}` },
    });
    await supabase.from('connected_orgs').update({
      username: data.preferred_username || data.email || data.name || null,
      org_id: data.organization_id || workingOrg.org_id,
      instance_url: data.urls?.rest?.split('/services/data')[0] || workingOrg.instance_url,
    }).eq('id', workingOrg.id);
    return {
      username: data.preferred_username || data.email || data.name,
      organizationId: data.organization_id,
    };
  }));

  results.push(await runCheck(workingOrg, userId, 'rest_api', async () => {
    const data = await sf.query('SELECT Id FROM User LIMIT 1');
    return { records: data.totalSize ?? data.records?.length ?? 0 };
  }));

  results.push(await runCheck(workingOrg, userId, 'metadata_api', async () => {
    const data = await sf.toolingQuery('SELECT Id FROM EntityDefinition LIMIT 1');
    return { records: data.totalSize ?? data.records?.length ?? 0 };
  }));

  results.push(await runCheck(workingOrg, userId, 'api_version', async () => {
    const { data } = await axios.get(`${workingOrg.instance_url}/services/data`, {
      headers: { Authorization: `Bearer ${workingOrg.access_token}` },
    });
    const versions = (data || []).map((v) => String(v.version));
    if (!versions.includes(API_VERSION)) {
      throw new Error(`API version ${API_VERSION} is not supported. Supported latest: ${versions.at(-1) || 'unknown'}`);
    }
    await supabase.from('connected_orgs').update({ api_version: API_VERSION }).eq('id', workingOrg.id);
    return { apiVersion: API_VERSION, latest: versions.at(-1) };
  }));

  results.push(await runCheck(workingOrg, userId, 'deploy_access', async () => {
    const deployResult = await deployArtifact({
      artifactType: 'validationRule',
      apiName: 'Account.SF_Copilot_Deploy_Access_Check',
      artifactXml: `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Account.SF_Copilot_Deploy_Access_Check</fullName>
  <active>false</active>
  <description>SF Copilot checkOnly deploy permission probe.</description>
  <errorConditionFormula>false</errorConditionFormula>
  <errorMessage>SF Copilot deploy access check.</errorMessage>
</ValidationRule>`,
      sfClient: sf,
      checkOnly: true,
    });
    if (!deployResult.success) throw new Error(deployResult.error?.message || 'checkOnly deploy failed');
    await supabase.from('connected_orgs').update({ last_deploy_check_at: new Date().toISOString() }).eq('id', workingOrg.id);
    return { checkOnly: true, asyncId: deployResult.asyncId };
  }));

  const overall = results.every((r) => r.status === 'pass') ? 'pass' : 'fail';
  await supabase.from('connected_orgs').update({
    token_status: refreshResult.status === 'pass' ? 'valid' : 'refresh_failed',
    last_tested_at: new Date().toISOString(),
  }).eq('id', org.id);

  return { orgId, overall, results };
}

async function listLatestTests(orgIds = []) {
  if (!orgIds.length) return {};
  try {
    const { data, error } = await supabase
      .from('org_connection_tests')
      .select('connected_org_id, test_type, status, error_message, remediation, latency_ms, tested_at, details')
      .in('connected_org_id', orgIds)
      .order('tested_at', { ascending: false })
      .limit(orgIds.length * 12);
    if (error) throw error;

    const byOrg = {};
    for (const row of data || []) {
      byOrg[row.connected_org_id] ||= {};
      byOrg[row.connected_org_id][row.test_type] ||= row;
    }
    return byOrg;
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[org-test] list latest failed:', err.message);
    return {};
  }
}

module.exports = { testOrgConnection, listLatestTests };
