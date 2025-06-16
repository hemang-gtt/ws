const { LRUCache } = require('lru-cache');
const mongoose = require('mongoose');
const logError = require('../logs/index');

const LINK = process.env.MONGO_URI;
const MaxConnection = isNaN(Number(process.env.MAX_CONNECTION)) ? 5 : Number(process.env.MAX_CONNECTION);
const TimeToLive = isNaN(Number(process.env.TTL)) ? 1 : Number(process.env.TTL);
const MaxPoolSize = isNaN(Number(process.env.MAX_POOL_SIZE)) ? 10 : Number(process.env.MAX_POOL_SIZE);
const ServerSelectionTimeout = isNaN(Number(process.env.SERVER_SELECTION_TIMEOUT))
  ? 5000
  : Number(process.env.SERVER_SELECTION_TIMEOUT);
const SocketTimeoutMs = isNaN(Number(process.env.SOCKET_TIMEOUT)) ? 45000 : Number(process.env.SOCKET_TIMEOUT);

const connectionCache = new LRUCache({
  max: Number(MaxConnection),
  ttl: 1000 * 60 * Number(TimeToLive),
  ttlAutopurge: true, // ! need to check what it will do
  dispose: async (connection, dbName) => {
    if (connection && typeof connection.close === 'function') {
      console.log(`Closing inactive connection: ${dbName}`);
      await connection.close();
    } else {
      console.warn(`Invalid connection object for ${dbName}`);
    }
  },
});

const getDatabaseConnection = async (dbName) => {
  if (connectionCache.has(dbName)) {
    return connectionCache.get(dbName);
  }

  try {
    const connection = await mongoose
      .createConnection(LINK, {
        dbName: dbName,
        maxPoolSize: Number(MaxPoolSize),
        serverSelectionTimeoutMS: Number(ServerSelectionTimeout),
        socketTimeoutMS: Number(SocketTimeoutMs),
      })
      .asPromise();

    let isPreviousConnection = connectionCache.get(dbName);
    if (!isPreviousConnection) {
      logger.info(`Connected to database>>>: ${dbName}`);
      connectionCache.set(dbName, connection); // ✅ Store only the connection object
      return connection;
    } else {
      console.log(`Already present in  cache >>>: ${dbName}`);
      return connectionCache.get(dbName);
    }
  } catch (error) {
    logError(`Error connecting to ${dbName}: `, error);
    console.error(`Error connecting to ${dbName}:`, error);
    throw error;
  }
};

const getModel = async (DbName, modelName, schema) => {
  const db = await getDatabaseConnection(DbName);
  return db.model(modelName, schema);
};

const closeAllConnections = async () => {
  console.log('Closing all database connections...');
  for (const [dbName, connection] of connectionCache.entries()) {
    await connection.close();
    console.log(`Closed connection for ${dbName}`);
  }
};

// Handle process exit events
process.on('SIGINT', async () => {
  await closeAllConnections();
  process.exit(0);
});

module.exports = { getModel, getDatabaseConnection };
