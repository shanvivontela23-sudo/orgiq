require('dotenv').config();

let connection;

function getRedisConnection() {
  if (connection) return connection;

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);

  connection = {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    ...(url.password ? { password: url.password } : {}),
  };

  return connection;
}

module.exports = { getRedisConnection };
