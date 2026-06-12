'use strict';

/**
 * OrgIQ uses a single Connected App registered in OrgIQ's own Salesforce org.
 * All customer orgs (source, target, sandbox) authorize through this one app —
 * exactly how Copado, Gearset, and every serious SF ISV works.
 *
 * Users never create their own Connected App. They just click "Connect"
 * and authorize OrgIQ's app against their org.
 *
 * For production: register one Connected App at login.salesforce.com
 * and set ORGIQ_SF_CLIENT_ID + ORGIQ_SF_CLIENT_SECRET in your env.
 * For sandbox orgs: user passes instanceUrl with test.salesforce.com —
 * we detect it and use the right login URL automatically.
 */
function getSalesforceOAuthConfig(orgType = 'source', instanceUrl = null) {
  if (orgType === 'target' && process.env.SF_TARGET_CLIENT_ID && process.env.SF_TARGET_CLIENT_SECRET) {
    return {
      clientId:     process.env.SF_TARGET_CLIENT_ID,
      clientSecret: process.env.SF_TARGET_CLIENT_SECRET,
      redirectUri:  process.env.SF_TARGET_REDIRECT_URI || process.env.SF_REDIRECT_URI,
      loginUrl:     (process.env.SF_TARGET_LOGIN_URL || process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, ''),
    };
  }

  // Detect sandbox from instance URL if provided
  const isSandbox = instanceUrl
    ? instanceUrl.includes('test.salesforce.com') || instanceUrl.includes('sandbox')
    : false;

  const loginUrl = isSandbox
    ? 'https://test.salesforce.com'
    : process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

  return {
    clientId:     process.env.ORGIQ_SF_CLIENT_ID     || process.env.SF_CLIENT_ID,
    clientSecret: process.env.ORGIQ_SF_CLIENT_SECRET || process.env.SF_CLIENT_SECRET,
    redirectUri:  process.env.SF_REDIRECT_URI,
    loginUrl:     loginUrl.replace(/\/$/, ''),
  };
}

module.exports = { getSalesforceOAuthConfig };
