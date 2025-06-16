global.logger = require('./utils/logger');
require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const jwt = require('jsonwebtoken');
const uuid = require('uuid');

const app = require('./app');
const { redisClient: redis, redisPubSub, redisDb } = require('./DB/redis');
const {
  verifyToken,
  verifyCurrentWebSocketSession,
  isValidTwoDecimalNumber,
  isValidBetId,
  generateRandomId,
  calculateMultiplier,
} = require('./utils/common');

const { checkAndSetBalance, checkPreviousBets, verifySingleSession } = require('./Controller/controller.js');
const {
  atomicBetValidationScriptForCurrentRound,
  atomicBetValidationScriptForNextRound,
  atomicCashoutScript,
  cancelBetLuaScript,
} = require('./Scripts/luaScripts.js');

const { rateLimitRequest, checkRepeatButton } = require('./utils/rateLimiter');
const { infoLog } = require('./logs/index.js');
const port = process.env.WEBSOCKET_PORT;

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

let gameRunning = false;
let startTime;
let gameCount = 0;

let ping = false;
let pingException = true;
let pingInterval;

wss.on('connection', async (ws, req) => {
  console.log('ws line 25 i ----------');
  // we will listen all the emitted properties from ws ----
  ws.on('message', async (message) => {
    console.log('listening the message --------line 47-------------', message);
    try {
      if (pingException) {
        return ws.send(
          JSON.stringify({
            e: 'Server-Error',
            msg: 'Can not process your request, Something went wrong on the server ',
          })
        );
      }
      const params = new url.URL(req.url, `http://${req.headers.host}`).searchParams;
      const token = params.get('token');
      const userId = params.get('userId');
      const tokenData = jwt.decode(token);

      console.log('token is ---------', token);
      console.log('user id is ---------', userId);
      console.log('token data is -------', tokenData);

      if (process.env.LOAD_TESTING !== 'true') {
        const isCurrentSession = await verifyCurrentWebSocketSession(token, ws.id);

        console.log('is current session --------------', isCurrentSession);
        if (!token || !userId || !verifyToken(token) || !isCurrentSession) {
          ws.send(JSON.stringify({ e: 'Error', msg: 'Token is invalid or previous session is opened! ' }));

          return ws.terminate;
        } else {
          if (!token || !userId) {
            ws.send(JSON.stringify({ e: 'ERROR', msg: `token is invalid or previous session is opened!` }));
            return ws.terminate();
          }
        }
      }

      const data = JSON.parse(message);

      console.log('data is ---- line 84 -------', data);

      if (rateLimitRequest(ws, data)) {
        return ws.send(JSON.stringify({ e: 'Invalid', msg: 'Too many requests!' }));
      }

      let wsData = await redis.get(`${redisDb}-user:${userId}`);

      console.log('ws data is ----------', wsData);

      if (!wsData) {
        return ws.send(JSON.stringify({ e: 'Invalid', msg: `Invalid Request! User not found!!` }));
      }

      wsData = JSON.parse(wsData);

      // now do validation checks for BET ,  CASHOUT, CANCEL BET

      if (data.e === 'Bet') {
        let isValid = isValidTwoDecimalNumber(data.a);
        let isValidBtn = isValidTwoDecimalNumber(data.btn);
        console.log('amount is -----------', data.a);
        console.log('btn is ------', data.btn);
        console.log('is valid is ----------', isValid);
        console.log('isValidBtn is -------', isValidBtn);

        if (
          !isValid ||
          !isValidBtn ||
          !data.a ||
          !data.btn ||
          !data.e ||
          !token ||
          !userId ||
          Number(data.btn) < 1 ||
          Number(data.btn) > 2
        ) {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: 'Invalid Request!' }));
        }

        const isValidCurrency = wsData.c === true || wsData.c === 'true';
        if (!isValidCurrency) {
          return ws.send(JSON.stringify({ e: 'ERROR', msg: 'Currency is Invalid!' }));
        }

        if (Number(data.a) < Number(wsData.minStake)) {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: `Bet Amount cannot be less than ${wsData.minStake}` }));
        } else if (Number(data.a) > Number(wsData.maxStake)) {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: `Bet Amount cannot be greater than ${wsData.maxStake}` }));
        }
        if (checkRepeatButton(ws, data)) {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: `Same button repeated. Try different!` }));
        }

        data.a = parseFloat(data.a);
      } else if (data.e === 'Cashout' || data.e === 'CancelBet') {
        let isValid = isValidBetId(data.id);
        let isValidBtn = isValidTwoDecimalNumber(data.btn);

        console.log('is valid is - and valid btn --', isValid, isValidBtn);
        console.log('data is ----------', data);
        if (
          !isValid ||
          !isValidBtn ||
          !data.id ||
          !data.btn ||
          !data.e ||
          !token ||
          !userId ||
          Number(data.btn) < 1 ||
          Number(data.btn) > 2
        ) {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: `Invalid Request!` }));
        }
      }

      console.log('line 160 --------------');

      // LOGICS ---------------
      if (data.e === 'Bet' && !gameRunning) {
        console.log('line 164 is --------------');
        // game is not running and someone place the bet
        const betId = generateRandomId(4, 5);

        const newBet = { id: betId, bet: data.a, btn: data.btn };

        console.log('new bet is --------', newBet);
        const roomHash = `{room-${gameCount}}`;
        const playerBetsKey = `${redisDb}:${roomHash}-player`;
        const betDetailKey = `${redisDb}:${roomHash}`;

        const luaResult = await redis.eval(
          atomicBetValidationScriptForCurrentRound,
          1,
          playerBetsKey,
          userId,
          JSON.stringify(newBet)
        );

        console.log('lua result is ---------', luaResult);

        if (luaResult === 'MAX_BETS') {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: 'Invalid Request' }));
        }

        if (luaResult === 'DUPLICATE_BET') {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: `Invalid Request! Same Id not allowed.` }));
        }

        console.log('redis key --------------', betDetailKey);
        await redis.hset(
          betDetailKey,
          `${userId}_${betId}`,
          JSON.stringify({ a: data.a, api: 'PENDING', operatorId: tokenData.operatorId })
        );

        console.log(`Player placed a bet: ${data.a}`);
        if (process.env.LOAD_TESTING !== true) {
          const updatedBalance = await checkAndSetBalance(ws, userId, data.a, 'Bet');
          if (updatedBalance.status !== 'SUCCESS') return;

          console.log('updated balance is ----------', updatedBalance);
          let response = {
            e: 'BetPlaced',
            id: betId,
            b: updatedBalance.balance,
            a: data.a,
            btn: data.btn,
            msg: `bet is Placed of amount ${data.a}`,
          };
          infoLog({
            e: 'BetPlaced',
            id: betId,
            b: updatedBalance.balance,
            a: data.a,
            btn: data.btn,
            msg: `bet is placed of amount ${data.a}`,
          });

          console.log('line 223 ---------', response);
          return ws.send(JSON.stringify(response));
        }
        return ws.send(
          JSON.stringify({
            e: 'BetPlaced',
            id: betId,
            a: data.a,
            btn: data.btn,
            msg: `bet is Placed of amount ${data.a}`,
          })
        );
      } else if (data.e === 'Cashout' && gameRunning) {
        console.log('cashout got called -----------', data);
        const userField = `${userId}_${data.id}`;
        console.log('start time is -------', startTime);
        const multiplier = calculateMultiplier(startTime, Date.now());
        console.log('user field ------------', userField);

        console.log('multiplier ------------', multiplier);

        const roomHash = `{room-${gameCount}}`;
        const betKey = `${redisDb}:${roomHash}`;
        console.log('redis key is -----', betKey);
        const cashoutKey = `${redisDb}:${roomHash}-cashout`;
        console.log('cashout key is ----------', cashoutKey);
        const [status, luaMultiplier, luaBetAmountOrMsg] = await redis.eval(
          atomicCashoutScript,
          2,
          betKey,
          cashoutKey,
          userField,
          multiplier.toString(),
          tokenData.operatorId
        );

        console.log('status is -----------------', status);
        if (status !== 1) {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: `Invalid Request! ${luaBetAmountOrMsg}` }));
        }

        console.log(`Player cashed out at ${luaMultiplier}x`);

        if (process.env.LOAD_TESTING !== 'true') {
          const cashoutAmount = luaBetAmountOrMsg * luaMultiplier;
          const updatedBalance = await checkAndSetBalance(ws, userId, cashoutAmount, 'Cashout');

          console.log('updated balance ------------', updatedBalance);
          if (updatedBalance.status !== 'SUCCESS') return;

          infoLog({
            e: 'CashoutDone',
            b: updatedBalance.balance,
            f: luaMultiplier,
            btn: data.btn,
            msg: `Player cashed out at ${luaMultiplier}x`,
          });

          return ws.send(
            JSON.stringify({
              e: 'CashoutDone',
              b: updatedBalance.balance,
              f: luaMultiplier,
              w: cashoutAmount,
              btn: data.btn,
              msg: `Player cashed out at ${luaMultiplier}x`,
            })
          );
        } else {
          return ws.send(
            JSON.stringify({
              e: 'CashoutDone',
              f: luaMultiplier,
              btn: data.btn,
              msg: `Player cashed out at ${luaMultiplier}x`,
            })
          );
        }
      } else if (data.e === 'Bet') {
        console.log('game is running now some one placing the bet:::::');
        const roomHash = `{room-${gameCount + 1}}`;
        const userKey = `${redisDb}:${roomHash}-player`;
        const betDetailKey = `${redisDb}:${roomHash}`;

        console.log(
          `roomHash----------${roomHash}-----------userKey-----------${userKey} ------bet Details key --------${betDetailKey}`
        );

        // const userKey = `${redisDb}:room-${gameCount + 1}-player`;
        // const userField = userId;
        const betId = generateRandomId(4, 5);
        const betObj = { id: betId, bet: data.a, btn: data.btn };
        const betStr = JSON.stringify(betObj);

        const [status, msg] = await redis.eval(
          atomicBetValidationScriptForNextRound,
          1,
          userKey,
          userId,
          betStr,
          data.btn.toString()
        );

        console.log('status is -------------', status);
        console.log('msg is -------------', msg);

        if (status !== 1) {
          return ws.send(JSON.stringify({ e: 'Invalid', msg }));
        }

        // Save to room bet mapping
        await redis.hset(
          betDetailKey,
          `${userId}_${betId}`,
          JSON.stringify({ a: data.a, api: 'PENDING', operatorId: tokenData.operatorId })
        );

        if (process.env.LOAD_TESTING !== 'true') {
          const updatedBalance = await checkAndSetBalance(ws, userId, data.a, 'Bet');
          if (updatedBalance.status !== 'SUCCESS') return;
          infoLog({
            e: 'WaitingForNextRound',
            id: betId,
            b: updatedBalance.balance,
            a: data.a,
            btn: data.btn,
            msg: 'Waiting For Next Round',
          });
          return ws.send(
            JSON.stringify({
              e: 'WaitingForNextRound',
              id: betId,
              b: updatedBalance.balance,
              a: data.a,
              btn: data.btn,
              msg: 'Waiting For Next Round',
            })
          );
        } else {
          return ws.send(
            JSON.stringify({
              e: 'WaitingForNextRound',
              id: betId,
              a: data.a,
              btn: data.btn,
              msg: 'Waiting For Next Round',
            })
          );
        }
      } else if (data.e === 'CancelBet') {
        const userField = `${userId}_${data.id}`;
        let betKey, userBetsKey, roomHash;

        if (gameRunning) {
          roomHash = `{room-${gameCount + 1}}`;
        } else {
          roomHash = `{room-${gameCount}}`;
        }

        betKey = `${redisDb}:${roomHash}`;
        userBetsKey = `${redisDb}:${roomHash}-player`;

        // Execute Lua script atomically
        const [status, betAmountOrMsg] = await redis.eval(
          cancelBetLuaScript,
          2,
          betKey,
          userBetsKey,
          userField,
          userId,
          data.id
        );

        if (status !== 1) {
          return ws.send(JSON.stringify({ e: 'Invalid', msg: `Invalid Request! ${betAmountOrMsg}` }));
        }

        // On success
        if (process.env.LOAD_TESTING !== 'true') {
          const updatedBalance = await checkAndSetBalance(ws, userId, betAmountOrMsg, 'CancelBet');

          console.log('updated balance is -----------', updatedBalance);
          if (updatedBalance.status !== 'SUCCESS') return;

          infoLog({ e: 'BetCancelled', b: updatedBalance.balance, msg: `Bet is Cancelled`, btn: data.btn });
          return ws.send(
            JSON.stringify({ e: 'BetCancelled', b: updatedBalance.balance, msg: `Bet is Cancelled`, btn: data.btn })
          );
        } else {
          return ws.send(JSON.stringify({ e: 'BetCancelled', msg: `Bet is Cancelled`, btn: data.btn }));
        }
      } else {
        console.log('invalid request! no event find --------------');
        return ws.send(JSON.stringify({ e: 'Invalid', msg: `Invalid Request!` }));
      }
    } catch (error) {
      console.log(error);
      return ws.send(JSON.stringify({ e: 'Invalid', msg: `Invalid Request!` }));
    }
  });

  // at time of close

  ws.on('close', async () => {
    // someone trying to close the session , remove the data from redis

    const params = new url.URL(req.url, `http://${req.headers.host}`).searchParams;
    console.log('params are ---------', params);
    const token = params.get('token');
    const userId = params.get('userId');

    console.log('token ---------------', token);

    if (token && userId && verifyToken(token) && process.env.LOAD_TESTING !== 'true') {
      const uuid = await redis.get(`${redisDb}-token:${token}`);

      if (uuid === ws.id) {
        console.log('deleting the token ---------', `${redisDb}-token:${token}`);
        await redis.del(`${redisDb}-token:${token}`);
      }

      console.log('close api called ----------');
    }
  });

  ws.on('error', (error) => {
    console.log('some error came=---------------');
    console.log(`Error: ` + error);
  });

  if (pingException) {
    ws.send(
      JSON.stringify({ e: 'SERVER-ERROR', msg: `Cannot process your request. something went wrong on the server!` })
    );
    return ws.terminate();
  }
  if (gameCount === 0) {
    let isGameData = await getGameData();
    if (!isGameData) {
      ws.send(
        JSON.stringify({ e: 'SERVER-ERROR', msg: `Cannot process your request. something went wrong on the server!` })
      );
      return ws.terminate();
    }
  }
  const params = new url.URL(req.url, `http://${req.headers.host}`).searchParams;
  const token = params.get('token');
  const userId = params.get('userId');

  console.log('token is -----------', token);
  console.log('user id is ---------', userId);

  if (process.env.LOAD_TESTING !== 'true') {
    // main logic
    const wsId = uuid.v4();
    ws.id = wsId;
    console.log('wsID is ----------', wsId);
    let session = await verifySingleSession(userId, token, wsId);
    console.log('session is --------', session);
    let verification = verifyToken(token);
    console.log('verification  is ------', verification);

    if (!token || !userId || !verifyToken(token) || !session) {
      // console.log(token, userId, wsId)

      console.log('coming here -----------');
      ws.send(JSON.stringify({ e: 'ERROR', msg: `token is invalid or previous session is opened!` }));
      return ws.terminate();
    }

    console.log('session is -----------', session);

    const isValidCurrencyCheck = session.c === false || session.c === 'false';
    if (isValidCurrencyCheck) {
      return ws.send(JSON.stringify({ e: 'ERROR', msg: `Currency is Invalid!` }));
    }
    const { t, ...sessionWithoutToken } = session;
    console.log('session without token ------------', sessionWithoutToken);

    ws.send(
      JSON.stringify({
        e: 'User',
        ...sessionWithoutToken,
      })
    );
  } else {
    // dummy logic
    if (!token || !userId) {
      ws.send(JSON.stringify({ e: 'ERROR', msg: `token is invalid or previous session is opened!` }));
      return ws.terminate();
    }

    ws.send(JSON.stringify({ e: 'User', u: 'test_user', b: '997.25' }));
  }

  console.log('line 473 ----------------');
  await checkPreviousBets(ws, userId, gameCount, gameRunning);

  if (gameRunning) {
    return ws.send(JSON.stringify({ e: 'OnRunning', ts: startTime, cts: Date.now().toString() }));
  }
});

// Hand shake done --------
server.on('upgrade', (request, socket, head) => {
  console.log('line 84 -------------');

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(port, async () => {
  logger.info(`Server is running on the web socket port ----${port}`);
  const channelName = `${process.env.REDIS_DB_NAME}-pubsub`;
  logger.info(`Channel name is ---------${JSON.stringify(channelName)}`);
  try {
    pingInterval = setInterval(() => {
      if (!ping && !pingException) {
      }
    }, 12 * 1000);

    redisPubSub.subscribe(channelName, (err, count) => {
      if (err) {
        logger.info(`Error is ------${err}`);
      } else {
        logger.info(`Subscribed Successfully! The client is currently connected to ${count} channels---`);
      }
    });

    redisPubSub.on('message', (channel, message) => {
      message = JSON.parse(message);
      if (channel === channelName) {
        pingException = false;
        ping = true; // setting that ping is true
        let data;

        if (message.e === 'OnStart') {
          gameRunning = true;
          startTime = Number(message.ts);
          gameCount = Number(message.l);

          data = { e: message.e, ts: message.ts, l: message.l };
        } else if (message.e === 'OnCrash') {
          gameRunning = false;
          gameCount = Number(message.l);
          data = {
            e: message.e,
            ts: message.ts,
            f: message.f,
          };

          console.log('data is -----------', data);
        }

        if (message.e === 'OnStart' || message.e === 'OnCrash') {
          logger.info(`data getting published to all clients -------${JSON.stringify(data)}`);
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        } else if (message.e === 'OnReady') {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(message));
            }
          });
        } else if (message.e === 'OnStartUsers' || message.e === 'CashOutUsers') {
          wss.clients.forEach(async (client) => {
            if (client.readyState === WebSocket.OPEN) {
              data = message.users;
              client.send(JSON.stringify(data));
            }
          });
        }
      }
    });

    await getGameData();
  } catch (error) {
    console.log('error is ------', error);
  }
});

async function getGameData() {
  try {
    let game = await redis.hmget(`${redisDb}:Game`, 'StartTime', 'Count', 'isGameRunning');

    if (game) {
      startTime = Number(game[0]);
      gameCount = Number(game[1]);
      gameRunning = game[2] === 'true' ? true : false;
      pingException = false;
    }

    return true;
  } catch (error) {
    console.log('Error connecting in backend --------------');

    return false;
  }
}

let isCleaningUp = false;
function cleanup() {
  if (isCleaningUp) {
    return;
  }

  isCleaningUp = true;
  logger.info(`Clean up initialised -------`);

  if (pingInterval) {
    clearInterval(pingInterval);

    logger.info(`Ping interval cleared --------`);
  }

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ e: 'Server-Error', msg: 'Server is shutting down.' }), () => {
        client.close(); // close the ws connection from wss
      });
    }
  });
  // close all the web socket connections ----------

  wss.close(() => {
    logger.info(`Web sockets are closed -----------`);
    server.close(() => {
      logger.info(`Http server closed ------`);
      process.exit(0); // exit the process after the server has closed
    });
  });

  // In case of any delay, force exit after a timeout
  setTimeout(() => {
    console.error('Forcing shutdown...');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', cleanup); // pm2 process got killed inside docker
process.on('SIGINT', cleanup); // ctrl + c
