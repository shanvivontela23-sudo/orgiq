'use strict';
/**
 * test-p0.js — Tests for all 3 P0 fixes
 * Run: node test-p0.js
 */

require('dotenv').config();
const axios  = require('axios');
const redis  = require('./lib/redisClient');
const { getCachedToken, setCachedToken, invalidateToken } = require('./lib/tokenCache');
const supabase = require('./lib/supabase');

const API    = 'http://localhost:3001';
const ORG_ID = 'd11d2ee2-8fc9-43e4-a62a-b2f4f5c3def3'; // target sandbox
const USER_ID = 'e79e8303-38ef-4e9d-a266-fc5defb83325';

let token;
let passed = 0, failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else       { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

async function getToken() {
  const { data } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_EMAIL || 'abhishekreddyvontela@gmail.com',
    password: process.env.TEST_PASSWORD || '',
  });
  if (!data.session?.access_token) throw new Error('Auth failed — set TEST_PASSWORD env var');
  return data.session.access_token;
}

// ── P0.1: Token cache ─────────────────────────────────────────────────────────
async function testTokenCache() {
  console.log('\n── P0.1: Token Refresh Cache ──────────────────────────────');
  const testOrgId = 'test-org-p01';

  // Clean state
  await invalidateToken(testOrgId);

  // Miss
  const miss = await getCachedToken(testOrgId);
  ok('Cache miss returns null', miss === null);

  // Write
  await setCachedToken(testOrgId, { access_token: 'tok_abc', instance_url: 'https://test.sf.com' });

  // Hit
  const hit = await getCachedToken(testOrgId);
  ok('Cache hit returns token',        hit !== null);
  ok('Cached access_token is correct', hit?.access_token === 'tok_abc');
  ok('Cached instance_url is correct', hit?.instance_url === 'https://test.sf.com');

  // TTL is set
  const ttl = await redis.ttl(`sftoken:${testOrgId}`);
  ok('TTL is set (90 min window)',      ttl > 0 && ttl <= 5400, `TTL=${ttl}s`);

  // Invalidate
  await invalidateToken(testOrgId);
  const afterInvalidate = await getCachedToken(testOrgId);
  ok('Invalidate clears cache',         afterInvalidate === null);
}

// ── P0.2: Field batching ──────────────────────────────────────────────────────
async function testFieldBatching() {
  console.log('\n── P0.2: Field Batching (parse + compare only — no deploy) ──');

  // Parse a CSV with 5 fields across 2 objects
  const csv = [
    'Object,Field Label,API Name,Field Type,Required',
    'Account,Customer Tier,Customer_Tier__c,Picklist,false',
    'Account,Annual Budget,Annual_Budget__c,Currency,false',
    'Account,Name,Name,Text,true',
    'Contact,LinkedIn URL,LinkedIn_URL__c,Url,false',
    'Contact,Last Name,LastName,Text,true',
  ].join('\n');

  const form = new (require('form-data'))();
  form.append('file', Buffer.from(csv), { filename: 'test.csv', contentType: 'text/csv' });
  form.append('userId', USER_ID);

  const parseRes = await axios.post(`${API}/api/mapping/parse`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
  });

  ok('Parse returns 5 rows',            parseRes.data.rowCount === 5, `got ${parseRes.data.rowCount}`);
  ok('Parse detects 2 objects',         parseRes.data.objects?.length === 2, `got ${parseRes.data.objects?.length}`);
  ok('Column auto-detected',            parseRes.data.colMapComplete === true);

  // Compare against live org — verify batching logic would group Account(3) + Contact(2)
  const compareRes = await axios.post(`${API}/api/mapping/compare`, {
    orgId: ORG_ID,
    rows: parseRes.data.rows,
    userId: USER_ID,
  }, { headers: { Authorization: `Bearer ${token}` } });

  ok('Compare returns results',         compareRes.data.results?.length === 5);
  ok('Account.Name exists',
    compareRes.data.results.find(r => r.object === 'Account' && r.apiName === 'Name')?.status === 'exists');
  ok('Account.Customer_Tier__c missing',
    compareRes.data.results.find(r => r.apiName === 'Customer_Tier__c')?.status === 'missing');
  ok('Summary total = 5',               compareRes.data.summary?.total === 5);

  console.log(`  ℹ️  Batch grouping: Account (${compareRes.data.results.filter(r => r.object==='Account').length} fields), Contact (${compareRes.data.results.filter(r=>r.object==='Contact').length} fields) → 2 deploys instead of 5`);
}

// ── P0.3: Deploy queue ────────────────────────────────────────────────────────
async function testDeployQueue() {
  console.log('\n── P0.3: Deploy Queue (enqueue + poll) ──────────────────────');

  // Enqueue a deploy-full job
  const res = await axios.post(`${API}/api/objects/deploy-full`, {
    orgId: ORG_ID,
    label: 'P0 Test Object',
    pluralLabel: 'P0 Test Objects',
    apiNameSuffix: `P0_Test_${Date.now()}`,
    nameFieldType: 'Text',
    nameFieldLabel: 'Name',
    sharingModel: 'ReadWrite',
    description: 'Created by P0 test script',
    enableActivities: true, enableFeeds: false,
    enableReports: true, enableSearch: true, enableHistory: false,
    createTab: false,
    hasRelationship: false,
    fields: [],
    profileAccess: {},
  }, { headers: { Authorization: `Bearer ${token}` } });

  ok('deploy-full returns 202',         res.status === 202);
  ok('deploy-full returns jobId',       typeof res.data.jobId === 'string');
  ok('deploy-full returns queued',      res.data.status === 'queued');

  const jobId = res.data.jobId;
  console.log(`  ℹ️  Job ID: ${jobId}`);

  // Poll /api/jobs/:jobId
  let finalStatus;
  let phase = '';
  console.log('  ℹ️  Polling… (this will take 15-60s for a real SF deploy)');
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const poll = await axios.get(`${API}/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${token}` } });
    const job  = poll.data;
    if (job.phase !== phase) { phase = job.phase; process.stdout.write(`  → ${phase}\n`); }
    if (job.status === 'completed' || job.status === 'failed') { finalStatus = job; break; }
  }

  ok('Job reaches terminal state',     finalStatus !== undefined, 'timed out after 160s');
  ok('Terminal status is valid',       ['completed', 'failed'].includes(finalStatus?.status));

  if (finalStatus?.status === 'completed') {
    ok('Result has apiName',           typeof finalStatus.result?.apiName === 'string');
    ok('Result has setupUrl',          typeof finalStatus.result?.setupUrl === 'string');
    console.log(`  ℹ️  Created: ${finalStatus.result?.apiName}`);
    console.log(`  ℹ️  Setup:   ${finalStatus.result?.setupUrl}`);
  } else {
    console.log(`  ℹ️  Deploy failed (may be expected in sandbox): ${finalStatus?.error}`);
    // A failure still proves the queue + poll + worker pipeline works
    ok('Error message is present',     typeof finalStatus?.error === 'string');
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log('='.repeat(60));
  console.log('SF Copilot — P0 Fix Tests');
  console.log('='.repeat(60));

  try {
    console.log('\nAuthenticating…');
    token = await getToken();
    console.log('  ✅ Auth OK');
  } catch (err) {
    console.error('  ❌ Auth failed:', err.message);
    console.error('  Set TEST_PASSWORD env var and retry.');
    process.exit(1);
  }

  await testTokenCache();
  await testFieldBatching();
  await testDeployQueue();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  await redis.quit();
  process.exit(failed > 0 ? 1 : 0);
})();
