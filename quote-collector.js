import { fetchYahooQuote, yahooSymbol } from "./yahoo.js";
import { fetchBankierQuote } from "./bankier.js";

export function createQuoteCollector(db, prices, { enabled = true, intervalSeconds = 300, fetchQuote = fetchYahooQuote, fetchProviders = {}, now = Date.now } = {}) {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) throw new Error("Interwał kursów musi wynosić co najmniej 60 sekund.");
  const adapters = { yahoo: fetchQuote, bankier: fetchBankierQuote, ...fetchProviders };
  for (const [id, name] of [['yahoo','Yahoo Finance'], ['bankier','Bankier.pl']]) {
    db.prepare(`INSERT INTO price_sources(id,name,declared_delay_seconds,poll_interval_seconds,enabled)
      VALUES (?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET
      poll_interval_seconds = excluded.poll_interval_seconds, enabled = excluded.enabled`).run(id, name, intervalSeconds, enabled ? 1 : 0);
  }
  let pending = null;
  let timer = null;
  let stopped = false;
  const backoffs = new Map();
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
    prepareFeeds();
    let updated = 0, failed = 0, skipped = 0, nextAttemptAt = null, retryAt = null;
    for (const feed of prices.listObserved().filter(item => Object.hasOwn(adapters, item.sourceId) && item.status === "configured" && (assetId === null || item.assetId === assetId))) {
      if (stopped) break;
      // Recheck after every await: the user can archive or remap the instrument while collecting.
      const current = () => db.prepare(`SELECT 1 FROM assets a JOIN asset_price_feeds f ON f.asset_id = a.id
        WHERE a.id = ? AND a.archived_at IS NULL AND f.source_id = ? AND f.source_symbol = ?`).get(feed.assetId, feed.sourceId, feed.sourceSymbol);
      if (!current()) continue;
      if (now() < (backoffs.get(feed.sourceId) ?? 0)) {
        skipped++;
        retryAt = retryAt === null ? backoffs.get(feed.sourceId) : Math.min(retryAt, backoffs.get(feed.sourceId));
        continue;
      }
      if (!force && feed.lastAttemptAt !== null && now() - feed.lastAttemptAt < intervalSeconds * 1000) {
        skipped++;
        const dueAt = feed.lastAttemptAt + intervalSeconds * 1000;
        nextAttemptAt = nextAttemptAt === null ? dueAt : Math.min(nextAttemptAt, dueAt);
        continue;
      }
      db.prepare("UPDATE asset_price_feeds SET last_attempt_at = ? WHERE asset_id = ?").run(now(), feed.assetId);
      try {
        const quote = await adapters[feed.sourceId](feed.sourceSymbol, feed.currency, { isin: feed.isin });
        if (stopped || !current()) continue;
        db.exec("BEGIN IMMEDIATE");
        try {
          prices.record({ ...quote, assetId: feed.assetId, sourceId: feed.sourceId, receivedAt: now() });
          db.prepare("UPDATE asset_price_feeds SET last_success_at = ?, last_error = NULL WHERE asset_id = ?").run(now(), feed.assetId);
          // Activate only once a validated quote exists; preserve manual/legacy valuation during failures.
          db.prepare(`INSERT INTO asset_price_preferences VALUES (?,?,'last')
            ON CONFLICT(asset_id) DO UPDATE SET source_id = excluded.source_id, price_type = 'last'`).run(feed.assetId, feed.sourceId);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        updated++;
      } catch (error) {
        if (current()) db.prepare("UPDATE asset_price_feeds SET last_error = ? WHERE asset_id = ?").run(String(error.message).slice(0,500), feed.assetId);
        failed++;
        if (error.backoff) { const until = now() + 60 * 60_000; backoffs.set(feed.sourceId, until); retryAt = retryAt === null ? until : Math.min(retryAt, until); }
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
    timer = setInterval(() => { run().catch(error => console.error("Zbieranie kursów:", error.message)); }, 30_000);
    timer.unref();
    run().catch(error => console.error("Zbieranie kursów:", error.message));
  }
  function stop() { stopped = true; clearInterval(timer); timer = null; }
  return { run, refreshAsset, start, stop, prepareFeeds };
}
