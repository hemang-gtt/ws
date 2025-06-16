const rateLimitRequest = (ws, data) => {
  const isRateLimitedEvent = data.e === 'Bet' || data.e === 'Cashout' || data.e === 'CancelBet';

  if (!isRateLimitedEvent) return false;

  const now = Date.now();
  const WINDOW_DURATION_MS = 1000; // 1 second
  const MAX_REQUESTS_PER_WINDOW = 4;

  // Initialize rate limiter per user/session
  if (!ws.rateLimiter) {
    ws.rateLimiter = {
      count: 0,
      lastReset: now,
    };
  }

  // Reset if outside current window
  if (now - ws.rateLimiter.lastReset > WINDOW_DURATION_MS) {
    ws.rateLimiter.count = 0;
    ws.rateLimiter.lastReset = now;
  }

  ws.rateLimiter.count++;

  if (ws.rateLimiter.count > MAX_REQUESTS_PER_WINDOW) {
    return true; // request was rate-limited
  }

  return false; // request is valid
};
const checkRepeatButton = (ws, data) => {
  const now = Date.now();

  if (!ws.lastBtnCheck) {
    ws.lastBtnCheck = { btn: data.btn, timestamp: now };
    return false;
  }

  // Check if same button was used in the last second
  const isSameBtn = ws.lastBtnCheck.btn == data.btn;
  const within1Sec = now - ws.lastBtnCheck.timestamp < 1000;

  if (isSameBtn && within1Sec) {
    return true;
  }

  // Update the last button
  ws.lastBtnCheck = { btn: data.btn, timestamp: now };
  return false;
};

module.exports = { rateLimitRequest, checkRepeatButton };
