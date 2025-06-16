const crypto = require('crypto');

function rng(type, min, max, decimalPlaces) {
  if (type === 'integer') {
    return crypto.randomInt(min, max);
  } else if (type === 'float') {
    const randomBytes = crypto.randomBytes(8);
    const randomInt = (randomBytes.readUInt32BE(0) * 2 ** 21 + (randomBytes.readUInt32BE(4) >>> 11)) / 2 ** 53;
    const randomFloat = min + randomInt * (max - min);
    const factor = Math.pow(10, decimalPlaces);
    return Math.floor(randomFloat * factor) / factor;
  }
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

module.exports = { rng, shuffle };
