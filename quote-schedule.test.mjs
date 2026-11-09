import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scheduleFromEnv, scheduleDefaults, validateSchedule, scheduleInterval, estimateDailyTokens } from './quote-schedule.js';
import { createQuoteScheduleStore } from './quote-schedule-store.js';
import { createAssetStore } from './assets.js';
import { createPriceStore } from './prices.js';
import { createQuoteCollector } from './quote-collector.js';

const config = scheduleFromEnv({ ACTIVITIY_START: '0800', ACTIVITY_END: '1800', ACTIVITIY_FREQS: '5', NONACTIVITY_FREQS: '300', TOKEN_LIMIT: '10000' });
assert.deepEqual(config, scheduleDefaults);
assert.equal(scheduleFromEnv({ ACTIVITY_START: '0900', ACTIVITIY_START: '0800', ACTIVITY_FREQS: '10', ACTIVITIY_FREQS: '5' }).activityStart, '0900');
assert.equal(scheduleFromEnv({ ACTIVITY_FREQS: '10' }).activityFreqs, 10);
for (const invalid of [{ activityStart: '800' }, { activityStart: '2400' }, { activityEnd: '1860' }, { activityEnd: '0800' }, { activityFreqs: 0 }, { nonactivityFreqs: 1.5 }, { tokenLimit: -1 }, { activityFreqs: '5' }]) assert.throws(() => validateSchedule({ ...config, ...invalid }));
// November is UTC+1, June UTC+2. Start inclusive, end exclusive.
assert.equal(scheduleInterval(config, Date.parse('2026-11-09T06:59:59Z')), 300);
assert.equal(scheduleInterval(config, Date.parse('2026-11-09T07:00:00Z')), 5);
assert.equal(scheduleInterval(config, Date.parse('2026-11-09T17:00:00Z')), 300);
assert.equal(scheduleInterval(config, Date.parse('2026-06-09T06:00:00Z')), 5);
const overnight = { ...config, activityStart: '2200', activityEnd: '0600' };
assert.equal(scheduleInterval(overnight, Date.parse('2026-11-09T23:00:00Z')), 5);
assert.equal(scheduleInterval(overnight, Date.parse('2026-11-09T04:59:59Z')), 5);
assert.equal(scheduleInterval(overnight, Date.parse('2026-11-09T05:00:00Z')), 300);
const feeds = number => Array.from({ length: number }, (_, i) => ({ assetId: String(i), sourceId: 'bossa', status: 'configured' }));
const now = Date.parse('2026-11-09T12:00:00Z');
const estimate = estimateDailyTokens(config, feeds(20), { now });
assert.equal(estimate.activitySeconds, 36000);
assert.equal(estimate.nonactivitySeconds, 50400);
assert.equal(estimate.cycles, 7368);
assert.equal(estimate.dailyTokens, 14738);
assert.equal(estimate.warning, true);
assert.equal(estimateDailyTokens({ ...config, tokenLimit: 14738 }, feeds(20), { now }).warning, false);
assert.equal(estimateDailyTokens(config, feeds(1), { now }).batchCost, 1);
assert.equal(estimateDailyTokens(config, feeds(21), { now }).batchCost, 3);
assert.equal(estimateDailyTokens(config, [], { now }).dailyTokens, 0);
assert.equal(estimateDailyTokens(config, [...feeds(1), { sourceId: 'bankier', status: 'configured' }, { sourceId: 'bossa', status: 'source_disabled' }], { now }).bossaInstruments, 1);
assert.equal(estimateDailyTokens(config, feeds(20), { now, enabled: false }).dailyTokens, 0);
for (const [date, seconds] of [['2026-03-29T12:00:00Z', 23 * 3600], ['2026-10-25T12:00:00Z', 25 * 3600]]) {
  const result = estimateDailyTokens(overnight, feeds(1), { now: Date.parse(date) });
  assert.equal(result.activitySeconds + result.nonactivitySeconds, seconds);
  assert.equal(result.activitySeconds, (seconds === 23 * 3600 ? 7 : 9) * 3600);
}

const db = new DatabaseSync(':memory:');
try {
  const assets = createAssetStore(db), prices = createPriceStore(db);
  let store = createQuoteScheduleStore(db, {});
  store.save({ ...config, activityFreqs: 2, activityStart: '0900' });
  store = createQuoteScheduleStore(db, {});
  assert.equal(store.get().activityFreqs, 2); // GUI persists across restart.
  store = createQuoteScheduleStore(db, { ACTIVITIY_FREQS: '10' });
  assert.equal(store.get().activityFreqs, 10); // Changed env field overrides GUI.
  assert.equal(store.get().activityStart, '0900'); // Unchanged fields retain GUI edits.
  assert.throws(() => store.save({ ...config, activityFreqs: 0 }));
  assert.equal(store.get().activityFreqs, 10);
  store = createQuoteScheduleStore(db, { ACTIVITIY_START: '0800', ACTIVITY_END: '0900' });
  assert.equal(store.get().activityStart, '0800'); // Conflicting persisted hours reset to baseline.
  const id = assets.ensure('PKO');
  let clock = Date.parse('2026-11-09T06:59:50Z'), calls = 0, release;
  store.save(config);
  const collector = createQuoteCollector(db, prices, {
    now: () => clock, getIntervalSeconds: time => scheduleInterval(store.get(), time),
    fetchQuote: async () => {
      calls++;
      if (release === 'wait') await new Promise(resolve => { release = resolve; });
      return { price: 10, currency: 'PLN', priceType: 'last', quotedAt: clock, dedupKey: String(clock) };
    },
  });
  await collector.refreshAsset(id);
  clock += 6000; assert.equal((await collector.run()).skipped, 1); // Still inactive.
  clock = Date.parse('2026-11-09T07:00:00Z');
  assert.equal((await collector.run()).updated, 1); // Boundary immediately shortens interval.
  clock += 4000; assert.equal((await collector.run()).skipped, 1);
  clock += 1000; assert.equal((await collector.run()).updated, 1); // Five seconds, no 30s tick floor.
  assert.equal(prices.listObserved()[0].pollIntervalSeconds, 5);
  store.save({ ...config, activityFreqs: 1 });
  clock += 1000; assert.equal((await collector.run()).updated, 1); // GUI change without restart.
  release = 'wait'; clock += 1000;
  const pending = collector.run(); assert.equal(collector.run(), pending);
  release(); await pending;
  clock = Date.parse('2026-11-09T17:00:00Z');
  await collector.run(); clock += 5000;
  assert.equal((await collector.run()).skipped, 1);
  assert.equal(prices.listObserved()[0].pollIntervalSeconds, 300);
  assert.equal(calls, 6);
  collector.stop();
} finally { db.close(); }
console.log('Testy harmonogramu: granice godzin, noc, DST, estymacja punktów, trwałość GUI i env, interwał 5s i zmiany bez restartu OK');
