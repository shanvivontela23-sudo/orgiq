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

// Deploy queue — handles all Metadata API operations (object create, field add,
// tab create, profile access). Keeps deploys off the HTTP request/response cycle
// so proxy timeouts don't kill 3-minute Metadata API polls.
const deployQueue = new Queue('deploys', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 2,              // auto-retry once on transient SF errors
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 200 },
  },
});

let redisErrorLogged = false;
const onQueueError = (err) => {
  if (!redisErrorLogged) {
    console.warn('[queue] Redis unavailable — background jobs will not run. Run: brew services start redis');
    redisErrorLogged = true;
  }
};
migrationQueue.on('error', onQueueError);
deployQueue.on('error', onQueueError);

module.exports = { migrationQueue, deployQueue };
