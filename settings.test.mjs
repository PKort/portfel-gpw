import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore } from "./settings.js";

const directory = mkdtempSync(join(tmpdir(), "portfel-settings-"));
let db;
try {
  const path = join(directory, "portfolio.db");
  db = new DatabaseSync(path);
  db.exec(`CREATE TABLE transactions (id TEXT PRIMARY KEY, quantity REAL, price REAL);
    INSERT INTO transactions VALUES ('legacy', 2, 32.855);`);
  let settings = createSettingsStore(db);
  assert.deepEqual(settings.get(), { costMethod: "FIFO" });
  assert.deepEqual({ ...db.prepare("SELECT * FROM transactions").get() }, { id: "legacy", quantity: 2, price: 32.855, cost_method: null });
  settings.save({ costMethod: "AVP" });
  db.prepare("UPDATE transactions SET cost_method = 'FIFO' WHERE id = 'legacy'").run();
  assert.throws(() => settings.save({ costMethod: "OTHER" }), error => error.status === 400);
  assert.throws(() => settings.save(null), error => error.status === 400);
  assert.throws(() => db.exec("UPDATE transactions SET cost_method = 'OTHER'"));
  db.close();
  db = new DatabaseSync(path);
  settings = createSettingsStore(db);
  assert.deepEqual(settings.get(), { costMethod: "AVP" });
  assert.equal(db.prepare("SELECT cost_method FROM transactions").get().cost_method, "FIFO");
  createSettingsStore(db);
  assert.equal(db.prepare("PRAGMA table_info(transactions)").all().filter(column => column.name === "cost_method").length, 1);
  console.log("Testy migracji i trwałości ustawień FIFO/AVP: OK");
} finally {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
}
