import { DatabaseSync, backup } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

function inspect(path) {
  if (!existsSync(path)) throw new Error(`Brak pliku bazy: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").all();
    if (check.length !== 1 || check[0].integrity_check !== "ok") throw new Error("Błąd integralności bazy.");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Błąd kluczy obcych.");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (!tables.some(row => row.name === "transactions")) throw new Error("To nie jest baza portfela.");
    const counts = Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n]));
    return { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), counts };
  } finally { db.close(); }
}

export async function snapshot(source, target) {
  source = resolve(source); target = resolve(target);
  if (!existsSync(source)) throw new Error("Nie znaleziono źródłowej bazy.");
  if (existsSync(target) || existsSync(`${target}.json`)) throw new Error("Plik docelowy lub manifest już istnieje; użyj nowej ścieżki.");
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
  try {
    chmodSync(target, 0o600);
    const report = { createdAt: new Date().toISOString(), ...inspect(target) };
    writeFileSync(`${target}.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return report;
  } catch (error) { unlinkSync(target); throw error; }
}

export function verify(path, manifestPath) {
  const expected = JSON.parse(readFileSync(manifestPath, "utf8"));
  const actual = inspect(path);
  if (actual.sha256 !== expected.sha256 || JSON.stringify(actual.counts) !== JSON.stringify(expected.counts)) throw new Error("Baza nie zgadza się z manifestem.");
  return actual;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [command, source, target] = process.argv.slice(2);
  if (!["snapshot", "verify", "inspect"].includes(command) || !source || (command !== "inspect" && !target)) {
    throw new Error("Użycie: node database-transfer.mjs snapshot SOURCE TARGET | verify DATABASE MANIFEST | inspect DATABASE");
  }
  const result = command === "snapshot" ? await snapshot(source, target) : command === "verify" ? verify(source, target) : inspect(source);
  console.log(JSON.stringify(result, null, 2));
}
