'use strict';

const redis = require('./redisClient');

const SESSION_TTL_SECONDS = 60 * 60 * 2;

function key(sessionId) {
  return `generator:session:${sessionId}`;
}

async function getSession(sessionId) {
  const raw = await redis.get(key(sessionId));
  return raw ? JSON.parse(raw) : null;
}

async function saveSession(sessionId, session) {
  await redis.set(key(sessionId), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
}

async function deleteSession(sessionId) {
  await redis.del(key(sessionId));
}

module.exports = { getSession, saveSession, deleteSession };
