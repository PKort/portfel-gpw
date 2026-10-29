import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

const directory = await mkdtemp(join(tmpdir(), "portfel-api-"));
const child = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: "0", DATA_DIR: directory, QUOTES_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"] });
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
  for (const path of ["/", "/index.html", "/app.js?v=15", "/portfolio.js", "/legacy-worker.js", "/styles.css"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache", path);
    await response.text();
  }
  for (const path of ["/api/state", "/api/missing"]) {
    const response = await fetch(base + path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    await response.text();
  }
  const request = async (path, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const page = await (await fetch(base + "/")).text();
  assert.match(page, /id="assets-view"/);
  assert.match(page, /Saldo gotówki po operacji/);
  assert.match(page, /Wszystkie operacje/);
  assert.match(page, /id="total-return"/);
  assert.match(page, /id="total-deposits"/);
  assert.doesNotMatch(page, /id="deposits-body"/);
  const transaction = { costMethod: null, id: "test-buy", createdAt: 1, date: "2026-01-01", ticker: "OLD", type: "BUY", quantity: 10, price: 20, fee: 0 };
  assert.equal((await request("/api/transactions", "POST", transaction)).status, 201);
  assert.equal((await request("/api/quotes/OLD", "PUT", { price: 25 })).status, 200);
  assert.equal((await request("/api/state")).body.assets[0].ticker, "OLD");
  const definition = { ticker: "NEW", name: "Nowa nazwa", symbols: [{ platform: "GPW", symbol: "NEW" }] };
  assert.equal((await request("/api/assets/OLD", "PUT", definition)).status, 200);
  const state = (await request("/api/state")).body;
  assert.deepEqual(state.assets, [{ ...definition, pinned: false }]);
  assert.equal((await request("/api/pins/NEW", "PUT", { pinned: true })).status, 200);
  assert.equal((await request("/api/state")).body.assets[0].pinned, true);
  assert.equal((await request("/api/pins/NEW", "PUT", { pinned: "true" })).status, 400);
  assert.equal((await request("/api/pins/MISSING", "PUT", { pinned: true })).status, 404);
  assert.equal((await request("/api/pins/NEW", "PUT", { pinned: false })).status, 200);
  assert.equal((await request("/api/state")).body.assets[0].pinned, false);
  assert.equal(state.transactions[0].ticker, "NEW");
  assert.deepEqual(state.quotes, { NEW: 25 });
  assert.equal((await request("/api/assets", "POST", definition)).status, 409);
  assert.equal((await request("/api/price-feeds/MISSING", "PUT", { symbol: "PKO.WA" })).status, 404);
  assert.equal((await request("/api/price-feeds/NEW", "PUT", { symbol: "https://example.com" })).status, 400);
  assert.deepEqual((await request("/api/quotes/refresh", "POST")).body, { status: "disabled", updated: 0, failed: 0 });
  assert.equal((await request("/api/quotes/refresh/NEW", "POST")).status, 409);
  assert.equal((await request("/api/quotes/refresh/MISSING", "POST")).status, 404);
  assert.equal((await request("/api/state")).body.quoteDetails.NEW.sourceId, "manual");
  assert.equal((await request("/api/assets/NEW", "PUT", { ...definition, name: "" })).status, 400);
  assert.equal((await request("/api/assets/MISSING", "PUT", definition)).status, 404);
  assert.equal((await request("/api/assets", "POST", { ticker: "SECOND", name: "Drugie aktywo", symbols: [] })).status, 201);
  assert.equal((await request("/api/price-feeds/SECOND", "PUT", { symbol: "pko.wa" })).status, 200);
  assert.equal((await request("/api/observed-assets")).body.find(asset => asset.ticker === "SECOND").sourceSymbol, "PKO.WA");
  const feedSettings = { sourceId: "bankier", symbols: { yahoo: "PKO.WA", bankier: "PKOBP" } };
  assert.equal((await request("/api/price-feeds/SECOND", "PUT", feedSettings)).status, 200);
  let secondFeed = (await request("/api/observed-assets")).body.find(asset => asset.ticker === "SECOND");
  assert.equal(secondFeed.sourceId, "bankier");
  assert.deepEqual(secondFeed.aliases, feedSettings.symbols);
  assert.equal((await request("/api/price-feeds/SECOND", "PUT", { sourceId: "yahoo", symbols: { yahoo: "PKO.WA" } })).status, 200);
  secondFeed = (await request("/api/observed-assets")).body.find(asset => asset.ticker === "SECOND");
  assert.equal(secondFeed.sourceId, "yahoo");
  assert.equal(secondFeed.aliases.bankier, "PKOBP");
  assert.equal((await request("/api/price-feeds/SECOND", "PUT", { sourceId: "bankier", symbols: { bankier: "PRIME" }, makeDefault: false })).status, 200);
  const aliasOnly = (await request("/api/observed-assets")).body.find(asset => asset.ticker === "SECOND");
  assert.equal(aliasOnly.sourceId, "yahoo");
  assert.equal(aliasOnly.sourceSymbol, "PKO.WA");
  assert.equal(aliasOnly.aliases.bankier, "PRIME");
  assert.equal((await request("/api/price-feeds/SECOND", "PUT", { sourceId: "bankier", symbols: { bankier: "PRIME" }, makeDefault: "false" })).status, 400);
  secondFeed = aliasOnly;
  assert.equal((await request("/api/price-feeds/SECOND", "PUT", { sourceId: "bankier", symbols: { bankier: "https://example.com" } })).status, 400);
  assert.equal((await request("/api/price-feeds/SECOND", "PUT", { sourceId: "unknown", symbols: {} })).status, 400);
  assert.deepEqual((await request("/api/observed-assets")).body.find(asset => asset.ticker === "SECOND").aliases, secondFeed.aliases);
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
  assert.deepEqual((await request("/api/state")).body.settings, { costMethod: "FIFO", cashBalance: -36.13 });
  assert.equal((await request("/api/settings", "PUT", { costMethod: "AVP" })).status, 200);
  assert.deepEqual((await request("/api/state")).body.settings, { costMethod: "AVP", cashBalance: -36.13 });
  assert.equal((await request("/api/settings", "PUT", { costMethod: "INVALID" })).status, 400);
  assert.deepEqual((await request("/api/state")).body.settings, { costMethod: "AVP", cashBalance: -36.13 });
  for (const method of ["FIFO", "AVP", null]) {
    assert.equal((await request("/api/transactions/test-sell", "PUT", { ...editedSale, costMethod: method })).status, 200);
    assert.equal((await request("/api/state")).body.transactions.find(item => item.id === "test-sell").costMethod, method);
  }
  assert.equal((await request("/api/transactions/test-sell", "PUT", { ...editedSale, costMethod: "INVALID" })).status, 400);
  assert.deepEqual((await request("/api/state")).body.transactions, [edited, editedSale]);
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
  const observer = new DatabaseSync(join(directory, "portfolio.db"));
  const observationsBeforeClear = observer.prepare("SELECT COUNT(*) AS n FROM price_observations").get().n;
  const observed = (await request("/api/observed-assets")).body;
  assert.ok(observed.every(asset => asset.status === "unconfigured"));
  assert.ok(!observed.some(asset => asset.ticker === "EDIT"));
  assert.equal((await request("/api/state", "DELETE")).status, 200);
  const cleared = (await request("/api/state")).body;
  assert.equal(cleared.assets.length, 1);
  assert.equal(cleared.transactions.length, 0);
  assert.deepEqual(cleared.quotes, { NEW: 25, EDIT: 42 });
  assert.deepEqual(cleared.settings, { costMethod: "AVP", cashBalance: 0 });
  assert.equal((await request("/api/demo", "POST")).status, 200);
  const demo = (await request("/api/state")).body;
  assert.equal(demo.transactions.length, 4);
  assert.ok(demo.transactions.every(item => item.costMethod === null));
  assert.equal(observer.prepare("SELECT COUNT(*) AS n FROM price_observations").get().n, observationsBeforeClear + 2);
  observer.close();
  // An open position may be archived; its transactions and prices stay available.
  assert.equal((await request("/api/assets/PKO", "DELETE")).status, 200);
  const archivedDemo = (await request("/api/state")).body;
  assert.equal(archivedDemo.transactions.length, 4);
  assert.equal(archivedDemo.quotes.PKO, 74.8);
  assert.ok(!archivedDemo.assets.some(asset => asset.ticker === "PKO"));
  assert.equal((await request("/api/assets", "POST", { ticker: "PKO", name: "Przywrócone PKO", symbols: [] })).status, 201);
  assert.ok((await request("/api/observed-assets")).body.some(asset => asset.ticker === "PKO"));
  await request("/api/state", "DELETE");
  assert.equal((await request("/api/state")).body.settings.cashBalance, 0);
  for (const input of [{ amount: -1, date: "2026-10-27" }, { amount: 0, date: "2026-10-27" }, { amount: 1.001, date: "2026-10-27" }, { amount: 10, date: "2026-02-30" }]) {
    assert.equal((await request("/api/cash-deposits", "POST", input)).status, 400);
  }
  assert.equal((await request("/api/cash-deposits", "POST", { amount: 1000, date: "2026-10-27" })).status, 201);
  const cashBuy = { ...transaction, id: "cash-buy", ticker: "PKO", quantity: 2, price: 100, fee: 5 };
  assert.equal((await request("/api/transactions", "POST", cashBuy)).status, 201);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 795);
  const cashSale = { ...cashBuy, id: "cash-sale", type: "SELL", createdAt: 2, quantity: 1, price: 120, fee: 3 };
  assert.equal((await request("/api/transactions", "POST", cashSale)).status, 201);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 912);
  assert.equal((await request("/api/transactions/cash-sale", "PUT", { ...cashSale, fee: 4 })).status, 200);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 911);
  await request("/api/transactions/cash-sale", "DELETE");
  assert.equal((await request("/api/state")).body.settings.cashBalance, 795);
  await request("/api/transactions/cash-buy", "DELETE");
  assert.equal((await request("/api/state")).body.settings.cashBalance, 1000);
  assert.equal((await request("/api/state")).body.cashDeposits.length, 1);
  const withdrawal = await request("/api/cash-operations", "POST", { type: "WITHDRAWAL", date: "2026-10-27", amount: 250 });
  assert.equal(withdrawal.status, 201);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 750);
  const cashPath = `/api/cash-operations/WITHDRAWAL/${withdrawal.body.id}`;
  assert.equal((await request(cashPath, "PUT", { date: "2026-10-26", amount: 300 })).status, 200);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 700);
  assert.equal((await request(cashPath, "PUT", { date: "2026-02-30", amount: 300 })).status, 400);
  assert.equal((await request("/api/cash-operations", "POST", { type: "OTHER", date: "2026-10-27", amount: 10 })).status, 400);
  assert.equal((await request("/api/state")).body.cashOperations.length, 2);
  assert.equal((await request(cashPath, "DELETE")).status, 200);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 1000);
  const dividend = await request("/api/cash-operations", "POST", { type: "DIVIDEND", ticker: "PKO", date: "2026-10-27", amount: 81.25 });
  assert.equal(dividend.status, 201);
  assert.equal(dividend.body.type, "DIVIDEND");
  assert.equal(dividend.body.ticker, "PKO");
  for (const ticker of [undefined, "", "UNKNOWN"]) assert.equal((await request("/api/cash-operations", "POST", { type: "DIVIDEND", date: "2026-10-27", amount: 10, ticker })).status, 400);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 1081.25);
  const dividendPath = `/api/cash-operations/DIVIDEND/${dividend.body.id}`;
  assert.equal((await request(dividendPath, "PUT", { ticker: "PKO", date: "2026-10-26", amount: 100 })).status, 200);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 1100);
  for (const amount of [0, -1, 1.001]) assert.equal((await request("/api/cash-operations", "POST", { type: "DIVIDEND", ticker: "PKO", date: "2026-10-27", amount })).status, 400);
  assert.equal((await request(dividendPath, "DELETE")).status, 200);
  assert.equal((await request("/api/state")).body.settings.cashBalance, 1000);
  console.log("Testy API aktywów i edycji transakcji: OK");
} finally {
  child.kill();
  await exited;
  await rm(directory, { recursive: true, force: true });
}
