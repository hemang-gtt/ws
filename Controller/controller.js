const { logError } = require('../logs/index');
const { redisClient: redis, redisDb } = require('../DB/redis');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const luaScript = `
    local key = KEYS[1]
    local amount = tonumber(ARGV[1])
    local event = ARGV[2]

    local userData = redis.call("GET", key)
    if not userData then return "ERROR_SESSION_EXPIRED" end

    local user = cjson.decode(userData)
    local balance = tonumber(user.b)

    if event == "Bet" then
        if balance < amount then return "ERROR_INSUFFICIENT_FUNDS" end
        balance = balance - amount
    elseif event == "CancelBet" or event == "Cashout" then
        balance = balance + amount
    end

    user.b = balance
    redis.call("SET", key, cjson.encode(user), "EX", 3600)

    return string.format("%.2f", balance)  -- Ensure decimal precision
`;

const checkAndSetBalance = async (ws, userId, amount, event) => {
  try {
    console.log('inside lua script checking and setting the balance --------');
    const redisKey = `${redisDb}-user:${userId}`;
    amount = parseFloat(amount);

    console.log('amount is -----------', amount);

    const result = await redis.eval(luaScript, 1, redisKey, amount, event);

    console.log('result is -----------', result);

    if (result === 'ERROR_SESSION_EXPIRED') {
      ws.send(JSON.stringify({ e: 'ERROR', msg: 'Session expired!' }));
      ws.terminate();
      return { status: 'ERROR' };
    } else if (result === 'ERROR_INSUFFICIENT_FUNDS') {
      ws.send(JSON.stringify({ e: 'Invalid', msg: 'Insufficient Fund!' }));
      return { status: 'ERROR' };
    }

    console.log(`BALANCE UPDATED::::::::::::::::::: ${result}`);
    return { status: 'SUCCESS', balance: parseFloat(result) }; // Convert string back to float
  } catch (error) {
    logError(error);
    return { status: 'ERROR' };
  }
};

const checkPreviousBets = async (ws, userId, gameCount, gameRunning) => {
  try {
    console.log('gameCount::::::::::::: ' + gameCount);
    let response = [];
    // check in current game and than in next game
    let userBets = await redis.hget(`${redisDb}:room-${gameCount}-player`, userId);
    let userBetsNextRound = await redis.hget(`${redisDb}:room-${gameCount + 1}-player`, userId);

    console.log('user bets are --------', userBets);

    if (userBets) {
      userBets = JSON.parse(userBets);
      let betArr = [];
      userBets.forEach((bet) => betArr.push(`${userId}_${bet.id}`));
      let cashouts = await redis.hmget(`${redisDb}:room-${gameCount}-cashout`, betArr);
      for (let i = 0; i < cashouts.length; i++) {
        if (cashouts[i] === null) {
          response.push({ betId: userBets[i].id, betAmount: userBets[i].bet, btn: userBets[i].btn });
        }
      }
    }

    if (userBetsNextRound) {
      userBetsNextRound = JSON.parse(userBetsNextRound);
      let betArr = [];
      userBetsNextRound.forEach((bet) => betArr.push(`${userId}_${bet.id}`));
      let cashouts = await redis.hmget(`${redisDB}:room-${gameCount + 1}-cashout`, betArr);
      for (let i = 0; i < cashouts.length; i++) {
        if (cashouts[i] === null) {
          response.push({
            betId: userBetsNextRound[i].id,
            betAmount: userBetsNextRound[i].bet,
            btn: userBetsNextRound[i].btn,
            isNextRound: true,
          });
        }
      }
    }

    for (let i = 0; i < response.length; i++) {
      if (response[i].isNextRound || !gameRunning) {
        ws.send(
          JSON.stringify({
            e: 'WaitingForNextRound',
            id: response[i].betId,
            a: response[i].betAmount,
            btn: response[i].btn,
            msg: 'Waiting For Next Round',
            interrupted: true,
          })
        );
      } else {
        ws.send(
          JSON.stringify({
            e: 'BetPlaced',
            id: response[i].betId,
            a: response[i].betAmount,
            btn: response[i].btn,
            msg: `bet is Placed of amount ${response[i].betAmount}`,
            interrupted: true,
          })
        );
      }
    }

    return { status: 'SUCCESS' };
  } catch (error) {
    console.log('error is ------------', error);
    logError(error);
    return { status: 'ERROR' };
  }
};

// ! will check the internal API url call why it's name is verify single session ?
const verifySingleSession = async (userId, token, wsId) => {
  try {
    console.log('redis db is ----------', redisDb, wsId);
    let wsData = await redis.get(`${redisDb}-user:${userId}`);

    console.log('line 135 ----------------');

    // fetch the consumer id using token -----
    // console.log(JSON.parse(wsData), 'FirstData', token);

    if (wsData && JSON.parse(wsData).t === token) {
      wsData = JSON.parse(wsData);

      console.log('ws data going is ------------', wsData);
      console.log('userID is --------', userId, token);
      const basePath = process.env.BASE_PATH;
      let url;
      if (basePath === '') {
        url = `${process.env.INTERNAL_API_URL}/${process.env.BASE_PATH}getBalance`;
      } else {
        url = `${process.env.INTERNAL_API_URL}/${process.env.BASE_PATH}/getBalance`;
      }

      console.log('url is -----------', url);
      let json = await axios.post(
        url,
        { userId: userId, token: token },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.INTERNAL_API_HEADER_TOKEN}`,
          },
        }
      );
      console.log('data came from api micro service is ---', json.data);
      wsData.multiplier = json.data.multiplier;

      if (Number(json.data.balance) !== wsData.b) {
        wsData.b = Number(json.data.balance);
        wsData.c = json.data.isValidCurrency;
        wsData.multiplier = json.data.multiplier;

        wsData.range = json.data.range;
        wsData.buttons = json.data.buttons;
        wsData.defaultBet = json.data.defaultBet;

        await redis.set(`${redisDb}-user:${userId}`, JSON.stringify(wsData), 'EX', 3600);
      }

      let userExists = await redis.get(`${redisDb}-token:${token}`);

      console.log('id is -----------------', wsId);
      console.log('userExist: ' + userExists);
      if (!userExists) {
        await redis.set(`${redisDb}-token:${token}`, wsId, 'EX', 3600);
        return wsData;
      } else if (userExists !== null) {
        await redis.del(`${redisDb}-token:${token}`);
        await redis.set(`${redisDb}-token:${token}`, wsId, 'EX', 3600);
        return wsData;
      }
    }

    // comment return false; for load testing
    return null;
  } catch (error) {
    console.log(error);
    return null;
  }
};

module.exports = { checkAndSetBalance, checkPreviousBets, verifySingleSession };

/*exports.verifyToken = (token) => {
  if (!token) return false;
  try {
    jwt.verify(token, process.env.JWT_SECRET_KEY);
    return true;
  } catch (error) {
    return false;
  }
};

exports.getUserId = (token) => {
  if (!token) return null;
  try {
    const decodedData = jwt.verify(token, process.env.JWT_SECRET_KEY);
    return decodeduserId === undefined ? null : decodeduserId;
  } catch (error) {
    return null;
  }
};

exports.verifyCurrentSession = async (token, wsId) => {
  let uuid = await redis.get(`${redisDB}-token:${token}`);
  if (uuid && uuid === wsId) {
    return true;
  }
  return false;
};

exports.verifySingleSession = async (userId, token, wsId) => {
  try {
    let wsData = await redis.get(`${redisDB}-user:${userId}`);
    // console.log(JSON.parse(wsData), 'FirstData', token);

    if (wsData && JSON.parse(wsData).t === token) {
      wsData = JSON.parse(wsData);
      // console.log(wsData, 'IN IF BLOCK')

      let json = await axios.post(
        `${process.env.INTERNAL_API_URL}`,
        { userId: userId, token: token },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.INTERNAL_API_HEADER_TOKEN}`,
          },
        }
      );
      // console.log('JSON', json.data);
      wsData.multiplier = json.data.multiplier;

      if (Number(json.data.balance) !== wsData.b) {
        wsData.b = Number(json.data.balance);
        wsData.c = json.data.isValidCurrency;
        wsData.multiplier = json.data.multiplier;

        wsData.range = json.data.range;
        wsData.buttons = json.data.buttons;
        wsData.defaultBet = json.data.defaultBet;

        await redis.set(`${redisDB}-user:${userId}`, JSON.stringify(wsData), 'EX', 3600);
      }

      let userExists = await redis.get(`${redisDB}-token:${token}`);
      // console.log("userExist: " + userExists);
      if (!userExists) {
        await redis.set(`${redisDB}-token:${token}`, wsId, 'EX', 3600);
        return wsData;
      } else if (userExists !== null) {
        await redis.del(`${redisDB}-token:${token}`);
        await redis.set(`${redisDB}-token:${token}`, wsId, 'EX', 3600);
        return wsData;
      }
    }

    // comment return false; for load testing
    return null;
  } catch (error) {
    console.log(error);
    return null;
  }
};
*/
