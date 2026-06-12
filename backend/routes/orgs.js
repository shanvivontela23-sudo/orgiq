'use strict';

const express  = require('express');
const axios    = require('axios');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { getSalesforceOAuthConfig } = require('../lib/salesforceOAuth');
const { testOrgConnection, listLatestTests } = require('../lib/orgConnectionTester');

async function refreshOrgToken(orgId, org) {
  if (!org.refresh_token) return org;

  const oauthConfig = getSalesforceOAuthConfig(org.org_type);
  const { data: tokenData } = await axios.post(
    `${oauthConfig.loginUrl}/services/oauth2/token`,
    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
      refresh_token: org.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const refreshed = {
    ...org,
    access_token: tokenData.access_token,
    instance_url: tokenData.instance_url || org.instance_url,
  };

  await supabase
    .from('connected_orgs')
    .update({
      access_token: refreshed.access_token,
      instance_url: refreshed.instance_url,
    })
    .eq('id', orgId);

  return refreshed;
}

async function salesforceGet(orgId, org, url) {
  try {
    return await axios.get(`${org.instance_url}${url}`, {
      headers: { Authorization: `Bearer ${org.access_token}` },
    });
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    const refreshed = await refreshOrgToken(orgId, org);
    return axios.get(`${refreshed.instance_url}${url}`, {
      headers: { Authorization: `Bearer ${refreshed.access_token}` },
    });
  }
}

async function deleteMigrationJobsReferencingOrg(orgId) {
  const { data: jobs, error: jobLookupErr } = await supabase
    .from('migration_jobs')
    .select('id')
    .or(`source_org_id.eq.${orgId},target_org_id.eq.${orgId}`);

  if (jobLookupErr) throw new Error(`Could not find dependent migration jobs: ${jobLookupErr.message}`);

  const jobIds = (jobs || []).map((job) => job.id);
  if (jobIds.length === 0) return 0;

  const { error: reportDeleteErr } = await supabase
    .from('validation_reports')
    .delete()
    .in('job_id', jobIds);

  if (reportDeleteErr && !/schema cache|could not find the table/i.test(reportDeleteErr.message || '')) {
    throw new Error(`Could not delete dependent validation reports: ${reportDeleteErr.message}`);
  }

  const { error: phaseDeleteErr } = await supabase
    .from('migration_phase_logs')
    .delete()
    .in('job_id', jobIds);

  if (phaseDeleteErr && !/schema cache|could not find the table/i.test(phaseDeleteErr.message || '')) {
    throw new Error(`Could not delete dependent phase logs: ${phaseDeleteErr.message}`);
  }

  const { error: jobDeleteErr } = await supabase
    .from('migration_jobs')
    .delete()
    .in('id', jobIds);

  if (jobDeleteErr) throw new Error(`Could not delete dependent migration jobs: ${jobDeleteErr.message}`);

  return jobIds.length;
}

/**
 * GET /api/orgs
 * List all connected Salesforce orgs for the authenticated user.
 */
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const { data: orgs, error } = await supabase
      .from('connected_orgs')
      .select('id, org_id, org_name, username, instance_url, org_type, connected_at, api_version, token_status, last_tested_at, last_deploy_check_at, org_alias')
      .eq('user_id', userId)
      .order('connected_at', { ascending: false });

    if (error) throw new Error(error.message);

    const latestTests = await listLatestTests((orgs || []).map((org) => org.id));

    res.json({
      orgs: (orgs || []).map((org) => ({
        ...org,
        health: latestTests[org.id] || {},
      })),
    });
  } catch (err) {
    console.error('List orgs error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orgs/:id/test
 * Run identity, token refresh, REST, Metadata, deploy access, and API version checks.
 */
router.post('/:id/test', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const result = await testOrgConnection(id, userId);
    // Convert results array → keyed object for the frontend UI
    const resultsByType = {};
    for (const r of result.results || []) {
      resultsByType[r.testType] = r;
    }
    res.json({ ...result, results: resultsByType });
  } catch (err) {
    console.error('Test org connection error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/orgs/:id
 * Update mutable fields on a connected org (e.g. org_type).
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { org_type } = req.body;

    if (org_type && !['source', 'target'].includes(org_type)) {
      return res.status(400).json({ error: 'org_type must be "source" or "target"' });
    }

    const updates = {};
    if (org_type) updates.org_type = org_type;

    const { error } = await supabase
      .from('connected_orgs')
      .update(updates)
      .eq('id', id);

    if (error) throw new Error(error.message);
    res.json({ id, ...updates });
  } catch (err) {
    console.error('Patch org error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/orgs/:id
 * Disconnect an org — revoke its OAuth token and remove from DB.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: org, error: fetchErr } = await supabase
      .from('connected_orgs')
      .select('instance_url, access_token, org_name')
      .eq('id', id)
      .single();

    if (fetchErr) {
      if (fetchErr.code === 'PGRST116') {
        return res.status(404).json({ error: 'Org not found' });
      }
      throw new Error(fetchErr.message);
    }

    // Revoke Salesforce token
    try {
      await axios.post(
        `${org.instance_url}/services/oauth2/revoke`,
        `token=${org.access_token}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    } catch (revokeErr) {
      console.warn('Token revoke failed (continuing):', revokeErr.message);
    }

    let deletedDependentJobs = 0;

    try {
      // Keep old migration history where the deployed schema allows nullable
      // org references. Some early demo databases made source_org_id NOT NULL,
      // so those fall back to deleting dependent demo jobs below.
      const { error: sourceDetachErr } = await supabase
        .from('migration_jobs')
        .update({ source_org_id: null })
        .eq('source_org_id', id);

      if (sourceDetachErr) throw sourceDetachErr;

      const { error: targetDetachErr } = await supabase
        .from('migration_jobs')
        .update({ target_org_id: null })
        .eq('target_org_id', id);

      if (targetDetachErr) throw targetDetachErr;
    } catch (detachErr) {
      const message = detachErr.message || '';
      if (!/not-null constraint|null value in column/i.test(message)) {
        throw new Error(`Could not detach migration jobs: ${message}`);
      }
      deletedDependentJobs = await deleteMigrationJobsReferencingOrg(id);
    }

    const { error: deleteErr } = await supabase
      .from('connected_orgs')
      .delete()
      .eq('id', id);

    if (deleteErr) throw new Error(deleteErr.message);

    res.json({
      id,
      orgName: org.org_name,
      deletedDependentJobs,
      message: 'Org disconnected',
    });
  } catch (err) {
    console.error('Disconnect org error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/orgs/:id/schema
 * Fetch object schema via Salesforce REST API for a connected org.
 */
router.get('/:id/schema', async (req, res) => {
  try {
    const { id } = req.params;
    const { objects } = req.query;

    const { data: org, error } = await supabase
      .from('connected_orgs')
      .select('instance_url, access_token, refresh_token, org_type')
      .eq('id', id)
      .single();

    if (error) throw new Error(error.message);

    const objectList = objects ? objects.split(',').map(s => s.trim()) : [];
    const schema = {};

    await Promise.all(
      objectList.map(async (obj) => {
        const { data } = await salesforceGet(id, org, `/services/data/v62.0/sobjects/${obj}/describe/`);
        schema[obj] = {
          fields: data.fields.map(f => ({
            name: f.name, label: f.label, type: f.type,
            nillable: f.nillable, createable: f.createable,
            referenceTo: f.referenceTo,
          })),
        };
      })
    );

    res.json({ orgId: id, schema });
  } catch (err) {
    console.error('Get schema error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
