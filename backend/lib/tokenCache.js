'use strict';

/**
 * tokenCache.js
 * Redis-backed OAuth token cache for connected Salesforce orgs.
 *
 * Problem it solves:
 *   withSalesforceClient refreshes the SF access token on EVERY API call.
 *   Under concurrent load (25 orgs, multiple simultaneous requests per org),
 *   multiple parallel refreshes for the same org race each other — each call
 *   gets a new token, all but the last are immediately invalidated by SF,
 *   causing 401s on in-flight requests.
 *
 * Solution:
 *   Cache the refreshed token in Redis with a 90-minute TTL.
 *   SF tokens live 2 hours; we refresh 30 min early so we're never stale.
 *   If Redis is unavailable, fall through to direct refresh (safe degradation).
 */

const redis = require('./redisClient');

const TTL_SECONDS = 90 * 60; // 90 minutes

function cacheKey(orgId) {
  return `sftoken:${orgId}`;
}

/**
 * Get cached token for an org. Returns null if not cached or Redis down.
 */
async function getCachedToken(orgId) {
  try {
    const raw = await redis.get(cacheKey(orgId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // Redis unavailable — safe degradation
  }
}

/**
 * Store refreshed token in Redis.
 * @param {string} orgId
 * @param {{ access_token: string, instance_url: string }} token
 */
async function setCachedToken(orgId, token) {
  try {
    await redis.set(cacheKey(orgId), JSON.stringify(token), 'EX', TTL_SECONDS);
  } catch {
    // Redis unavailable — non-fatal, next request will refresh again
  }
}

/**
 * Invalidate cached token (call when org is disconnected or token explicitly revoked).
 */
async function invalidateToken(orgId) {
  try {
    await redis.del(cacheKey(orgId));
  } catch { /* non-fatal */ }
}

module.exports = { getCachedToken, setCachedToken, invalidateToken };
