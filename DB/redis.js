const { Redis } = require('ioredis');

let redisClient;

if (process.env.IS_CLUSTER === 'true') {
  redisClient = new Redis.Cluster([{ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) }], {
    redisOptions: {
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
    },
  });
} else {
  redisClient = new Redis({
    username: process.env.REDIS_USERNAME,
    port: Number(process.env.REDIS_PORT),
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD,
  });
}

const redisPubSub = new Redis({
  username: process.env.REDIS_USERNAME,
  port: process.env.REDIS_PORT,
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASSWORD,
});

redisClient.on('error', (err) => {
  console.log('error -------------', err);
  logger.info('error while connecting redis');
});

const deleteAllRedisKeysOfGame = (gameCount) => {
  console.log('game count is ---------', gameCount);
  redisClient.keys(`${redisDb}:{*room-${gameCount}-player}`, (err, keys) => {
    if (err) return console.log(err);
    if (keys.length === 0) {
      return;
    }

    const deletePromises = keys.map((key) => redisClient.del(key));
    Promise.all(deletePromises)
      .then((results) => {
        console.log(`Deleted ${results.length} keys`);
      })
      .catch((deleteErr) => {
        console.error('Error deleting keys:', deleteErr);
      });
  });
};

const deleteAllRedisKeysWithApiSuccess = async (gameCount) => {
  const hashKey = `${redisDb}:{room-${gameCount}}`;

  console.log('hash key is -----------', hashKey);

  try {
    const userBets = await redisClient.hgetall(hashKey);

    console.log('user bets are ---------', userBets);

    if (!userBets || Object.keys(userBets).length === 0) {
      console.log('No fields found for deletion.');
      return;
    }

    const deletePromises = Object.entries(userBets).map(async ([field, value]) => {
      try {
        const parsedValue = JSON.parse(value);
        if (parsedValue.api === 'SUCCESS') {
          await redisClient.hdel(hashKey, field); // Delete the specific field from the hash
        }
      } catch (err) {
        console.error(`Error processing field: ${field}, value: ${value}`, err);
      }
    });

    await Promise.all(deletePromises);
    console.log('Deletion process completed.');
  } catch (err) {
    console.error('Error accessing Redis:', err);
  }
};
const redisDb = process.env.DB_NAME;

logger.info(`Connected to redis on the port ${process.env.REDIS_PORT} and database name is ${redisDb}`);

module.exports = { redisClient, redisDb, redisPubSub, deleteAllRedisKeysOfGame, deleteAllRedisKeysWithApiSuccess };
