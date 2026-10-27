import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateCashLedger } from "./cash-ledger.js";
import { createSettingsStore } from "./settings.js";

const directory = mkdtempSync(join(tmpdir(), "cash-ledger-"));
let db;
try {
  const path = join(directory, "portfolio.db");
  db = new DatabaseSync(path);
  db.exec(`CREATE TABLE transactions (id TEXT PRIMARY KEY, type TEXT, quantity REAL, price REAL, fee REAL, cost_method TEXT);
    INSERT INTO transactions VALUES ('buy', 'BUY', 10, 100, 5, NULL), ('sale', 'SELL', 2, 120, 3, 'FIFO');
    CREATE TABLE portfolio_settings (id INTEGER PRIMARY KEY, cost_method TEXT, cash_cents INTEGER, cash_baseline_cents INTEGER);
    INSERT INTO portfolio_settings VALUES (1, 'AVP', 0, -76800);
    CREATE TABLE cash_deposits (id INTEGER PRIMARY KEY, date TEXT, amount_cents INTEGER, created_at INTEGER);
    INSERT INTO cash_deposits VALUES (1, '2026-01-01', 200000, 1);
    CREATE TABLE cash_withdrawals (id INTEGER PRIMARY KEY, date TEXT, amount_cents INTEGER, created_at INTEGER);
    INSERT INTO cash_withdrawals VALUES (1, '2026-01-02', 10000, 2);`);
  const rows = table => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
  const before = [rows("transactions"), rows("cash_deposits"), rows("cash_withdrawals"), rows("portfolio_settings")];
  const report = migrateCashLedger(db);
  assert.equal(report.applied, false);
  assert.equal(report.snapshot.previousBalanceCents, 190000); // Broken balance: only cash operations.
  assert.equal(report.snapshot.proposedBalanceCents, 113200); // 2000 - 100 - 1005 + 237.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'cash_ledger_%'").get().n, 0);
  assert.throws(() => createSettingsStore(db), /wymaga migracji/);
  const readOnly = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(migrateCashLedger(readOnly), report);
  readOnly.close();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'cash_ledger_%'").get().n, 0);
  assert.throws(() => migrateCashLedger(db, { apply: true, openingBalanceCents: NaN }));
  assert.deepEqual(migrateCashLedger(db, { apply: true }).snapshot, report.snapshot);
  assert.deepEqual([rows("transactions"), rows("cash_deposits"), rows("cash_withdrawals"), rows("portfolio_settings")], before);
  let settings = createSettingsStore(db);
  assert.deepEqual(settings.get(), { costMethod: "AVP", cashBalance: 1132 });
  assert.equal(migrateCashLedger(db, { apply: true, openingBalanceCents: 999 }).snapshot.openingBalanceCents, 0);
  db.prepare("INSERT INTO transactions VALUES ('older-buy', 'BUY', 1, 100, 1, NULL)").run();
  assert.equal(settings.get().cashBalance, 1031);
  db.prepare("UPDATE transactions SET fee = 2 WHERE id = 'older-buy'").run();
  assert.equal(settings.get().cashBalance, 1030);
  db.prepare("DELETE FROM transactions WHERE id = 'older-buy'").run();
  assert.equal(settings.get().cashBalance, 1132);
  settings.save({ costMethod: "FIFO" });
  assert.equal(settings.get().cashBalance, 1132);
  db.close();
  db = new DatabaseSync(path);
  settings = createSettingsStore(db);
  assert.equal(settings.get().cashBalance, 1132);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cash_ledger_migrations").get().n, 1);
  db.close();
  // A previous manual balance is ambiguous: preview records it, opening balance is explicit.
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE transactions (type TEXT, quantity REAL, price REAL, fee REAL);
    INSERT INTO transactions VALUES ('BUY', 1, 100, 5);
    CREATE TABLE portfolio_settings (id INTEGER PRIMARY KEY, cost_method TEXT, cash_cents INTEGER);
    INSERT INTO portfolio_settings VALUES (1, 'FIFO', 50000);`);
  assert.equal(migrateCashLedger(db).snapshot.legacyCashCents, 50000);
  assert.equal(migrateCashLedger(db, { apply: true, openingBalanceCents: 20000 }).snapshot.proposedBalanceCents, 9500);
  assert.equal(createSettingsStore(db).get().cashBalance, 95);
  db.close();
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE transactions (type TEXT, quantity REAL, price REAL, fee REAL);
    CREATE TABLE cash_ledger_settings (id INTEGER);`);
  assert.throws(() => migrateCashLedger(db, { apply: true }), /already exists/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'cash_ledger_migrations'").get().n, 0);
  assert.equal(db.isTransaction, false);
  console.log("Testy migracji gotówki: podgląd tylko do odczytu, pełna historia, prowizje, restart, idempotencja, rollback i zachowanie danych OK");
} finally {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
}
