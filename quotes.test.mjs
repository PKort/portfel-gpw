import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAssetStore } from "./assets.js";
import { createPriceStore } from "./prices.js";
import { createQuoteCollector } from "./quote-collector.js";
import { parseYahooQuote, fetchYahooQuote } from "./yahoo.js";

const meta = { symbol: "PKO.WA", currency: "PLN", exchangeName: "WSE", regularMarketPrice: 74.8, regularMarketTime: 1000 };
const payload = value => ({ chart: { result: [{ meta: value }], error: null } });
const parsed = parseYahooQuote(payload(meta), 'PKO.WA', 'PLN', 2_000_000);
assert.equal(parsed.quotedAt, 1_000_000);
assert.equal(parsed.price, 74.8);
for (const invalid of [{ currency: 'USD' }, { symbol: 'CDR.WA' }, { exchangeName: 'NMS' }, { regularMarketPrice: null }, { regularMarketPrice: -1 }, { regularMarketTime: null }, { regularMarketTime: 9000 }]) {
  assert.throws(() => parseYahooQuote(payload({ ...meta, ...invalid }), 'PKO.WA', 'PLN', 2_000_000));
}
assert.throws(() => parseYahooQuote({ chart: { error: { code: 'Not Found' } } }, 'PKO.WA', 'PLN'));
let url;
await fetchYahooQuote('PKO.WA', 'PLN', { now: 2_000_000, fetchImpl: async input => { url = input; return { ok: true, json: async () => payload(meta) }; } });
assert.ok(url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/PKO.WA?'));
await assert.rejects(fetchYahooQuote('https://bad', 'PLN'));
await assert.rejects(fetchYahooQuote('11BIT.WA', 'PLN', { fetchImpl: async () => ({ ok: false, status: 404 }) }), /11BIT.WA.*HTTP 404.*symbol dostawcy/);
await assert.rejects(fetchYahooQuote('PKO.WA', 'PLN', { fetchImpl: async () => ({ ok: false, status: 429 }) }), e => e.backoff === true);
await assert.rejects(fetchYahooQuote('PKO.WA', 'PLN', { fetchImpl: async () => { throw new Error('timeout'); } }), /połączenia/);
await assert.rejects(fetchYahooQuote('PKO.WA', 'PLN', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad'); } }) }), /JSON/);

const db = new DatabaseSync(':memory:');
try {
  const assets = createAssetStore(db);
  const prices = createPriceStore(db);
  const id = assets.ensure('PKO');
  prices.saveManual(id, 60);
  let clock = 2_000_000, calls = 0, mode = 'error', release;
  const collector = createQuoteCollector(db, prices, { intervalSeconds: 60, now: () => clock, fetchQuote: async (symbol, currency) => {
    calls++;
    assert.equal(symbol, 'PKO.WA'); assert.equal(currency, 'PLN');
    if (mode === 'error') throw new Error('temporary failure');
    if (mode === 'wait') await new Promise(resolve => { release = resolve; });
    if (mode === 'limited') { const error = new Error('HTTP 429'); error.backoff = true; throw error; }
    return mode === 'wait' ? { ...parsed, price: 75, dedupKey: 'new-after-archive' } : parsed;
  } });
  await collector.run();
  assert.equal(calls, 1);
  assert.equal(prices.getQuotes().PKO, 60);
  assert.match(prices.listObserved()[0].lastError, /temporary/);
  const skipped = await collector.run();
  assert.equal(calls, 1); // Interval respected even on failure.
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.nextAttemptAt, clock + 60_000);
  clock += 60_000; mode = 'success';
  assert.equal((await collector.run()).updated, 1);
  assert.equal(prices.getQuotes().PKO, 74.8);
  assert.equal(prices.listObserved()[0].lastError, null);
  clock += 60_000; await collector.run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM price_observations WHERE source_id = 'yahoo'").get().n, 1);
  clock += 60_000; mode = 'wait';
  const first = collector.run(); const second = collector.run();
  assert.equal(first, second); // Only one concurrent request batch.
  assets.remove('PKO'); release(); await first;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM price_observations WHERE source_id = 'yahoo'").get().n, 1);
  const callsBeforeArchive = calls;
  clock += 60_000; await collector.run(); assert.equal(calls, callsBeforeArchive);
  assets.save(null, { ticker: 'PKO', name: 'PKO', symbols: [] });
  mode = 'limited'; assert.equal((await collector.run()).status, 'backoff');
  const before = calls; clock += 60_000;
  assert.equal((await collector.run()).status, 'backoff'); assert.equal(calls, before);
  assert.equal((await collector.refreshAsset(id)).status, 'backoff'); assert.equal(calls, before);
  collector.stop();
  assert.equal((await collector.run()).status, 'disabled');
  const disabled = createQuoteCollector(db, prices, { enabled: false });
  assert.equal((await disabled.run()).status, 'disabled');
  assert.equal(prices.listObserved()[0].status, 'source_disabled');
  disabled.stop();
  console.log('Testy Yahoo Finance: walidacja danych, błędy, interwały, deduplikacja, współbieżność, archiwizacja i limit zapytań OK');
} finally { db.close(); }

// Explicit instrument refresh must switch away from a newer manual quote,
// bypass that instrument's interval, and leave all other instruments untouched.
const targetedDb = new DatabaseSync(':memory:');
try {
  const assets = createAssetStore(targetedDb);
  const prices = createPriceStore(targetedDb);
  const id = assets.ensure('PKO');
  assets.ensure('CDR');
  prices.saveManual(id, 999);
  let calls = 0, fail = true;
  const collector = createQuoteCollector(targetedDb, prices, { now: () => 2_000_000, fetchQuote: async symbol => {
    calls++;
    assert.equal(symbol, 'PKO.WA');
    if (fail) throw new Error('Nie znaleziono symbolu');
    return parsed;
  } });
  assert.equal((await collector.refreshAsset(id)).failed, 1);
  assert.equal(prices.getQuotes().PKO, 999);
  assert.equal(prices.getQuoteDetails().PKO.sourceId, 'manual');
  assert.equal(prices.listObserved().find(row => row.ticker === 'CDR').lastAttemptAt, null);
  fail = false;
  assert.equal((await collector.refreshAsset(id)).updated, 1);
  assert.equal(calls, 2); // No clock advance: explicit refresh bypasses the 5-minute interval.
  assert.equal(prices.getQuotes().PKO, 74.8);
  assert.equal(prices.getQuoteDetails().PKO.sourceId, 'yahoo');
  assert.equal(prices.listObserved().find(row => row.ticker === 'PKO').lastError, null);
  assets.remove('PKO');
  assert.equal((await collector.refreshAsset(id)).updated, 0);
  assert.equal(calls, 2);
  collector.stop();
  console.log('Testy przełączania źródła: wymuszenie pojedynczego kursu, nowsza cena ręczna, zachowanie danych przy błędzie OK');
} finally { targetedDb.close(); }
