import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseBankierQuote, fetchBankierQuote } from './bankier.js';
import { createAssetStore } from './assets.js';
import { createPriceStore } from './prices.js';
import { createQuoteCollector } from './quote-collector.js';
import { migrateDatabase } from './database.js';

// Minimal provider HTML contract: scoped header, identity, price and actual quotation time.
const html = (date = '2026-10-22 16:59:00', price = '1,4500', symbol = 'PRIME') => `<div id="quotes-profile-header-box" data-symbol="${symbol}" data-isin="PLRKLMF00010"><div class="o-quotes-profile-header-box__price"><span class="a-quote-item -value">${price}&nbsp;zł</span></div><span class="-date">Czw. ${date}</span></div>`;
const time = Date.UTC(2026, 9, 22, 18);
const quote = parseBankierQuote(html(), 'PRIME', 'PLN', time);
assert.equal(quote.price, 1.45);
assert.equal(quote.quotedAt, Date.UTC(2026, 9, 22, 14, 59));
assert.equal(parseBankierQuote(html('2026-01-22 16:59:00'), 'PRIME', 'PLN', time).quotedAt, Date.UTC(2026, 0, 22, 15, 59));
assert.equal(parseBankierQuote(html('2026-10-22 16:59:00', '1 234,5678'), 'PRIME', 'PLN', time).price, 1234.5678);
for (const [page, symbol, currency, isin] of [
  [html(), 'OTHER', 'PLN'], [html(), 'PRIME', 'EUR'], [html(), 'PRIME', 'PLN', 'PLPKO0000016'],
  [html('2026-02-30 16:00:00'), 'PRIME', 'PLN'], [html('2026-10-25 02:30:00'), 'PRIME', 'PLN'],
  [html('2030-01-01 16:00:00'), 'PRIME', 'PLN'], [html('2026-10-22 16:00:00','-1'), 'PRIME', 'PLN'],
  [html('2026-10-22 16:00:00','N/D'), 'PRIME', 'PLN'], ['<html>captcha</html>', 'PRIME', 'PLN'],
]) assert.throws(() => parseBankierQuote(page, symbol, currency, time, isin));
let requested;
await fetchBankierQuote('PRIME', 'PLN', { now: time, fetchImpl: async url => { requested = url; return { ok: true, text: async () => html() }; } });
assert.equal(requested, 'https://www.bankier.pl/inwestowanie/profile/quote.html?symbol=PRIME');
await assert.rejects(fetchBankierQuote('https://evil', 'PLN'));
await assert.rejects(fetchBankierQuote('PRIME', 'PLN', { fetchImpl: async () => ({ ok: false, status: 403 }) }), e => e.backoff);

const db = new DatabaseSync(':memory:');
try {
  const assets = createAssetStore(db);
  const id = assets.ensure('PRIME');
  const otherId = assets.ensure('OTHER');
  const prices = createPriceStore(db);
  let clock = time;
  let failBankier = false;
  let limitYahoo = false;
  let release;
  let waitYahoo = false;
  const calls = [];
  const collector = createQuoteCollector(db, prices, { now: () => clock, fetchProviders: {
    yahoo: async symbol => {
      calls.push(['yahoo',symbol]);
      if (waitYahoo) await new Promise(resolve => { release = resolve; });
      if (limitYahoo) { const e = new Error('429'); e.backoff = true; throw e; }
      return { ...quote, price: 2, dedupKey: 'yahoo-quote' };
    },
    bankier: async symbol => { calls.push(['bankier',symbol]); if (failBankier) throw new Error('Bad page'); return quote; },
  } });
  prices.saveManual(id, 3);
  prices.saveFeedSettings(id, 'yahoo', { yahoo: 'pra.wa', bankier: 'prime' });
  await collector.refreshAsset(id);
  assert.equal(prices.getQuoteDetails().PRIME.sourceId, 'yahoo');
  const count = db.prepare('SELECT COUNT(*) AS n FROM price_observations').get().n;
  prices.saveFeedSettings(id, 'bankier', { bankier: 'PRIME' });
  assert.equal(prices.listObserved().find(row => row.assetId === id).aliases.yahoo, 'PRA.WA');
  assert.equal(prices.getQuotes().PRIME, 2); // Selection alone never removes a working valuation.
  failBankier = true;
  assert.equal((await collector.refreshAsset(id)).failed, 1);
  assert.equal(prices.getQuoteDetails().PRIME.sourceId, 'yahoo');
  failBankier = false;
  await collector.refreshAsset(id);
  assert.equal(prices.getQuoteDetails().PRIME.sourceId, 'bankier');
  assert.equal(prices.getQuotes().PRIME, 1.45);
  await collector.refreshAsset(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_observations').get().n, count + 1);
  prices.saveFeedSettings(id, 'yahoo', { yahoo: 'PRA.WA' });
  await collector.refreshAsset(id);
  assert.equal(prices.getQuotes().PRIME, 2);
  assert.equal(prices.listObserved().find(row => row.assetId === id).aliases.bankier, 'PRIME');
  assert.throws(() => prices.saveFeedSettings(id, 'unknown', { yahoo: 'PRA.WA' }));
  assert.throws(() => prices.saveFeedSettings(id, 'bankier', { bankier: 'https://evil' }));
  // A response from a previously selected provider must not switch the instrument back.
  waitYahoo = true;
  const pending = collector.refreshAsset(id);
  prices.saveFeedSettings(id, 'bankier', { bankier: 'PRIME' });
  release(); await pending; waitYahoo = false;
  assert.equal(prices.listObserved().find(row => row.assetId === id).sourceId, 'bankier');
  await collector.refreshAsset(id);
  assert.equal(prices.getQuoteDetails().PRIME.sourceId, 'bankier');
  // Yahoo throttling must not stop a different provider in the same batch.
  prices.saveFeedSettings(otherId, 'yahoo', { yahoo: 'OTHER.WA' });
  clock += 300000; limitYahoo = true;
  const batch = await collector.run();
  assert.equal(batch.failed, 1); assert.equal(batch.updated, 1);
  clock += 300000;
  const after = await collector.run();
  assert.equal(after.updated, 1); assert.equal(after.status, 'backoff');
  assets.save('PRIME', { ticker: 'RENAMED', name: 'Prime', symbols: [] });
  assert.equal(prices.listObserved().find(row => row.assetId === id).aliases.bankier, 'PRIME');
  collector.stop();
  // Simulate the previous schema, then verify upgrade and repeated startup.
  db.exec('DROP TABLE asset_price_aliases; DELETE FROM schema_migrations WHERE version = 2');
  migrateDatabase(db); migrateDatabase(db);
  assert.equal(db.prepare("SELECT symbol FROM asset_price_aliases WHERE asset_id = ? AND source_id = 'bankier'").get(id).symbol, 'PRIME');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('Testy Bankier i dostawców: parser, daty Warszawa, aliasy, migracja, przełączanie, błędy i niezależne limity OK');
} finally { db.close(); }
