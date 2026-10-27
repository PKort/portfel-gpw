import { cashLedgerTotals, migrateCashLedger } from "./cash-ledger.js";

export function createSettingsStore(db) {
  if (!db.prepare("PRAGMA table_info(transactions)").all().some(column => column.name === "cost_method")) {
    db.exec("ALTER TABLE transactions ADD COLUMN cost_method TEXT CHECK(cost_method IN ('FIFO', 'AVP'))");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS portfolio_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    cost_method TEXT NOT NULL CHECK(cost_method IN ('FIFO', 'AVP'))
  );
  INSERT OR IGNORE INTO portfolio_settings (id, cost_method) VALUES (1, 'FIFO');`);
  if (!db.prepare("PRAGMA table_info(portfolio_settings)").all().some(column => column.name === "cash_cents")) {
    db.exec("ALTER TABLE portfolio_settings ADD COLUMN cash_cents INTEGER NOT NULL DEFAULT 0 CHECK(cash_cents >= 0)");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS cash_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS cash_withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS cash_dividends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at INTEGER NOT NULL
  )`);
  if (!db.prepare("PRAGMA table_info(cash_dividends)").all().some(column => column.name === "asset_id")) {
    db.exec("ALTER TABLE cash_dividends ADD COLUMN asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT");
  }
  const cashTables = { DEPOSIT: "cash_deposits", WITHDRAWAL: "cash_withdrawals", DIVIDEND: "cash_dividends" };
  const cashOperations = () => db.prepare(`SELECT id, NULL AS assetId, 'DEPOSIT' AS type, date, amount_cents / 100.0 AS amount, created_at AS createdAt FROM cash_deposits
    UNION ALL SELECT id, NULL AS assetId, 'WITHDRAWAL' AS type, date, amount_cents / 100.0 AS amount, created_at AS createdAt FROM cash_withdrawals
    UNION ALL SELECT id, asset_id AS assetId, 'DIVIDEND' AS type, date, amount_cents / 100.0 AS amount, created_at AS createdAt FROM cash_dividends ORDER BY date DESC, createdAt DESC`).all().map(item => {
      if (item.type !== "DIVIDEND") return item;
      const asset = item.assetId ? db.prepare("SELECT ticker, name AS assetName FROM assets WHERE id = ?").get(item.assetId) : null;
      return { ...item, ticker: asset?.ticker ?? null, assetName: asset?.assetName ?? null };
    });
  const deposits = () => db.prepare("SELECT id, date, amount_cents / 100.0 AS amount, created_at AS createdAt FROM cash_deposits ORDER BY date DESC, id DESC").all();
  const migration = migrateCashLedger(db);
  if (!migration.applied) {
    if (migration.snapshot.legacyCashCents !== 0 || migration.snapshot.legacyBaselineCents !== 0) {
      throw new Error("Saldo gotówki wymaga migracji. Wykonaj kopię bazy i sprawdź: node migrate-cash.js /ścieżka/portfolio.db; po weryfikacji uruchom z --apply. Zobacz CASH-MIGRATION.md.");
    }
    migrateCashLedger(db, { apply: true });
  }
  const cashDelta = () => cashLedgerTotals(db).ledgerCents;
  const get = () => {
    const row = db.prepare("SELECT cost_method FROM portfolio_settings WHERE id = 1").get();
    const adjustment = db.prepare("SELECT adjustment_cents FROM cash_ledger_settings WHERE id = 1").get().adjustment_cents;
    return { costMethod: row.cost_method, cashBalance: (adjustment + cashDelta()) / 100 };
  };
  function save(input) {
    if (!input || (!Object.hasOwn(input, "costMethod") && !Object.hasOwn(input, "cashBalance"))) {
      throw Object.assign(new Error("Podaj metodę wyceny lub saldo gotówki."), { status: 400 });
    }
    const next = { ...get(), ...input };
    if (!["FIFO", "AVP"].includes(next.costMethod)) {
      throw Object.assign(new Error("Wybierz metodę FIFO lub AVP."), { status: 400 });
    }
    const cents = Math.round(next.cashBalance * 100);
    if (typeof next.cashBalance !== "number" || !Number.isFinite(next.cashBalance) || (Object.hasOwn(input, "cashBalance") && next.cashBalance < 0) || !Number.isSafeInteger(cents) || Math.abs(next.cashBalance * 100 - cents) > 0.000001) {
      throw Object.assign(new Error("Podaj nieujemne saldo gotówki z dokładnością do groszy."), { status: 400 });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE portfolio_settings SET cost_method = ? WHERE id = 1").run(next.costMethod);
      if (Object.hasOwn(input, "cashBalance")) {
        const adjustment = cents - cashDelta();
        if (!Number.isSafeInteger(adjustment)) throw Object.assign(new Error("Przekroczony zakres korekty salda."), { status: 400 });
        db.prepare("UPDATE cash_ledger_settings SET adjustment_cents = ? WHERE id = 1").run(adjustment);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return get();
  }
  function deposit(input) { return saveCash({ ...input, type: "DEPOSIT" }); }
  function saveCash(input, id = null) {
    if (!["DEPOSIT", "WITHDRAWAL", "DIVIDEND"].includes(input?.type)) throw Object.assign(new Error("Wybierz zasilenie, wypłatę lub dywidendę."), { status: 400 });
    const table = cashTables[input.type];
    if (id !== null && !db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)) throw Object.assign(new Error("Nie znaleziono operacji."), { status: 404 });
    const cents = Math.round(input?.amount * 100);
    if (typeof input?.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0 || !Number.isSafeInteger(cents) || Math.abs(input.amount * 100 - cents) > 0.000001) {
      throw Object.assign(new Error("Podaj dodatnią kwotę operacji z dokładnością do groszy."), { status: 400 });
    }
    const date = input.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw Object.assign(new Error("Podaj poprawną datę operacji."), { status: 400 });
    }
    let assetId = null;
    if (input.type === "DIVIDEND") {
      const ticker = typeof input.ticker === "string" ? input.ticker.trim().toUpperCase() : "";
      const asset = ticker ? db.prepare("SELECT id FROM assets WHERE ticker = ? AND market = 'XWAR'").get(ticker) : null;
      if (!asset) throw Object.assign(new Error("Wybierz emitenta dywidendy ze słownika aktywów."), { status: 400 });
      assetId = asset.id;
    }
    if (input.type === "DIVIDEND") {
      if (id !== null) db.prepare("UPDATE cash_dividends SET date = ?, amount_cents = ?, asset_id = ? WHERE id = ?").run(date, cents, assetId, id);
      else id = Number(db.prepare("INSERT INTO cash_dividends (date, amount_cents, created_at, asset_id) VALUES (?, ?, ?, ?)").run(date, cents, Date.now(), assetId).lastInsertRowid);
    } else if (id !== null) db.prepare(`UPDATE ${table} SET date = ?, amount_cents = ? WHERE id = ?`).run(date, cents, id);
    else id = Number(db.prepare(`INSERT INTO ${table} (date, amount_cents, created_at) VALUES (?, ?, ?)`).run(date, cents, Date.now()).lastInsertRowid);
    return cashOperations().find(item => item.id === id && item.type === input.type);
  }
  function removeCash(type, id) {
    if (!["DEPOSIT", "WITHDRAWAL", "DIVIDEND"].includes(type)) throw Object.assign(new Error("Nieprawidłowy typ operacji."), { status: 400 });
    db.prepare(`DELETE FROM ${cashTables[type]} WHERE id = ?`).run(id);
  }
  return { get, save, deposit, deposits, cashOperations, saveCash, removeCash };
}
