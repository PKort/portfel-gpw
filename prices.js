import { randomUUID } from "node:crypto";
import { PRICE_SCALE, priceToUnits } from "./database.js";
import { normalizeProviderSymbol } from "./providers.js";

export function createPriceStore(db) {
  function record(input) {
    const { assetId, sourceId, price, currency, priceType, quotedAt, sessionDate = null, dedupKey } = input;
    const receivedAt = input.receivedAt ?? Date.now();
    if (!Number.isSafeInteger(quotedAt) || !Number.isSafeInteger(receivedAt) || !dedupKey) {
      throw Object.assign(new Error("Podaj czas notowania, czas odbioru i klucz zdarzenia."), { status: 400 });
    }
    const units = priceToUnits(price);
    return db.prepare(`INSERT INTO price_observations
      (asset_id,source_id,price_units,currency,price_type,quoted_at,received_at,session_date,dedup_key)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(asset_id,source_id,dedup_key) DO NOTHING`)
      .run(assetId, sourceId, units, currency, priceType, quotedAt, receivedAt, sessionDate, dedupKey);
  }
  function saveManual(assetId, price) {
    const asset = db.prepare("SELECT currency FROM assets WHERE id = ?").get(assetId);
    db.exec("BEGIN IMMEDIATE");
    try {
      record({ assetId, sourceId: "manual", price, currency: asset.currency, priceType: "manual", quotedAt: Date.now(), dedupKey: randomUUID() });
      // A configured automatic feed always takes precedence. A first manual entry replaces the unknown legacy series.
      db.prepare(`INSERT INTO asset_price_preferences VALUES (?,'manual','manual')
        ON CONFLICT(asset_id) DO UPDATE SET source_id = 'manual', price_type = 'manual'
        WHERE asset_price_preferences.source_id = 'legacy'`).run(assetId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function getQuoteDetails(at = null) {
    if (at !== null && !Number.isSafeInteger(at)) throw new Error("Nieprawidłowy czas wyceny.");
    const rows = db.prepare(`SELECT a.ticker, p.price_units, p.source_id, p.quoted_at, p.received_at FROM assets a
      JOIN price_observations p ON p.id = (
        SELECT o.id FROM price_observations o
        LEFT JOIN asset_price_preferences pref ON pref.asset_id = a.id
        LEFT JOIN asset_price_feeds feed ON feed.asset_id = a.id
        WHERE o.asset_id = a.id
          AND o.source_id = COALESCE(pref.source_id, feed.source_id, 'manual')
          AND o.price_type = COALESCE(pref.price_type, CASE WHEN feed.source_id IS NOT NULL THEN 'last' ELSE 'manual' END)
          AND o.currency = a.currency
          AND (? IS NULL OR o.quoted_at <= ?)
        ORDER BY o.quoted_at DESC, o.received_at DESC, o.id DESC LIMIT 1
      ) WHERE a.market = 'XWAR'`).all(at, at);
    return Object.fromEntries(rows.map(row => [row.ticker, {
      price: row.price_units / PRICE_SCALE, sourceId: row.source_id, quotedAt: row.quoted_at, receivedAt: row.received_at,
    }]));
  }
  const getQuotes = (at = null) => Object.fromEntries(Object.entries(getQuoteDetails(at)).map(([ticker, quote]) => [ticker, quote.price]));
  function configureFeed(assetId, sourceId, sourceSymbol) {
    if (typeof sourceSymbol !== "string" || !sourceSymbol.trim() || ["manual", "legacy"].includes(sourceId)) {
      throw Object.assign(new Error("Podaj automatyczne źródło i symbol instrumentu."), { status: 400 });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO asset_price_feeds(asset_id,source_id,source_symbol) VALUES (?,?,?)
        ON CONFLICT(asset_id) DO UPDATE SET source_id = excluded.source_id, source_symbol = excluded.source_symbol,
        last_attempt_at = NULL, last_success_at = NULL, last_error = NULL`).run(assetId, sourceId, sourceSymbol.trim());
      db.prepare(`INSERT INTO asset_price_aliases VALUES (?,?,?)
        ON CONFLICT(asset_id,source_id) DO UPDATE SET symbol = excluded.symbol`).run(assetId, sourceId, sourceSymbol.trim());
      db.prepare(`INSERT INTO asset_price_preferences VALUES (?,?,'last')
        ON CONFLICT(asset_id) DO UPDATE SET source_id = excluded.source_id, price_type = 'last'`).run(assetId, sourceId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function saveFeedSettings(assetId, sourceId, symbols, { makeDefault = true } = {}) {
    const normalized = Object.fromEntries(Object.entries(symbols).map(([source, symbol]) => [source, normalizeProviderSymbol(source, symbol)]));
    if (!Object.hasOwn(normalized, sourceId)) throw Object.assign(new Error("Podaj alias wybranego dostawcy."), { status: 400 });
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare(`INSERT INTO asset_price_aliases VALUES (?,?,?)
        ON CONFLICT(asset_id,source_id) DO UPDATE SET symbol = excluded.symbol`);
      for (const [source, symbol] of Object.entries(normalized)) insert.run(assetId, source, symbol);
      const current = db.prepare("SELECT source_id FROM asset_price_feeds WHERE asset_id = ?").get(assetId);
      if (!makeDefault && current?.source_id !== sourceId) {
        const activeAlias = normalized[current?.source_id];
        if (activeAlias) db.prepare(`UPDATE asset_price_feeds SET source_symbol = ?, last_attempt_at = NULL,
          last_success_at = NULL, last_error = NULL WHERE asset_id = ? AND source_symbol != ?`).run(activeAlias, assetId, activeAlias);
        db.exec("COMMIT");
        return;
      }
      // Keep the last working valuation until the newly selected series has been fetched successfully.
      db.prepare(`INSERT INTO asset_price_feeds(asset_id,source_id,source_symbol) VALUES (?,?,?)
        ON CONFLICT(asset_id) DO UPDATE SET source_id = excluded.source_id, source_symbol = excluded.source_symbol,
        last_attempt_at = NULL, last_success_at = NULL, last_error = NULL`).run(assetId, sourceId, normalized[sourceId]);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const listObserved = () => db.prepare(`SELECT a.id AS assetId, a.ticker, a.currency, a.isin,
    f.source_id AS sourceId, f.source_symbol AS sourceSymbol,
    s.poll_interval_seconds AS pollIntervalSeconds, f.last_attempt_at AS lastAttemptAt, f.last_success_at AS lastSuccessAt, f.last_error AS lastError,
    CASE WHEN f.asset_id IS NULL THEN 'unconfigured' WHEN s.enabled = 0 THEN 'source_disabled' ELSE 'configured' END AS status
    FROM assets a LEFT JOIN asset_price_feeds f ON f.asset_id = a.id
    LEFT JOIN price_sources s ON s.id = f.source_id WHERE a.archived_at IS NULL ORDER BY a.ticker`).all().map(row => ({ ...row, aliases: Object.fromEntries(
      db.prepare("SELECT source_id, symbol FROM asset_price_aliases WHERE asset_id = ?").all(row.assetId).map(alias => [alias.source_id, alias.symbol])
    ) }));
  return { record, saveManual, getQuotes, getQuoteDetails, configureFeed, saveFeedSettings, listObserved };
}
