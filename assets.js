import { randomUUID } from "node:crypto";
import { migrateDatabase } from "./database.js";

export function createAssetStore(db) {
  migrateDatabase(db);
  db.exec("CREATE TABLE IF NOT EXISTS pinned_assets (asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE RESTRICT)");
  const find = ticker => db.prepare("SELECT * FROM assets WHERE ticker = ? AND market = 'XWAR'").get(ticker);
  const ensure = ticker => {
    if (!find(ticker)) db.prepare("INSERT INTO assets(id,ticker,name) VALUES (?,?,?)").run(randomUUID(), ticker, ticker);
    return find(ticker).id;
  };
  const list = () => db.prepare("SELECT id, ticker, name, EXISTS(SELECT 1 FROM pinned_assets p WHERE p.asset_id = assets.id) AS pinned FROM assets WHERE archived_at IS NULL ORDER BY name, ticker").all().map(asset => ({
    ticker: asset.ticker, name: asset.name, pinned: Boolean(asset.pinned),
    symbols: db.prepare("SELECT platform, symbol FROM asset_symbols WHERE asset_id = ? ORDER BY platform").all(asset.id).map(row => ({ ...row })),
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
    if (originalTicker && !db.prepare("SELECT 1 FROM assets WHERE ticker = ? AND market = 'XWAR' AND archived_at IS NULL").get(originalTicker)) fail("Nie znaleziono aktywa.", 404);
    if (ticker !== originalTicker && find(ticker) && (originalTicker || find(ticker).archived_at === null)) fail("Aktywo o takim tickerze już istnieje.", 409);
    for (const { platform, symbol } of symbols) {
      const owner = db.prepare("SELECT a.ticker AS asset_ticker FROM asset_symbols s JOIN assets a ON a.id = s.asset_id WHERE platform = ? AND symbol = ?").get(platform, symbol);
      if (owner && owner.asset_ticker !== (originalTicker ?? ticker)) fail("Ten symbol platformy jest już przypisany do innego aktywa.", 409);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = find(originalTicker ?? ticker);
      const id = existing?.id ?? randomUUID();
      if (existing) {
        db.prepare("UPDATE assets SET ticker = ?, name = ?, archived_at = NULL WHERE id = ?").run(ticker, name, id);
        db.prepare("DELETE FROM asset_symbols WHERE asset_id = ?").run(id);
      } else db.prepare("INSERT INTO assets(id,ticker,name) VALUES (?,?,?)").run(id, ticker, name);
      const insert = db.prepare("INSERT INTO asset_symbols VALUES (?,?,?)");
      for (const { platform, symbol } of symbols) insert.run(id, platform, symbol);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { ticker, name, symbols };
  }
  function remove(ticker) {
    const asset = find(ticker);
    if (!asset || asset.archived_at !== null) throw Object.assign(new Error("Nie znaleziono aktywa."), { status: 404 });
    db.prepare("UPDATE assets SET archived_at = ? WHERE id = ?").run(Date.now(), asset.id);
  }
  function pin(ticker, pinned) {
    if (typeof pinned !== "boolean") throw Object.assign(new Error("Podaj stan przypięcia."), { status: 400 });
    const asset = find(ticker);
    if (!asset || asset.archived_at !== null) throw Object.assign(new Error("Nie znaleziono aktywnego instrumentu."), { status: 404 });
    if (pinned) db.prepare("INSERT OR IGNORE INTO pinned_assets(asset_id) VALUES (?)").run(asset.id);
    else db.prepare("DELETE FROM pinned_assets WHERE asset_id = ?").run(asset.id);
    return { ticker: asset.ticker, pinned };
  }
  return { list, ensure, save, remove, pin };
}
