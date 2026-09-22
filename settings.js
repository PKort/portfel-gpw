export function createSettingsStore(db) {
  if (!db.prepare("PRAGMA table_info(transactions)").all().some(column => column.name === "cost_method")) {
    db.exec("ALTER TABLE transactions ADD COLUMN cost_method TEXT CHECK(cost_method IN ('FIFO', 'AVP'))");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS portfolio_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    cost_method TEXT NOT NULL CHECK(cost_method IN ('FIFO', 'AVP'))
  );
  INSERT OR IGNORE INTO portfolio_settings VALUES (1, 'FIFO');`);
  const get = () => ({ costMethod: db.prepare("SELECT cost_method FROM portfolio_settings WHERE id = 1").get().cost_method });
  function save(input) {
    if (!["FIFO", "AVP"].includes(input?.costMethod)) {
      throw Object.assign(new Error("Wybierz metodę FIFO lub AVP."), { status: 400 });
    }
    db.prepare("UPDATE portfolio_settings SET cost_method = ? WHERE id = 1").run(input.costMethod);
    return get();
  }
  return { get, save };
}
