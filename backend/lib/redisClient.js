'use strict';

const IORedis = require('ioredis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: false,
});

redis.on('error', (err) => {
  if (process.env.NODE_ENV !== 'test') {
    console.warn('[redis] generator cache/session error:', err.message);
  }
});

module.exports = redis;
