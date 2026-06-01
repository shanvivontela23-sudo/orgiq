'use strict';

function getSalesforceOAuthConfig(orgType = 'source') {
  const isTarget = orgType === 'target' && process.env.SF_TARGET_CLIENT_ID;
  const loginUrl = isTarget
    ? process.env.SF_TARGET_LOGIN_URL || 'https://login.salesforce.com'
    : process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

  return {
    clientId: isTarget ? process.env.SF_TARGET_CLIENT_ID : process.env.SF_CLIENT_ID,
    clientSecret: isTarget ? process.env.SF_TARGET_CLIENT_SECRET : process.env.SF_CLIENT_SECRET,
    redirectUri: isTarget
      ? process.env.SF_TARGET_REDIRECT_URI || process.env.SF_REDIRECT_URI
      : process.env.SF_REDIRECT_URI,
    loginUrl: loginUrl.replace(/\/$/, ''),
  };
}

module.exports = { getSalesforceOAuthConfig };
