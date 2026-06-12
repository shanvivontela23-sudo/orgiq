'use strict';

/**
 * rateLimiter.js
 *
 * Simple in-memory per-user rate limiter for Claude API endpoints.
 * Prevents duplicate submissions and abuse without needing Redis.
 *
 * Usage:
 *   const { checkRateLimit, releaseSlot } = require('./rateLimiter');
 *
 *   if (!checkRateLimit(userId, 'generate', 3)) {
 *     return res.status(429).json({ error: 'Too many concurrent requests. Please wait.' });
 *   }
 *   try { ... } finally { releaseSlot(userId, 'generate'); }
 */

// Map<action, Map<userId, count>>
const counts = new Map();

/**
 * Try to acquire a slot. Returns false if limit exceeded.
 * @param {string} userId
 * @param {string} action   e.g. 'generate', 'preflight', 'deploy'
 * @param {number} max      Max concurrent requests for this action per user
 */
function checkRateLimit(userId, action, max = 1) {
  if (!counts.has(action)) counts.set(action, new Map());
  const actionMap = counts.get(action);
  const current = actionMap.get(userId) || 0;
  if (current >= max) return false;
  actionMap.set(userId, current + 1);
  return true;
}

/**
 * Release a slot after the operation completes or fails.
 */
function releaseSlot(userId, action) {
  if (!counts.has(action)) return;
  const actionMap = counts.get(action);
  const current = actionMap.get(userId) || 0;
  if (current <= 1) {
    actionMap.delete(userId);
  } else {
    actionMap.set(userId, current - 1);
  }
}

/**
 * Express middleware factory — wraps a route with rate limiting.
 * Automatically releases the slot when the response finishes.
 */
function withRateLimit(action, max = 1) {
  return (req, res, next) => {
    const userId = req.user?.id || req.body?.userId || 'anonymous';
    if (!checkRateLimit(userId, action, max)) {
      return res.status(429).json({
        error: 'You already have a request in progress. Please wait for it to complete.',
        code: 'RATE_LIMITED',
      });
    }
    // Release on response finish (success, error, or client disconnect)
    res.on('finish', () => releaseSlot(userId, action));
    res.on('close',  () => releaseSlot(userId, action));
    next();
  };
}

module.exports = { checkRateLimit, releaseSlot, withRateLimit };
