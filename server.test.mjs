import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const directory = await mkdtemp(join(tmpdir(), "portfel-api-"));
const child = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: "0", DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
const exited = once(child, "exit");
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Start serwera: timeout ${stderr}`)), 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
    child.stdout.on("data", chunk => {
      const match = String(chunk).match(/porcie (\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.match(await (await fetch(base + "/")).text(), /id="assets-view"/);
  const transaction = { costMethod: null, id: "test-buy", createdAt: 1, date: "2026-01-01", ticker: "OLD", type: "BUY", quantity: 10, price: 20, fee: 0 };
  assert.equal((await request("/api/transactions", "POST", transaction)).status, 201);
  assert.equal((await request("/api/quotes/OLD", "PUT", { price: 25 })).status, 200);
  assert.equal((await request("/api/state")).body.assets[0].ticker, "OLD");
  const definition = { ticker: "NEW", name: "Nowa nazwa", symbols: [{ platform: "GPW", symbol: "NEW" }] };
  assert.equal((await request("/api/assets/OLD", "PUT", definition)).status, 200);
  const state = (await request("/api/state")).body;
  assert.deepEqual(state.assets, [definition]);
  assert.equal(state.transactions[0].ticker, "NEW");
  assert.deepEqual(state.quotes, { NEW: 25 });
  assert.equal((await request("/api/assets", "POST", definition)).status, 409);
  assert.equal((await request("/api/assets/NEW", "PUT", { ...definition, name: "" })).status, 400);
  assert.equal((await request("/api/assets/MISSING", "PUT", definition)).status, 404);
  assert.equal((await request("/api/assets", "POST", { ticker: "SECOND", name: "Drugie aktywo", symbols: [] })).status, 201);
  const edited = { ...transaction, ticker: "EDIT", date: "2026-01-02", quantity: 12, price: 32.855, fee: 2 };
  const updated = await request("/api/transactions/test-buy", "PUT", { ...edited, id: "ignored", createdAt: 999 });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body, edited);
  const afterEdit = (await request("/api/state")).body;
  assert.deepEqual(afterEdit.transactions, [edited]);
  assert.ok(afterEdit.assets.some(asset => asset.ticker === "EDIT"));
  assert.equal((await request("/api/transactions/missing", "PUT", edited)).status, 404);
  for (const invalid of [{ quantity: 0 }, { price: -1 }, { fee: -1 }, { type: "INVALID" }]) {
    assert.equal((await request("/api/transactions/test-buy", "PUT", { ...edited, ...invalid })).status, 400);
  }
  const sale = { ...edited, id: "test-sell", createdAt: 2, date: "2026-01-03", type: "SELL", quantity: 8 };
  assert.equal((await request("/api/transactions", "POST", sale)).status, 201);
  for (const invalid of [{ quantity: 7 }, { date: "2026-01-04" }, { ticker: "OTHER" }, { type: "SELL" }]) {
    assert.equal((await request("/api/transactions/test-buy", "PUT", { ...edited, ...invalid })).status, 400);
    assert.deepEqual((await request("/api/state")).body.transactions, [edited, sale]);
  }
  const editedSale = { ...sale, quantity: 9, price: 40.125, fee: 1 };
  assert.equal((await request("/api/transactions/test-sell", "PUT", editedSale)).status, 200);
  assert.deepEqual((await request("/api/state")).body.transactions, [edited, editedSale]);
  assert.deepEqual((await request("/api/state")).body.settings, { costMethod: "FIFO" });
  assert.equal((await request("/api/settings", "PUT", { costMethod: "AVP" })).status, 200);
  assert.deepEqual((await request("/api/state")).body.settings, { costMethod: "AVP" });
  assert.equal((await request("/api/settings", "PUT", { costMethod: "INVALID" })).status, 400);
  assert.deepEqual((await request("/api/state")).body.settings, { costMethod: "AVP" });
  for (const method of ["FIFO", "AVP", null]) {
    assert.equal((await request("/api/transactions/test-sell", "PUT", { ...editedSale, costMethod: method })).status, 200);
    assert.equal((await request("/api/state")).body.transactions.find(item => item.id === "test-sell").costMethod, method);
  }
  assert.equal((await request("/api/transactions/test-sell", "PUT", { ...editedSale, costMethod: "INVALID" })).status, 400);
  assert.deepEqual((await request("/api/state")).body.transactions, [edited, editedSale]);
  const beforeBlockedRemoval = (await request("/api/state")).body;
  const blockedRemoval = await request("/api/assets/EDIT", "DELETE");
  assert.equal(blockedRemoval.status, 409);
  assert.match(blockedRemoval.body.error, /otwartą pozycją/);
  assert.deepEqual((await request("/api/state")).body, beforeBlockedRemoval);
  assert.equal((await request("/api/transactions/test-sell", "PUT", { ...editedSale, quantity: 12 })).status, 200);
  const beforeRemoval = (await request("/api/state")).body;
  assert.equal((await request("/api/assets/EDIT", "DELETE")).status, 200);
  assert.equal((await request("/api/assets/EDIT", "DELETE")).status, 404);
  const afterRemoval = (await request("/api/state")).body;
  assert.deepEqual(afterRemoval.transactions, beforeRemoval.transactions);
  assert.deepEqual(afterRemoval.quotes, beforeRemoval.quotes);
  assert.ok(!afterRemoval.assets.some(asset => asset.ticker === "EDIT"));
  assert.equal((await request("/api/quotes/EDIT", "PUT", { price: 42 })).status, 200);
  assert.equal((await request("/api/transactions", "POST", { ...edited, id: "buy-after-removal", createdAt: 3, date: "2026-01-04" })).status, 201);
  assert.ok(!(await request("/api/state")).body.assets.some(asset => asset.ticker === "EDIT"));
  assert.equal((await request("/api/assets/SECOND", "DELETE")).status, 200);
  assert.equal((await request("/api/state", "DELETE")).status, 200);
  const cleared = (await request("/api/state")).body;
  assert.equal(cleared.assets.length, 1);
  assert.equal(cleared.transactions.length, 0);
  assert.deepEqual(cleared.settings, { costMethod: "AVP" });
  assert.equal((await request("/api/demo", "POST")).status, 200);
  const demo = (await request("/api/state")).body;
  assert.equal(demo.transactions.length, 4);
  assert.ok(demo.transactions.every(item => item.costMethod === null));
  console.log("Testy API aktywów i edycji transakcji: OK");
} finally {
  child.kill();
  await exited;
  await rm(directory, { recursive: true, force: true });
}
