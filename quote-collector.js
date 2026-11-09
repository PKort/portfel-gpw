import { fetchYahooQuote, yahooSymbol } from "./yahoo.js";
import { fetchBankierQuote } from "./bankier.js";
import { createBossaClient } from "./bossa.js";
import { providerNames } from "./providers.js";

export function createQuoteCollector(db, prices, { enabled = true, intervalSeconds = 300, fetchQuote = fetchYahooQuote, fetchProviders = {}, now = Date.now, fetchBossaBatch = createBossaClient({ now }).fetchBatch, getIntervalSeconds = null } = {}) {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) throw new Error("Interwał kursów musi wynosić co najmniej 60 sekund.");
  const adapters = { yahoo: fetchQuote, bankier: fetchBankierQuote, ...fetchProviders };
  for (const [id, name] of Object.entries(providerNames)) {
    db.prepare(`INSERT INTO price_sources(id,name,declared_delay_seconds,poll_interval_seconds,enabled)
      VALUES (?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET
      poll_interval_seconds = excluded.poll_interval_seconds, enabled = excluded.enabled`).run(id, name, intervalSeconds, enabled ? 1 : 0);
  }
  let pending = null;
  let timer = null;
  let stopped = false;
  const backoffs = new Map();
  function updateInterval() {
    const seconds = getIntervalSeconds ? getIntervalSeconds(now()) : intervalSeconds;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error('Nieprawidłowy interwał harmonogramu.');
    db.prepare("UPDATE price_sources SET poll_interval_seconds = ? WHERE id IN ('yahoo','bankier','bossa') AND poll_interval_seconds != ?").run(seconds, seconds);
    return seconds;
  }
  function prepareFeeds() {
    // Preserve explicit mappings and do not replace another provider.
    const rows = db.prepare(`SELECT a.id, a.ticker, s.symbol FROM assets a
      LEFT JOIN asset_price_feeds f ON f.asset_id = a.id
      LEFT JOIN asset_symbols s ON s.asset_id = a.id AND s.platform = 'Yahoo Finance'
      WHERE a.archived_at IS NULL AND a.market = 'XWAR' AND f.asset_id IS NULL`).all();
    for (const row of rows) {
      db.prepare("INSERT INTO asset_price_feeds(asset_id,source_id,source_symbol) VALUES (?,'yahoo',?)")
        .run(row.id, db.prepare("SELECT symbol FROM asset_price_aliases WHERE asset_id = ? AND source_id = 'yahoo'").get(row.id)?.symbol || row.symbol?.trim().toUpperCase() || yahooSymbol(row.ticker));
    }
    db.exec("INSERT OR IGNORE INTO asset_price_aliases SELECT asset_id,source_id,source_symbol FROM asset_price_feeds");
  }
  async function collect({ assetId = null, force = false } = {}) {
    if (!enabled || stopped) return { status: "disabled", updated: 0, failed: 0 };
    const currentInterval = updateInterval();
    prepareFeeds();
    let updated = 0, failed = 0, skipped = 0, nextAttemptAt = null, retryAt = null;
    const current = feed => db.prepare(`SELECT 1 FROM assets a JOIN asset_price_feeds f ON f.asset_id = a.id
      WHERE a.id = ? AND a.archived_at IS NULL AND f.source_id = ? AND f.source_symbol = ?
      AND a.currency = ? AND a.isin IS ?`).get(feed.assetId, feed.sourceId, feed.sourceSymbol, feed.currency, feed.isin);
    const batches = [];
    const bossaFeeds = [];
    for (const feed of prices.listObserved().filter(item => (item.sourceId === 'bossa' || Object.hasOwn(adapters, item.sourceId)) && item.status === "configured" && (assetId === null || item.assetId === assetId))) {
      if (!force && feed.lastAttemptAt !== null && now() - feed.lastAttemptAt < currentInterval * 1000 && now() >= (backoffs.get(feed.sourceId) ?? 0)) {
        skipped++;
        const dueAt = feed.lastAttemptAt + currentInterval * 1000;
        nextAttemptAt = nextAttemptAt === null ? dueAt : Math.min(nextAttemptAt, dueAt);
      } else if (feed.sourceId === 'bossa') bossaFeeds.push(feed);
      else batches.push([feed]);
    }
    for (let index = 0; index < bossaFeeds.length; index += 20) batches.push(bossaFeeds.slice(index, index + 20));
    for (const batch of batches) {
      if (stopped) break;
      const sourceId = batch[0].sourceId;
      const active = batch.filter(current);
      if (!active.length) continue;
      if (now() < (backoffs.get(sourceId) ?? 0)) {
        skipped += active.length;
        retryAt = retryAt === null ? backoffs.get(sourceId) : Math.min(retryAt, backoffs.get(sourceId));
        continue;
      }
      for (const feed of active) db.prepare("UPDATE asset_price_feeds SET last_attempt_at = ? WHERE asset_id = ?").run(now(), feed.assetId);
      let results;
      try {
        results = sourceId === 'bossa' ? await fetchBossaBatch(active) : new Map([[active[0].assetId, {
          quote: await adapters[sourceId](active[0].sourceSymbol, active[0].currency, { isin: active[0].isin }),
        }]]);
      } catch (error) { results = new Map(active.map(feed => [feed.assetId, { error }])); }
      for (const feed of active) {
        // Every awaited batch can race with archiving or changing a provider mapping.
        if (stopped || !current(feed)) continue;
        try {
          const result = results.get(feed.assetId);
          if (result?.error) throw result.error;
          if (!result?.quote) throw new Error("Dostawca nie zwrócił danych instrumentu.");
          db.exec("BEGIN IMMEDIATE");
          try {
            prices.record({ ...result.quote, assetId: feed.assetId, sourceId, receivedAt: now() });
            db.prepare("UPDATE asset_price_feeds SET last_success_at = ?, last_error = NULL WHERE asset_id = ?").run(now(), feed.assetId);
            db.prepare(`INSERT INTO asset_price_preferences VALUES (?,?,'last')
              ON CONFLICT(asset_id) DO UPDATE SET source_id = excluded.source_id, price_type = 'last'`).run(feed.assetId, sourceId);
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          updated++;
        } catch (error) {
          db.prepare("UPDATE asset_price_feeds SET last_error = ? WHERE asset_id = ?").run(String(error.message).slice(0,500), feed.assetId);
          failed++;
          if (error.backoff || error.backoffMs) {
            const until = now() + (error.backoffMs ?? 60 * 60_000);
            backoffs.set(sourceId, Math.max(backoffs.get(sourceId) ?? 0, until));
            retryAt = retryAt === null ? until : Math.min(retryAt, until);
          }
        }
      }
    }
    return { status: retryAt !== null ? "backoff" : "complete", updated, failed, skipped, nextAttemptAt, retryAt };
  }
  function run() {
    if (!pending) pending = collect().finally(() => { pending = null; });
    return pending;
  }
  async function refreshAsset(assetId) {
    // Serialize with scheduled batches; an explicit request bypasses the polling interval only.
    while (pending) await pending;
    pending = collect({ assetId, force: true }).finally(() => { pending = null; });
    return pending;
  }
  function start() {
    if (!enabled || timer || stopped) return;
    // Short tick discovers newly added instruments without refetching instruments before their interval.
    timer = setInterval(() => { run().catch(error => console.error("Zbieranie kursów:", error.message)); }, getIntervalSeconds ? 1000 : 30_000);
    timer.unref();
    run().catch(error => console.error("Zbieranie kursów:", error.message));
  }
  function stop() { stopped = true; clearInterval(timer); timer = null; }
  return { run, refreshAsset, start, stop, prepareFeeds, updateInterval };
}
