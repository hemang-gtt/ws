const jwt = require('jsonwebtoken');
const axios = require('axios');
const { redisClient: redis, redisDb } = require('../DB/redis');
const { rng } = require('./rng');
const logger = require('./logger');
const getTodayDateTime = () => {
  const currentDate = new Date();

  const year = currentDate.getFullYear();
  const month = String(currentDate.getMonth() + 1).padStart(2, '0');
  const day = String(currentDate.getDate()).padStart(2, '0');

  const hours = String(currentDate.getHours()).padStart(2, '0');
  const minutes = String(currentDate.getMinutes()).padStart(2, '0');
  const seconds = String(currentDate.getSeconds()).padStart(2, '0');

  const formattedDateTime = `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
  return formattedDateTime;
};

const hasDateChanged = (epoch1, epoch2) => {
  const date1 = new Date(epoch1 * 1000);
  const date2 = new Date(epoch2 * 1000);

  const year1 = date1.getUTCFullYear;
  const month1 = date1.getUTCMonth;
  const day1 = date1.getUTCDay;

  const year2 = date2.getUTCFullYear;
  const month2 = date2.getUTCMonth;
  const day2 = date2.getUTCDay;

  return (year1 !== year2) & (month1 !== month2) && day1 !== date2;
};

const isValidUserId = (userId, urlToken) => {
  const tokenData = jwt.verify(urlToken, process.env.JWT_SECRET_KEY);
  return tokenData.userId === userId;
};

const hasPreviousSession = async (userId, urlToken) => {
  let existingToken = await redis.get(`${redisDb}-user:${userId}`);
  if (existingToken && existingToken === urlToken) {
    let userExists = await redis.get(`${redisDb}-token:${urlToken}`);
    if (!userExists) {
      return false;
    }
  }
  return true;
};

const getTokenDetails = (urlToken) => {
  const tokenData = jwt.verify(urlToken, process.env.JWT_SECRET_KEY);
  return tokenData;
};

const isValidCurrencyProxy = async (currency) => {
  try {
    let finalURL = process.env.CURRENCY_URL + `/is-valid-currency/${currency}`;
    const headers = { info: process.env.DB_NAME };
    let resp = await axios.get(finalURL, { headers, timeout: 10000 });
    return { status: 'SUCCESS', ...resp.data };
  } catch (error) {
    return {
      status: 'ERROR',
      currency: currency,
      isValid: false,
    };
  }
};

const currencyAPIProxy = async (currency, min, max, step = null, isStepArray = false) => {
  try {
    //! what is step array ? step = ?
    let finalURL = process.env.CURRENCY_URL + `/get-currency/${currency}/${min}/${max}`;
    if (step != null) finalURL += `/${step}`;
    if (isStepArray) finalURL += `/${isStepArray}`;

    const headers = { info: process.env.DbName };
    let resp = await axios.get(finalURL, { headers, timeout: 10000 });
    return { status: 1, ...resp.data };
  } catch (error) {
    let resp = {
      status: 0,
      message: 'Request timed out',
      min,
      max,
      base: Math.max(min, 1),
    };

    if (step != null) resp.step = step;
    const arr = [];
    if (step && isStepArray) {
      let minInt = min * 100,
        maxInt = max * 100,
        stepInt = step * 100;
      for (let i = minInt; i <= maxInt; i += stepInt) {
        arr.push(Number((i / 100).toFixed(2)));
      }
      resp.arr = arr;
    }

    return resp;
  }
};

const CurrencyAPI = async (currency) => {
  try {
    const game = process.env.GAME_NAME;
    const vendor = process.env.VENDOR_NAME;

    logger.info(`game is -----${game}---------vendor is ------${vendor}`);

    let finalURL = process.env.CURRENCY_URL + `/get-currency-range/${currency}/${game}/${vendor}`;

    const headers = { info: process.env.DB_NAME };
    let resp = await axios.get(finalURL, { headers, timeout: 10000 });
    return { status: 1, ...resp.data };
  } catch (error) {
    let resp = {
      status: 0,
      range: [
        0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.75, 0.85, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7,
        8, 9, 10, 12, 15, 18, 20, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 120, 125, 140, 150, 160, 175, 180,
        200,
      ],
      buttons: [0.2, 0.3, 0.5, 1, 5, 10, 50, 200],
      featureBuyRange: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2],
      defaultBet: 1,
    };

    return resp;
  }
};

const getRandom = (min, max) => {
  // get random integer number
  min = Math.ceil(min); // Inclusive lower bound
  max = Math.floor(max); // Exclusive upper bound
  return rng('integer', min, max);
};

const getRandomNumber = (digit) => {
  return Math.random().toFixed(digit).split('.')[1];
};

const verifyCurrentSession = async (token, timestamp) => {
  let redisTimestamp = await redis.get(`${redisDb}-token:${token}`);
  if (redisTimestamp && redisTimestamp === timestamp.toString()) {
    return false;
  }
  return true;
};

const verifyToken = (token) => {
  if (!token) return false;
  try {
    jwt.verify(token, process.env.JWT_SECRET_KEY);
    return true;
  } catch (error) {
    return false;
  }
};

const verifyCurrentWebSocketSession = async (token, wsId) => {
  console.log('token is ----------', token);
  console.log('ws id is ----------', wsId);
  let uuid = await redis.get(`${redisDb}-token:${token}`);
  if (uuid && uuid === wsId) {
    return true;
  }
  return false;
};
const isValidTwoDecimalNumber = (input) => {
  console.log('input is -------------', input);
  const regex = /^\d+(\.\d{1,2})?$/;
  if (typeof input !== 'string' && typeof input !== 'number') {
    return false;
  }
  return regex.test(input.toString());
};

const generateRandomId = (minLength, maxLength) => {
  const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let randomId = '';

  for (let i = 0; i < length; i++) {
    randomId += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return randomId + Math.floor(new Date().getTime() / 1000);
};

const isValidBetId = (input) => {
  if (input == null || input.trim() === '') {
    return false; // Return false for null, undefined, or empty/whitespace-only inputs
  }
  return /^[0-9a-zA-Z]+$/.test(input);
};

const calculateMultiplier = (startTime, endTime) => {
  let growthRate = 0.1;
  const elapsed = (endTime - startTime) / 1000; // Elapsed time in seconds
  const multiplier = 1.0 * Math.exp(growthRate * elapsed); // Exponential growth
  return multiplier.toFixed(2); // Limit to 2 decimal places
};
module.exports = {
  getTodayDateTime,
  hasDateChanged,
  isValidUserId,
  hasPreviousSession,
  getTokenDetails,
  isValidCurrencyProxy,
  currencyAPIProxy,
  getRandom,
  isValidTwoDecimalNumber,
  getRandomNumber,
  verifyCurrentSession,
  CurrencyAPI,
  verifyToken,
  verifyCurrentWebSocketSession,
  isValidBetId,
  generateRandomId,

  calculateMultiplier,
};
