import { transactionCashCents } from "./portfolio.js";

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

export function cashLedgerTotals(db) {
  const transactions = db.prepare("SELECT type, quantity, price, fee FROM transactions").all();
  const tradesCents = transactions.reduce((sum, item) => sum + transactionCashCents(item), 0);
  const sum = table => hasTable(db, table) ? db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ${table}`).get().total : 0;
  const depositsCents = sum("cash_deposits");
  const withdrawalsCents = sum("cash_withdrawals");
  const dividendsCents = sum("cash_dividends");
  const ledgerCents = tradesCents + depositsCents + dividendsCents - withdrawalsCents;
  if (![tradesCents, depositsCents, withdrawalsCents, dividendsCents, ledgerCents].every(Number.isSafeInteger)) throw new Error("Przekroczony zakres salda gotówki.");
  return { transactionCount: transactions.length, tradesCents, depositsCents, withdrawalsCents, dividendsCents, ledgerCents };
}

// Read-only by default. The snapshot records every discarded legacy offset.
export function migrateCashLedger(db, { apply = false, openingBalanceCents = 0 } = {}) {
  if (!Number.isSafeInteger(openingBalanceCents)) throw new Error("Nieprawidłowe saldo początkowe w groszach.");
  db.exec(apply ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const applied = hasTable(db, "cash_ledger_migrations") && db.prepare("SELECT * FROM cash_ledger_migrations WHERE version = 1").get();
    if (applied) {
      db.exec("COMMIT");
      return { applied: true, snapshot: JSON.parse(applied.snapshot) };
    }
    const row = hasTable(db, "portfolio_settings") ? db.prepare("SELECT * FROM portfolio_settings WHERE id = 1").get() : null;
    const totals = cashLedgerTotals(db);
    const report = {
      ...totals,
      legacyCashCents: row?.cash_cents ?? 0,
      legacyBaselineCents: row?.cash_baseline_cents ?? 0,
      previousBalanceCents: row?.cash_baseline_cents === undefined ? (row?.cash_cents ?? 0) : (row.cash_cents ?? 0) + totals.ledgerCents - row.cash_baseline_cents,
      openingBalanceCents,
      proposedBalanceCents: openingBalanceCents + totals.ledgerCents,
    };
    if (!Number.isSafeInteger(report.proposedBalanceCents)) throw new Error("Przekroczony zakres salda gotówki.");
    if (apply) {
      db.exec(`CREATE TABLE cash_ledger_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
        CREATE TABLE cash_ledger_settings (id INTEGER PRIMARY KEY CHECK(id = 1), adjustment_cents INTEGER NOT NULL);`);
      db.prepare("INSERT INTO cash_ledger_settings VALUES (1, ?)").run(openingBalanceCents);
      db.prepare("INSERT INTO cash_ledger_migrations VALUES (1, ?, ?)").run(Date.now(), JSON.stringify(report));
    }
    db.exec("COMMIT");
    return { applied: apply, snapshot: report };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
