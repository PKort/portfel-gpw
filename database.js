import { randomUUID } from "node:crypto";

export const PRICE_SCALE = 1_000_000;
export function priceToUnits(price) {
  const units = Math.round(price * PRICE_SCALE);
  if (!Number.isFinite(price) || price < 0 || !Number.isSafeInteger(units)) throw Object.assign(new Error("Nieprawidłowy kurs lub przekroczony zakres ceny."), { status: 400 });
  return units;
}

function migrateV1(db) {
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, date TEXT NOT NULL,
        ticker TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('BUY','SELL')), quantity REAL NOT NULL CHECK(quantity > 0),
        price REAL NOT NULL CHECK(price >= 0), fee REAL NOT NULL CHECK(fee >= 0));
      CREATE TABLE IF NOT EXISTS quotes (ticker TEXT PRIMARY KEY, price REAL NOT NULL CHECK(price >= 0));
      CREATE TABLE IF NOT EXISTS assets (ticker TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_symbols (asset_ticker TEXT NOT NULL REFERENCES assets(ticker), platform TEXT NOT NULL COLLATE NOCASE,
        symbol TEXT NOT NULL, PRIMARY KEY(asset_ticker, platform), UNIQUE(platform, symbol));
      CREATE TABLE IF NOT EXISTS removed_assets (ticker TEXT PRIMARY KEY);
    `);
    if (!db.prepare("PRAGMA table_info(transactions)").all().some(row => row.name === "cost_method")) {
      db.exec("ALTER TABLE transactions ADD COLUMN cost_method TEXT CHECK(cost_method IN ('FIFO','AVP'))");
    }
    const oldAssets = db.prepare("SELECT * FROM assets").all();
    const oldSymbols = db.prepare("SELECT * FROM asset_symbols").all();
    const oldTransactions = db.prepare("SELECT * FROM transactions").all();
    const oldQuotes = db.prepare("SELECT * FROM quotes").all();
    const removed = new Set(db.prepare("SELECT ticker FROM removed_assets").all().map(row => row.ticker));
    db.exec(`
      DROP TABLE asset_symbols; DROP TABLE transactions; DROP TABLE quotes; DROP TABLE removed_assets; DROP TABLE assets;
      CREATE TABLE assets (
        id TEXT PRIMARY KEY, ticker TEXT NOT NULL, name TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'XWAR',
        currency TEXT NOT NULL DEFAULT 'PLN' CHECK(length(currency) = 3), isin TEXT, archived_at INTEGER,
        UNIQUE(market, ticker));
      CREATE TABLE asset_symbols (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        platform TEXT NOT NULL COLLATE NOCASE, symbol TEXT NOT NULL,
        PRIMARY KEY(asset_id, platform), UNIQUE(platform, symbol));
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, date TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK(type IN ('BUY','SELL')), quantity REAL NOT NULL CHECK(quantity > 0),
        price REAL NOT NULL CHECK(price >= 0), fee REAL NOT NULL CHECK(fee >= 0),
        cost_method TEXT CHECK(cost_method IN ('FIFO','AVP')));
      CREATE INDEX idx_transactions_asset_date ON transactions(asset_id, date, created_at);
      CREATE TABLE price_sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        declared_delay_seconds INTEGER CHECK(declared_delay_seconds >= 0),
        poll_interval_seconds INTEGER CHECK(poll_interval_seconds > 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)));
      INSERT INTO price_sources(id, name) VALUES ('manual', 'Kurs ręczny'), ('legacy', 'Kurs sprzed migracji');
      CREATE TABLE asset_price_feeds (
        asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE RESTRICT,
        source_id TEXT NOT NULL REFERENCES price_sources(id) ON DELETE RESTRICT,
        source_symbol TEXT NOT NULL CHECK(length(trim(source_symbol)) > 0),
        last_attempt_at INTEGER, last_success_at INTEGER, last_error TEXT);
      CREATE TABLE price_observations (
        id INTEGER PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        source_id TEXT NOT NULL REFERENCES price_sources(id) ON DELETE RESTRICT,
        price_units INTEGER NOT NULL CHECK(typeof(price_units) = 'integer' AND price_units BETWEEN 0 AND 9007199254740991),
        currency TEXT NOT NULL CHECK(length(currency) = 3),
        price_type TEXT NOT NULL CHECK(price_type IN ('last','close','manual')),
        quoted_at INTEGER, received_at INTEGER NOT NULL,
        session_date TEXT, dedup_key TEXT NOT NULL CHECK(length(dedup_key) > 0),
        CHECK(quoted_at IS NOT NULL OR source_id = 'legacy'),
        CHECK(price_type != 'close' OR (session_date IS NOT NULL AND session_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
        UNIQUE(asset_id, source_id, dedup_key));
      CREATE INDEX idx_price_observations_asset_time ON price_observations(asset_id, quoted_at DESC);
      CREATE INDEX idx_price_observations_source_time ON price_observations(asset_id, source_id, price_type, quoted_at DESC);
      CREATE TABLE asset_price_preferences (
        asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE RESTRICT,
        source_id TEXT NOT NULL REFERENCES price_sources(id) ON DELETE RESTRICT,
        price_type TEXT NOT NULL CHECK(price_type IN ('last','close','manual')));
    `);
    const now = Date.now();
    const definitions = new Map(oldAssets.map(row => [row.ticker, row.name]));
    for (const row of [...oldTransactions, ...oldQuotes]) if (!definitions.has(row.ticker)) definitions.set(row.ticker, row.ticker);
    const ids = new Map();
    const insertAsset = db.prepare("INSERT INTO assets(id,ticker,name,archived_at) VALUES (?,?,?,?)");
    for (const [ticker, name] of definitions) {
      const id = randomUUID(); ids.set(ticker, id);
      insertAsset.run(id, ticker, name, removed.has(ticker) ? now : null);
    }
    const insertSymbol = db.prepare("INSERT INTO asset_symbols VALUES (?,?,?)");
    for (const row of oldSymbols) insertSymbol.run(ids.get(row.asset_ticker), row.platform, row.symbol);
    const insertTransaction = db.prepare("INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?)");
    for (const row of oldTransactions) insertTransaction.run(row.id, row.created_at, row.date, ids.get(row.ticker), row.type, row.quantity, row.price, row.fee, row.cost_method);
    const insertQuote = db.prepare("INSERT INTO price_observations(asset_id,source_id,price_units,currency,price_type,quoted_at,received_at,dedup_key) VALUES (?,'legacy',?,'PLN','manual',NULL,?,'migration-v1')");
    for (const row of oldQuotes) {
      insertQuote.run(ids.get(row.ticker), priceToUnits(row.price), now);
      db.prepare("INSERT INTO asset_price_preferences VALUES (?,'legacy','manual')").run(ids.get(row.ticker));
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migracja: niespójne powiązania danych.");
    db.prepare("INSERT INTO schema_migrations VALUES (1,?)").run(now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function migrateDatabase(db) {
  migrateV1(db);
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      INSERT OR IGNORE INTO price_sources(id,name) VALUES ('yahoo','Yahoo Finance'), ('bankier','Bankier.pl');
      CREATE TABLE asset_price_aliases (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        source_id TEXT NOT NULL REFERENCES price_sources(id) ON DELETE RESTRICT,
        symbol TEXT NOT NULL CHECK(length(trim(symbol)) > 0),
        PRIMARY KEY(asset_id, source_id));
      INSERT INTO asset_price_aliases SELECT asset_id,source_id,source_symbol FROM asset_price_feeds;
      INSERT OR IGNORE INTO asset_price_aliases
        SELECT asset_id, CASE WHEN platform = 'Yahoo Finance' COLLATE NOCASE THEN 'yahoo' ELSE 'bankier' END, upper(trim(symbol))
        FROM asset_symbols WHERE platform IN ('Yahoo Finance', 'Bankier.pl') COLLATE NOCASE;
    `);
    db.prepare("INSERT INTO schema_migrations VALUES (2,?)").run(Date.now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
