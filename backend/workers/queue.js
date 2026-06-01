const { Queue } = require('bullmq');
const { getRedisConnection } = require('./redisConnection');

const migrationQueue = new Queue('migrations', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 200 },
  },
});

// Silence Redis reconnect spam in local dev — log once, then quiet.
let redisErrorLogged = false;
migrationQueue.on('error', (err) => {
  if (!redisErrorLogged) {
    console.warn('[queue] Redis unavailable — migrations will not run until Redis is started. Run: brew install redis && brew services start redis');
    redisErrorLogged = true;
  }
});

module.exports = { migrationQueue };
