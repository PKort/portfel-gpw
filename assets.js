import { calculatePortfolio } from "./portfolio.js";

export function createAssetStore(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS assets (ticker TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asset_symbols (
      asset_ticker TEXT NOT NULL REFERENCES assets(ticker) ON UPDATE CASCADE ON DELETE CASCADE,
      platform TEXT NOT NULL COLLATE NOCASE,
      symbol TEXT NOT NULL,
      PRIMARY KEY (asset_ticker, platform),
      UNIQUE (platform, symbol)
    );
    CREATE TABLE IF NOT EXISTS removed_assets (ticker TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO assets (ticker, name)
      SELECT ticker, ticker FROM (
        SELECT ticker FROM transactions UNION SELECT ticker FROM quotes
      ) WHERE ticker NOT IN (SELECT ticker FROM removed_assets);
  `);
  const ensure = (ticker) => db.prepare("INSERT OR IGNORE INTO assets SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM removed_assets WHERE ticker = ?)").run(ticker, ticker, ticker);
  const list = () => db.prepare("SELECT ticker, name FROM assets ORDER BY name, ticker").all().map(asset => ({
    ...asset,
    symbols: db.prepare("SELECT platform, symbol FROM asset_symbols WHERE asset_ticker = ? ORDER BY platform").all(asset.ticker).map(row => ({ ...row })),
  }));
  function save(originalTicker, input) {
    const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
    if (!input || typeof input !== "object") fail("Nieprawidłowa definicja aktywa.");
    const ticker = typeof input.ticker === "string" ? input.ticker.trim().toUpperCase() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(ticker) || !name || name.length > 120) fail("Podaj ticker (do 32 znaków: litery, cyfry, kropka, myślnik lub podkreślenie) i nazwę (do 120 znaków).");
    if (!Array.isArray(input.symbols) || input.symbols.length > 30) fail("Nieprawidłowa lista symboli platform.");
    const symbols = input.symbols.map(item => {
      const platform = typeof item?.platform === "string" ? item.platform.trim() : "";
      const symbol = typeof item?.symbol === "string" ? item.symbol.trim() : "";
      if (!platform || platform.length > 60 || !symbol || symbol.length > 120) fail("Każdy wpis wymaga platformy (do 60 znaków) i symbolu/nazwy (do 120 znaków).");
      return { platform, symbol };
    });
    if (new Set(symbols.map(item => item.platform.toLowerCase())).size !== symbols.length) fail("Platforma może wystąpić tylko raz dla danego aktywa.");
    if (originalTicker && !db.prepare("SELECT 1 FROM assets WHERE ticker = ?").get(originalTicker)) fail("Nie znaleziono aktywa.", 404);
    if (ticker !== originalTicker && db.prepare("SELECT 1 FROM assets WHERE ticker = ?").get(ticker)) fail("Aktywo o takim tickerze już istnieje.", 409);
    for (const { platform, symbol } of symbols) {
      const owner = db.prepare("SELECT asset_ticker FROM asset_symbols WHERE platform = ? AND symbol = ?").get(platform, symbol);
      if (owner && owner.asset_ticker !== originalTicker) fail("Ten symbol platformy jest już przypisany do innego aktywa.", 409);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (originalTicker) {
        db.prepare("UPDATE assets SET ticker = ?, name = ? WHERE ticker = ?").run(ticker, name, originalTicker);
        db.prepare("UPDATE transactions SET ticker = ? WHERE ticker = ?").run(ticker, originalTicker);
        db.prepare("UPDATE quotes SET ticker = ? WHERE ticker = ?").run(ticker, originalTicker);
        db.prepare("DELETE FROM asset_symbols WHERE asset_ticker = ?").run(ticker);
      } else db.prepare("INSERT INTO assets VALUES (?, ?)").run(ticker, name);
      db.prepare("DELETE FROM removed_assets WHERE ticker = ?").run(ticker);
      const insert = db.prepare("INSERT INTO asset_symbols VALUES (?, ?, ?)");
      for (const { platform, symbol } of symbols) insert.run(ticker, platform, symbol);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { ticker, name, symbols };
  }
  function remove(ticker) {
    if (!db.prepare("SELECT 1 FROM assets WHERE ticker = ?").get(ticker)) {
      throw Object.assign(new Error("Nie znaleziono aktywa."), { status: 404 });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const transactions = db.prepare("SELECT date, created_at AS createdAt, ticker, type, quantity, price, fee FROM transactions WHERE ticker = ?").all(ticker);
      const position = calculatePortfolio(transactions)[0];
      if (position && position.quantity > 1e-9) {
        throw Object.assign(new Error("Nie można usunąć aktywa z otwartą pozycją. Najpierw zamknij pozycję."), { status: 409 });
      }
      db.prepare("INSERT OR IGNORE INTO removed_assets VALUES (?)").run(ticker);
      db.prepare("DELETE FROM assets WHERE ticker = ?").run(ticker);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return { list, ensure, save, remove };
}
