import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { migrateCashLedger } from "./cash-ledger.js";

const args = process.argv.slice(2);
const path = args[0];
if (!path || args.slice(1).some(arg => arg !== "--apply" && !/^--opening-cents=-?\d+$/.test(arg))) {
  console.error("Użycie: node migrate-cash.js /ścieżka/portfolio.db [--opening-cents=0] [--apply]");
  process.exit(1);
}
if (!existsSync(path)) throw new Error("Nie znaleziono bazy. Podaj ścieżkę do istniejącego pliku.");
const apply = args.includes("--apply");
const opening = args.find(arg => arg.startsWith("--opening-cents="));
const db = new DatabaseSync(resolve(path), { readOnly: !apply });
try {
  console.log(JSON.stringify(migrateCashLedger(db, { apply, openingBalanceCents: opening ? Number(opening.split("=")[1]) : 0 }), null, 2));
} finally { db.close(); }
