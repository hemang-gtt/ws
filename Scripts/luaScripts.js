exports.atomicBetValidationScriptForCurrentRound = `
local key = KEYS[1]
local userId = ARGV[1]
local newBet = cjson.decode(ARGV[2])
local btn = newBet["btn"]

local userBetsJson = redis.call("HGET", key, userId)
if userBetsJson then
    local userBets = cjson.decode(userBetsJson)
    if #userBets >= 2 then
        return "MAX_BETS"
    end
    for i = 1, #userBets do
        if userBets[i]["btn"] == btn then
            return "DUPLICATE_BET"
        end
    end
    table.insert(userBets, newBet)
    redis.call("HSET", key, userId, cjson.encode(userBets))
    return "SUCCESS"
else
    redis.call("HSET", key, userId, cjson.encode({newBet}))
    return "SUCCESS"
end
`;

exports.atomicBetValidationScriptForNextRound = `
local key = KEYS[1]
local field = ARGV[1]
local newBet = ARGV[2]
local newBtn = tonumber(ARGV[3])

local existing = redis.call("HGET", key, field)
if existing then
    local decoded = cjson.decode(existing)
    if #decoded >= 2 then
        return {0, "Two Bets already Placed"}
    end
    for _, bet in ipairs(decoded) do
        if tonumber(bet.btn) == newBtn then
            return {0, "Same Id not allowed"}
        end
    end
    table.insert(decoded, cjson.decode(newBet))
    redis.call("HSET", key, field, cjson.encode(decoded))
else
    redis.call("HSET", key, field, "[" .. newBet .. "]")
end
return {1, ""}
`;

exports.atomicCashoutScript = `
local betKey = KEYS[1]
local cashoutKey = KEYS[2]
local field = ARGV[1]
local multiplier = tonumber(ARGV[2])
local operatorId = ARGV[3]

local cashoutExists = redis.call("HGET", cashoutKey, field)
if cashoutExists then
    return {0, 0, "Already Cashed Out"}
end

local betDataRaw = redis.call("HGET", betKey, field)
if not betDataRaw then
    return {0, 0, "No Bet Found"}
end

local betData = cjson.decode(betDataRaw)
local betAmount = tonumber(betData.a)

local cashoutData = {
    f = multiplier,
    b = betAmount,
    api = "PENDING",
    operatorId = operatorId
}

redis.call("HSET", cashoutKey, field, cjson.encode(cashoutData))
return {1, multiplier, betAmount}
`;

exports.cancelBetLuaScript = `
local betKey = KEYS[1]
local userBetsKey = KEYS[2]
local field = ARGV[1]

local betDataRaw = redis.call("HGET", betKey, field)
if not betDataRaw then
    return {0, "No Bet Found"}
end

redis.call("HDEL", betKey, field)

local userBetsRaw = redis.call("HGET", userBetsKey, ARGV[2])
local userId = ARGV[2]

if userBetsRaw then
    local userBets = cjson.decode(userBetsRaw)
    local newBets = {}
    for i, bet in ipairs(userBets) do
        if bet.id ~= ARGV[3] then
            table.insert(newBets, bet)
        end
    end

    if #newBets == 0 then
        redis.call("HDEL", userBetsKey, userId)
    else
        redis.call("HSET", userBetsKey, userId, cjson.encode(newBets))
    end
end

local betData = cjson.decode(betDataRaw)
return {1, betData.a}
`;
