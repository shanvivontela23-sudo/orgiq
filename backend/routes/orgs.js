'use strict';

const express  = require('express');
const axios    = require('axios');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { getSalesforceOAuthConfig } = require('../lib/salesforceOAuth');

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
      .select('id, org_id, org_name, instance_url, org_type, connected_at')
      .eq('user_id', userId)
      .order('connected_at', { ascending: false });

    if (error) throw new Error(error.message);

    res.json({ orgs: orgs || [] });
  } catch (err) {
    console.error('List orgs error:', err);
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
      .select('instance_url, access_token')
      .eq('id', id)
      .single();

    if (fetchErr) throw new Error(fetchErr.message);

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

    const { error: deleteErr } = await supabase
      .from('connected_orgs')
      .delete()
      .eq('id', id);

    if (deleteErr) throw new Error(deleteErr.message);

    res.json({ id, message: 'Org disconnected' });
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
