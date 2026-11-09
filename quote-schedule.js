export const scheduleDefaults = { activityStart: '0800', activityEnd: '1800', activityFreqs: 5, nonactivityFreqs: 300, tokenLimit: 10000 };
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

export function validateSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Podaj harmonogram notowań.');
  const result = {};
  for (const key of ['activityStart', 'activityEnd']) {
    if (typeof input[key] !== 'string' || !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(input[key])) fail('Godziny harmonogramu muszą mieć format HHMM, np. 0800.');
    result[key] = input[key];
  }
  if (result.activityStart === result.activityEnd) fail('Początek i koniec aktywności muszą być różne.');
  for (const key of ['activityFreqs', 'nonactivityFreqs', 'tokenLimit']) {
    if (!Number.isSafeInteger(input[key]) || input[key] < (key === 'tokenLimit' ? 0 : 1) || input[key] > (key === 'tokenLimit' ? 1_000_000_000 : 86400)) fail('Interwały muszą być całkowite od 1 do 86400 sekund, a limit dzienny od 0 do 1 000 000 000.');
    result[key] = input[key];
  }
  return result;
}

export function scheduleFromEnv(env) {
  return validateSchedule({
    activityStart: env.ACTIVITY_START ?? env.ACTIVITIY_START ?? scheduleDefaults.activityStart,
    activityEnd: env.ACTIVITY_END ?? scheduleDefaults.activityEnd,
    activityFreqs: Number(env.ACTIVITY_FREQS ?? env.ACTIVITIY_FREQS ?? scheduleDefaults.activityFreqs),
    nonactivityFreqs: Number(env.NONACTIVITY_FREQS ?? scheduleDefaults.nonactivityFreqs),
    tokenLimit: Number(env.TOKEN_LIMIT ?? scheduleDefaults.tokenLimit),
  });
}

const warsaw = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function parts(time) { return Object.fromEntries(warsaw.formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, part.value])); }
const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
function activeMinute(config, minute) {
  const start = minutes(config.activityStart), end = minutes(config.activityEnd);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
export function scheduleInterval(config, time = Date.now()) {
  const local = parts(time);
  return activeMinute(config, Number(local.hour) * 60 + Number(local.minute)) ? config.activityFreqs : config.nonactivityFreqs;
}

function midnight(year, month, day) {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess);
    guess += target - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  }
  return guess;
}
let durationCache;
export function estimateDailyTokens(config, feeds, { now = Date.now(), enabled = true } = {}) {
  const local = parts(now);
  const date = `${local.year}-${local.month}-${local.day}`;
  const cacheKey = `${date}:${config.activityStart}:${config.activityEnd}`;
  if (durationCache?.key !== cacheKey) {
    const start = midnight(Number(local.year), Number(local.month), Number(local.day));
    const next = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) + 1));
    const end = midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
    let activitySeconds = 0;
    for (let time = start; time < end; time += 60000) {
      const p = parts(time);
      if (activeMinute(config, Number(p.hour) * 60 + Number(p.minute))) activitySeconds += 60;
    }
    durationCache = { key: cacheKey, activitySeconds, nonactivitySeconds: (end - start) / 1000 - activitySeconds };
  }
  const { activitySeconds, nonactivitySeconds } = durationCache;
  const tracked = feeds.filter(feed => feed.status === 'configured');
  const bossa = tracked.filter(feed => feed.sourceId === 'bossa').length;
  // Single-instrument batch costs 1, a batch of 2..20 costs 2 points.
  const batchCost = Math.floor(bossa / 20) * 2 + (bossa % 20 === 1 ? 1 : bossa % 20 > 1 ? 2 : 0);
  const cycles = Math.ceil(activitySeconds / config.activityFreqs) + Math.ceil(nonactivitySeconds / config.nonactivityFreqs);
  // Include one metadata refresh per day. Full tariff is a conservative estimate;
  // market calendars, provider discounts, retries and manual requests can differ.
  const dataTokens = enabled ? cycles * batchCost : 0;
  const metadataTokens = enabled ? batchCost : 0;
  const dailyTokens = dataTokens + metadataTokens;
  return { date, timezone: 'Europe/Warsaw', trackedInstruments: tracked.length, bossaInstruments: bossa, activitySeconds, nonactivitySeconds, cycles, batchCost, dataTokens, metadataTokens, dailyTokens, tokenLimit: config.tokenLimit, warning: dailyTokens > config.tokenLimit, enabled };
}
