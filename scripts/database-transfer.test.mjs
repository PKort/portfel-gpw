import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshot, verify } from "./database-transfer.mjs";
const dir = mkdtempSync(join(tmpdir(), "portfolio-transfer-"));
const source = join(dir, "source.db"), target = join(dir, "portfolio.db");
let db;
try {
  db = new DatabaseSync(source);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE transactions(id TEXT PRIMARY KEY); INSERT INTO transactions VALUES ('preserved')");
  const report = await snapshot(source, target);
  assert.equal(report.counts.transactions, 1);
  assert.equal(verify(target, `${target}.json`).sha256, report.sha256);
  await assert.rejects(snapshot(source, target), /już istnieje/);
  assert.throws(() => verify(target, source), /JSON/);
  const manifest = JSON.parse(readFileSync(`${target}.json`));
  manifest.sha256 = "wrong";
  writeFileSync(`${target}.json`, JSON.stringify(manifest));
  assert.throws(() => verify(target, `${target}.json`), /manifestem/);
  console.log("Test transferu bazy: spójna kopia z WAL, integralność, manifest i ochrona przed nadpisaniem OK");
} finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
