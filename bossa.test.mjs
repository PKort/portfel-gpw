import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBossaClient, parseBossaQuote } from './bossa.js';
import { normalizeProviderSymbol, validIsin } from './providers.js';
import { createAssetStore } from './assets.js';
import { createPriceStore } from './prices.js';
import { createQuoteCollector } from './quote-collector.js';

const symbol = 'GPW:PLPKO0000016', other = 'GPW:PLPKN0000018';
const time = Date.UTC(2026, 9, 30, 16);
const info = { source: 'GPW', isin: symbol.slice(4), curr: 'PLN', mult: '1', ticker: 'PKO' };
const feed = { assetId: 'pko', sourceSymbol: symbol, currency: 'PLN', isin: null };
const data = { op: 'data', [symbol]: { p: 74.8, t: (time - 60000) / 1000, c: 100 } };
assert.equal(validIsin(symbol.slice(4)), true);
assert.equal(normalizeProviderSymbol('bossa', ' plpko0000016 '), symbol);
for (const value of ['PKO', 'GPW:PLPKO0000017', 'XET:PLPKO0000016', 'GPW:PLDEMO000000', 'https://evil']) assert.throws(() => normalizeProviderSymbol('bossa', value));
const quote = parseBossaQuote(data, info, feed, time);
assert.equal(quote.price, 74.8);
assert.equal(quote.quotedAt, time - 60000);
for (const change of [{ source: 'XET' }, { isin: 'PLPKN0000018' }, { curr: 'EUR' }, { mult: '100' }]) assert.throws(() => parseBossaQuote(data, { ...info, ...change }, feed, time));
assert.throws(() => parseBossaQuote(data, info, { ...feed, isin: 'PLPKN0000018' }, time));
for (const change of [{ p: null }, { p: -1 }, { p: '74.8' }, { t: null }, { t: '1000' }, { t: 0 }, { t: time / 1000 + 120 }]) {
  assert.throws(() => parseBossaQuote({ ...data, [symbol]: { ...data[symbol], ...change } }, info, feed, time));
}
assert.throws(() => parseBossaQuote({ op: 'data', 'GPW:PLDEMO000000': data[symbol] }, info, feed, time));

const response = (payload, status = 200, headers = {}) => ({ ok: status === 200, status, headers: new Headers(headers), json: async () => payload });
const requests = [];
let clock = time, key = 'test-private-key', mode = 'ok';
const client = createBossaClient({ readKey: async () => key + '\n', now: () => clock, fetchImpl: async (url, options) => {
  requests.push(url);
  assert.equal(options.headers.Authorization, key);
  assert.equal(options.redirect, 'error');
  assert.ok(!url.includes(key));
  if (mode === 'secretError') throw new Error(key);
  if (mode === 'unauthorized') return response({ op: 'error', code: 401, text: key });
  if (mode === 'monthly' || mode === 'minute') {
    if (url.endsWith('/limits')) return response({ op: 'limits', month: { remaining: mode === 'monthly' ? 0 : 100 } });
    return response({ op: 'error', code: 429, text: key }, 429, { 'retry-after': '120' });
  }
  if (url.includes('/info/')) return response({ op: 'info', [symbol]: info, [other]: { ...info, isin: other.slice(4), ticker: 'PKN' } });
  return response(mode === 'partial' ? data : { ...data, [other]: { p: 100, t: data[symbol].t } });
} });
assert.equal((await client.fetchBatch([feed])).get('pko').quote.price, 74.8);
assert.equal(requests.length, 2);
await client.fetchBatch([feed]); assert.equal(requests.length, 3); // Cached metadata.
key = 'rotated-key'; await client.fetchBatch([feed]); assert.equal(requests.length, 5);
clock += 24 * 60 * 60_000; await client.fetchBatch([feed]); assert.equal(requests.length, 7);
mode = 'partial';
const partial = await client.fetchBatch([feed, { ...feed, assetId: 'pkn', sourceSymbol: other }]);
assert.ok(partial.get('pko').quote);
assert.match(partial.get('pkn').error.message, /brak danych/);
assert.ok(requests.at(-1).endsWith(`/data/${symbol},${other}`));
for (const [value, expected] of [['secretError', /połączenia/], ['unauthorized', /wygasły klucz/]]) {
  mode = value;
  await assert.rejects(client.fetchBatch([feed]), error => { assert.match(error.message, expected); assert.ok(!error.message.includes(key)); return true; });
}
mode = 'minute'; await assert.rejects(client.fetchBatch([feed]), error => error.backoffMs === 120_000);
mode = 'monthly'; await assert.rejects(client.fetchBatch([feed]), error => error.backoffMs > 120_000 && /miesięczny/.test(error.message));
for (const invalidKey of ['', '0000', 'invalid key']) {
  key = invalidKey;
  const before = requests.length;
  await assert.rejects(client.fetchBatch([feed]));
  assert.equal(requests.length, before);
}
await assert.rejects(createBossaClient({ readKey: async () => { throw new Error('secret path'); } }).fetchBatch([feed]), /BOSSA_QUOTES_API_KEY/);
await assert.rejects(createBossaClient({ apiKey: '' }).fetchBatch([feed]), /uzupełnij BOSSA_QUOTES_API_KEY/);
let authorization;
await createBossaClient({ apiKey: 'env-test-key', now: () => time, fetchImpl: async (url, options) => {
  authorization = options.headers.Authorization;
  return response(url.includes('/info/') ? { op: 'info', [symbol]: info } : data);
} }).fetchBatch([feed]);
assert.equal(authorization, 'env-test-key');
await assert.rejects(createBossaClient({ readKey: async () => 'valid', fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('secret'); } }) }).fetchBatch([feed]), /JSON/);

// Collector batching, partial success, state races and independent provider backoff.
const db = new DatabaseSync(':memory:');
try {
  const assets = createAssetStore(db), prices = createPriceStore(db);
  let calls = 0, release, waiting = false, limited = false;
  const batches = [];
  const collector = createQuoteCollector(db, prices, { now: () => time, fetchBossaBatch: async feeds => {
    calls++; batches.push(feeds.length);
    if (waiting) await new Promise(resolve => { release = resolve; });
    if (limited) throw Object.assign(new Error('Limit minutowy'), { backoffMs: 60000 });
    return new Map(feeds.map(item => [item.assetId, item.ticker === 'A00' ? { error: new Error('Brak danych') } : { quote: waiting ? { ...quote, price: 99, dedupKey: 'late-response' } : quote }]));
  }, fetchQuote: async () => quote });
  for (let i = 0; i < 22; i++) {
    const id = assets.ensure(`A${String(i).padStart(2, '0')}`);
    prices.saveManual(id, 50);
    prices.saveFeedSettings(id, 'bossa', { bossa: symbol });
  }
  const yahooId = assets.ensure('YAHOO');
  prices.saveFeedSettings(yahooId, 'yahoo', { yahoo: 'PKO.WA' });
  let result = await collector.run();
  assert.deepEqual(batches, [20, 2]);
  assert.equal(result.updated, 22); assert.equal(result.failed, 1);
  assert.equal(prices.getQuoteDetails().A00.sourceId, 'manual');
  assert.equal(prices.getQuoteDetails().A01.sourceId, 'bossa');
  const before = db.prepare('SELECT COUNT(*) n FROM price_observations').get().n;
  await collector.refreshAsset(assets.ensure('A01'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM price_observations').get().n, before);
  const interval = await collector.run(); assert.equal(interval.skipped, 23);
  waiting = true;
  const pending = collector.refreshAsset(assets.ensure('A02'));
  assets.remove('A02'); release(); await pending;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM price_observations WHERE asset_id = ?").get(assets.ensure('A02')).n, 2);
  const id = assets.ensure('A03');
  const oldSuccess = prices.listObserved().find(item => item.assetId === id).lastSuccessAt;
  const raced = collector.refreshAsset(id);
  prices.saveFeedSettings(id, 'yahoo', { yahoo: 'PKO.WA' });
  release(); await raced; waiting = false;
  assert.equal(prices.listObserved().find(item => item.assetId === id).lastSuccessAt, null);
  assert.ok(oldSuccess);
  limited = true;
  assert.equal((await collector.refreshAsset(assets.ensure('A04'))).status, 'backoff');
  const callsBefore = calls;
  assert.equal((await collector.refreshAsset(assets.ensure('A05'))).status, 'backoff');
  assert.equal(calls, callsBefore);
  assert.equal((await collector.refreshAsset(yahooId)).updated, 1);
  collector.stop();
} finally { db.close(); }

// Full REST adapter -> collector -> SQLite path with a partially missing metadata response.
const integrationDb = new DatabaseSync(':memory:');
try {
  const assets = createAssetStore(integrationDb), prices = createPriceStore(integrationDb);
  const urls = [];
  const rest = createBossaClient({ now: () => time, readKey: async () => 'private-key', fetchImpl: async url => {
    urls.push(url);
    return response(url.includes('/info/') ? { op: 'info', [symbol]: info } : data);
  } });
  const collector = createQuoteCollector(integrationDb, prices, { now: () => time, fetchBossaBatch: rest.fetchBatch });
  const id = assets.ensure('PKO'), missingId = assets.ensure('PKN');
  for (const [assetId, alias] of [[id, symbol], [missingId, other]]) {
    prices.saveManual(assetId, 50);
    prices.saveFeedSettings(assetId, 'bossa', { bossa: alias });
  }
  const result = await collector.run();
  assert.equal(result.updated, 1); assert.equal(result.failed, 1);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes(symbol) && urls[0].includes(other));
  assert.ok(urls[1].endsWith(`/data/${symbol}`));
  assert.equal(prices.getQuoteDetails().PKO.sourceId, 'bossa');
  assert.equal(prices.getQuoteDetails().PKO.quotedAt, quote.quotedAt);
  assert.equal(prices.getQuotes().PKN, 50);
  assert.equal(prices.getQuoteDetails().PKN.sourceId, 'manual');
  collector.stop();
} finally { integrationDb.close(); }
console.log('Testy bossaAPI: ISIN, metadane, ceny i czas, grupowanie, częściowe odpowiedzi, sekrety, limity i zmiany konfiguracji OK');
