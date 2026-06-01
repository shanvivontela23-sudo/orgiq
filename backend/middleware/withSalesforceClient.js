'use strict';

const axios = require('axios');
const supabase = require('../lib/supabase');
const SalesforceClient = require('../lib/SalesforceClient');
const { getSalesforceOAuthConfig } = require('../lib/salesforceOAuth');

async function refreshOrgToken(orgId, org) {
  if (!org.refresh_token) return org;

  const oauthConfig = getSalesforceOAuthConfig(org.org_type);
  const { data: tokenData } = await axios.post(
    `${oauthConfig.loginUrl}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: oauthConfig.clientId,
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

async function withSalesforceClient(req, res, next) {
  try {
    const orgId = req.body?.orgId || req.query?.orgId;
    if (!orgId) {
      return res.status(400).json({ error: 'orgId is required' });
    }

    const { data: org, error } = await supabase
      .from('connected_orgs')
      .select('id, user_id, org_id, org_name, org_type, access_token, refresh_token, instance_url')
      .eq('id', orgId)
      .single();

    if (error || !org) {
      return res.status(404).json({ error: `Connected org not found: ${error?.message || orgId}` });
    }

    if (req.user?.id && org.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Org does not belong to the signed-in user' });
    }

    const refreshed = await refreshOrgToken(orgId, org);
    req.orgConn = refreshed;
    req.sf = new SalesforceClient({
      accessToken: refreshed.access_token,
      instanceUrl: refreshed.instance_url,
    });

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { withSalesforceClient };
