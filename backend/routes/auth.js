'use strict';

const express  = require('express');
const axios    = require('axios');
const crypto   = require('crypto');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { getSalesforceOAuthConfig } = require('../lib/salesforceOAuth');

// In-memory store for PKCE verifiers (keyed by state)
const pkceStore = new Map();

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * GET /auth/salesforce
 * Initiate Salesforce OAuth flow with PKCE.
 * Query params: orgType ('source' | 'target'), userId
 */
router.get('/salesforce', (req, res) => {
  const { userId, orgType = 'source' } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const oauthConfig = getSalesforceOAuthConfig(orgType);

  const state = Buffer.from(JSON.stringify({ userId, orgType })).toString('base64');
  const { verifier, challenge } = generatePKCE();
  pkceStore.set(state, verifier);

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             oauthConfig.clientId,
    redirect_uri:          oauthConfig.redirectUri,
    scope:                 'api refresh_token offline_access id',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });

  res.redirect(`${oauthConfig.loginUrl}/services/oauth2/authorize?${params}`);
});

/**
 * GET /auth/salesforce/callback
 * Exchange auth code for tokens, upsert org into connected_orgs, redirect to dashboard.
 */
router.get('/salesforce/callback', async (req, res) => {
  const { code, state, error: sfError } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redirectWithError = (errorCode, detail) => {
    const params = new URLSearchParams({ error: errorCode });
    if (detail) params.set('detail', detail);
    return res.redirect(`${frontendUrl}/dashboard?${params.toString()}`);
  };

  if (sfError) {
    console.error('Salesforce OAuth error:', sfError);
    return redirectWithError('oauth_failed', String(sfError));
  }

  if (!code || !state) {
    console.error('Salesforce OAuth callback missing code or state');
    return redirectWithError('oauth_missing_params');
  }

  try {
    const { userId, orgType } = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    const oauthConfig = getSalesforceOAuthConfig(orgType);

    // Retrieve PKCE verifier
    const codeVerifier = pkceStore.get(state);
    pkceStore.delete(state);

    // Exchange code for tokens
    const tokenParams = {
      grant_type:    'authorization_code',
      code,
      client_id:     oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
      redirect_uri:  oauthConfig.redirectUri,
    };
    if (codeVerifier) tokenParams.code_verifier = codeVerifier;

    const { data: tokenData } = await axios.post(
      `${oauthConfig.loginUrl}/services/oauth2/token`,
      new URLSearchParams(tokenParams),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, instance_url, id: sfIdUrl } = tokenData;

    // Fetch org identity
    const { data: identity } = await axios.get(sfIdUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { organization_id: org_id, display_name: org_name } = identity;

    // Ensure the profile row exists before connected_orgs FK insert.
    const { error: profileError } = await supabase.from('user_profiles').upsert(
      { id: userId },
      { onConflict: 'id' }
    );

    if (profileError && !profileError.message?.includes("user_profiles")) {
      throw new Error(`Supabase profile upsert failed: ${profileError.message}`);
    }

    if (profileError) {
      console.warn(`Skipping user_profiles upsert: ${profileError.message}`);
    }

    // Persist to connected_orgs
    const { error: dbError } = await supabase.from('connected_orgs').upsert(
      {
        user_id:       userId,
        org_id,
        org_name,
        instance_url,
        access_token,
        refresh_token,
        org_type:      orgType,
        connected_at:  new Date().toISOString(),
      },
      { onConflict: 'user_id,org_id' }
    );

    if (dbError) throw new Error(`Supabase upsert failed: ${dbError.message}`);

    console.log(`Connected org: ${org_name} (${org_id}) for user ${userId} as ${orgType}`);
    res.redirect(`${frontendUrl}/dashboard?connected=true`);
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    redirectWithError('token_exchange_failed', err.response?.data?.error_description || err.message);
  }
});

module.exports = router;
