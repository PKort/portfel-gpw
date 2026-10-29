import assert from "node:assert/strict";
import { calculatePortfolio, calculatePortfolioDetails, transactionCashCents, calculateOperationHistory, calculateTotalReturn, selectWatchedPositions } from "./portfolio.js";

const tx = [
  { date: "2026-01-01", createdAt: 1, ticker: "PKO", type: "BUY", quantity: 10, price: 100, fee: 5 },
  { date: "2026-02-01", createdAt: 2, ticker: "PKO", type: "BUY", quantity: 10, price: 120, fee: 5 },
  { date: "2026-03-01", createdAt: 3, ticker: "PKO", type: "SELL", quantity: 12, price: 130, fee: 6 },
];

const [position] = calculatePortfolio(tx, { PKO: 125 });
assert.equal(position.quantity, 8);
assert.equal(position.cost, 964);
assert.equal(position.marketValue, 1000);
assert.equal(position.unrealized, 36);
assert.equal(position.realized, 308);
assert.throws(() => calculatePortfolio([...tx, { date: "2026-04-01", createdAt: 4, ticker: "PKO", type: "SELL", quantity: 9, price: 130, fee: 0 }]));
// Multiple purchases and sales of one ticker remain a single portfolio position.
const grouped = calculatePortfolio([
  ...tx,
  { date: "2026-04-01", createdAt: 4, ticker: "pko", type: "BUY", quantity: 2, price: 110, fee: 0 },
  { date: "2026-04-01", createdAt: 5, ticker: "CDR", type: "BUY", quantity: 3, price: 200, fee: 0 },
], { PKO: 125, CDR: 210 });
assert.deepEqual(grouped.map(item => item.ticker), ["CDR", "PKO"]);
assert.equal(grouped[1].quantity, 10);
assert.equal(grouped[1].cost, 1184);
assert.equal(grouped[1].marketValue, 1250);
assert.equal(grouped[1].realized, 308);
console.log("Testy obliczeń FIFO i grupowania po tickerze: OK");

const history = tx.map((item, index) => ({ ...item, id: `tx-${index}` }));
const snapshot = JSON.stringify(history);
const details = calculatePortfolioDetails(history);
assert.deepEqual(details.positions, calculatePortfolio(history));
assert.equal(details.saleResults.size, 1);
assert.deepEqual(details.saleResults.get("tx-2"), { method: "FIFO", averageAcquisitionCost: 1246 / 12, profit: 308 });
assert.equal(details.saleResults.has("tx-0"), false);
assert.equal(JSON.stringify(history), snapshot);

const laterHistory = [
  ...history,
  { id: "loss", date: "2026-03-01", createdAt: 4, ticker: "pko", type: "SELL", quantity: 2, price: 110, fee: 1 },
  { id: "later-buy", date: "2026-03-01", createdAt: 5, ticker: "PKO", type: "BUY", quantity: 2, price: 200, fee: 0 },
  { id: "close", date: "2026-04-01", createdAt: 6, ticker: "PKO", type: "SELL", quantity: 8, price: 150, fee: 2 },
  { id: "reopen", date: "2026-05-01", createdAt: 7, ticker: "PKO", type: "BUY", quantity: 2, price: 32.855, fee: 0 },
  { id: "zero", date: "2026-05-02", createdAt: 8, ticker: "PKO", type: "SELL", quantity: 2, price: 32.855, fee: 0 },
  { id: "other-buy", date: "2026-01-01", createdAt: 9, ticker: "CDR", type: "BUY", quantity: 0.5, price: 10, fee: 1 },
  { id: "other-sell", date: "2026-02-01", createdAt: 10, ticker: "CDR", type: "SELL", quantity: 0.25, price: 16, fee: 0.5 },
];
const results = calculatePortfolioDetails([...laterHistory].reverse()).saleResults;
assert.deepEqual(results.get("tx-2"), details.saleResults.get("tx-2"));
assert.deepEqual(results.get("loss"), { method: "FIFO", averageAcquisitionCost: 120.5, profit: -22 });
assert.deepEqual(results.get("close"), { method: "FIFO", averageAcquisitionCost: 140.375, profit: 75 });
assert.deepEqual(results.get("zero"), { method: "FIFO", averageAcquisitionCost: 32.855, profit: 0 });
assert.deepEqual(results.get("other-sell"), { method: "FIFO", averageAcquisitionCost: 12, profit: 0.5 });
const editedHistory = history.map(item => item.id === "tx-0" ? { ...item, price: 90 } : item);
assert.equal(calculatePortfolioDetails(editedHistory).saleResults.get("tx-2").profit, 408);
const avp = calculatePortfolioDetails(history, { PKO: 125 }, "AVP");
assert.deepEqual(avp.saleResults.get("tx-2"), { method: "AVP", averageAcquisitionCost: 110.5, profit: 228 });
assert.equal(avp.positions[0].cost, 884);
assert.equal(avp.positions[0].realized, 228);
assert.equal(avp.positions[0].unrealized, 116);
const avpLater = calculatePortfolioDetails(laterHistory, {}, "AVP");
assert.equal(avpLater.saleResults.get("loss").profit, -2);
assert.equal(avpLater.saleResults.get("close").profit, 135);
assert.equal(avpLater.saleResults.get("zero").profit, 0);

// Explicit per-sale methods override the default in both directions.
const forceFIFO = history.map(item => item.type === "SELL" ? { ...item, costMethod: "FIFO" } : item);
assert.deepEqual(calculatePortfolioDetails(forceFIFO, {}, "AVP"), details);
const forceAVP = history.map(item => item.type === "SELL" ? { ...item, costMethod: "AVP" } : item);
assert.deepEqual(calculatePortfolioDetails(forceAVP, { PKO: 125 }), avp);
const inherit = forceAVP.map(item => ({ ...item, costMethod: null }));
assert.deepEqual(calculatePortfolioDetails(inherit), details);

const mixed = laterHistory.map(item => item.id === "tx-2" ? { ...item, costMethod: "AVP" } : item);
const mixedDetails = calculatePortfolioDetails(mixed);
assert.equal(mixedDetails.saleResults.get("loss").method, "FIFO");
assert.equal(mixedDetails.saleResults.get("loss").profit, -2);
assert.equal(mixedDetails.saleResults.get("close").profit, 135);
for (const method of ["FIFO", "AVP"]) {
  for (const rows of [history, laterHistory, mixed]) {
    const result = calculatePortfolioDetails(rows, { PKO: 125, CDR: 20 }, method);
    const sum = [...result.saleResults.values()].reduce((total, sale) => total + sale.profit, 0);
    assert.ok(Math.abs(sum - result.positions.reduce((total, position) => total + position.realized, 0)) < 1e-9);
    const buys = rows.filter(item => item.type === "BUY").reduce((total, item) => total + item.quantity * item.price + item.fee, 0);
    const sales = rows.filter(item => item.type === "SELL").reduce((total, item) => total + item.quantity * item.price - item.fee, 0);
    assert.ok(Math.abs(buys - (sales - sum) - result.positions.reduce((total, position) => total + position.cost, 0)) < 1e-9);
  }
  assert.throws(() => calculatePortfolioDetails([{ ...history[2], quantity: 1 }], {}, method), /dostępne/);
}
assert.throws(() => calculatePortfolioDetails(history, {}, "INVALID"));
assert.throws(() => calculatePortfolioDetails(history.map(item => ({ ...item, costMethod: "INVALID" }))));
console.log("Testy wyników FIFO/AVP, nadpisania metody i zgodności podsumowania: OK");

assert.equal(transactionCashCents({ type: "BUY", quantity: 2, price: 100, fee: 5 }), -20500);
assert.equal(transactionCashCents({ type: "SELL", quantity: 2, price: 120, fee: 3 }), 23700);
assert.equal(transactionCashCents({ type: "BUY", quantity: 1, price: 1.005, fee: 0 }), -101);
assert.equal(transactionCashCents({ type: "SELL", quantity: 1, price: 0, fee: 3 }), -300);

const historyTrades = [
  { id: "b", type: "BUY", date: "2026-01-02", createdAt: 2, quantity: 2, price: 100, fee: 5 },
  { id: "s", type: "SELL", date: "2026-01-03", createdAt: 3, quantity: 1, price: 120, fee: 3 },
];
const historyCash = [
  { id: 1, type: "DEPOSIT", date: "2026-01-01", createdAt: 10, amount: 1000 },
  { id: 1, type: "DIVIDEND", date: "2026-01-03", createdAt: 4, amount: 81.25 },
  { id: 1, type: "WITHDRAWAL", date: "2026-01-04", createdAt: 5, amount: 100 },
];
const combined = calculateOperationHistory(historyTrades, historyCash, 943.25); // Opening balance 50.
assert.deepEqual(combined.map(item => item.type), ["WITHDRAWAL", "DIVIDEND", "SELL", "BUY", "DEPOSIT"]);
assert.deepEqual(combined.map(item => item.cashBalanceAfter), [943.25, 1043.25, 962, 845, 1050]);
assert.equal(new Set(combined.map(item => item.key)).size, 5);
assert.deepEqual(calculateOperationHistory([], [], 50), []);
assert.equal(calculateOperationHistory([historyTrades[0]], [], -205)[0].cashBalanceAfter, -205);
assert.deepEqual(calculateOperationHistory([...historyTrades].reverse(), [...historyCash].reverse(), 943.25), combined);
const sameTime = historyCash.map(item => ({ ...item, date: "2026-01-01", createdAt: 1 }));
assert.deepEqual(calculateOperationHistory([], sameTime, 981.25), calculateOperationHistory([], [...sameTime].reverse(), 981.25));
assert.equal(historyTrades[0].cashBalanceAfter, undefined);
assert.deepEqual(calculateOperationHistory([{ ...historyTrades[0], fee: 6 }], historyCash, 725.25).map(item => item.cashBalanceAfter), [725.25, 825.25, 744, 950]);
console.log("Testy wspólnej historii i salda po operacji: OK");

const returnCash = [{ type: "DEPOSIT", amount: 600 }, { type: "DEPOSIT", amount: 400 }, { type: "DIVIDEND", amount: 100 }, { type: "WITHDRAWAL", amount: 50 }];
assert.deepEqual(calculateTotalReturn(800, 300, returnCash), { totalDeposits: 1000, returnRate: 0.10000000000000009 });
assert.equal(calculateTotalReturn(700, 300, returnCash).returnRate, 0);
assert.ok(Math.abs(calculateTotalReturn(600, 200, returnCash).returnRate + 0.2) < 1e-12);
assert.equal(calculateTotalReturn(0, 0, returnCash).returnRate, -1);
assert.equal(calculateTotalReturn(0, -100, returnCash).returnRate, -1.1);
assert.deepEqual(calculateTotalReturn(800, 300, []), { totalDeposits: 0, returnRate: null });
assert.equal(calculateTotalReturn(800, 300, [{ type: "DIVIDEND", amount: 100 }]).returnRate, null);
assert.equal(calculateTotalReturn(0.1, 0.2, [{ type: "DEPOSIT", amount: 0.1 }, { type: "DEPOSIT", amount: 0.2 }]).totalDeposits, 0.3);
console.log("Testy wyniku całego portfela: wzrost, strata, brak wpłat, dywidendy i wypłaty OK");

const ownedRows = [{ ticker: "OWN", quantity: 2, marketValue: 200 }, { ticker: "SOLD", quantity: 0, marketValue: 0 }];
const watchRows = selectWatchedPositions(ownedRows, [{ ticker: "OWN", pinned: true }, { ticker: "WATCH", pinned: true }, { ticker: "SOLD", pinned: true }, { ticker: "HIDDEN", pinned: false }], { WATCH: 12, SOLD: 20 });
assert.deepEqual(watchRows.map(row => row.ticker), ["OWN", "SOLD", "WATCH"]);
assert.equal(watchRows[0].watchOnly, false);
assert.equal(watchRows[1].watchOnly, true);
assert.equal(watchRows[2].quote, 12);
assert.equal(selectWatchedPositions([], [{ ticker: "MISSING", pinned: true }], {})[0].quote, null);
assert.equal(selectWatchedPositions(ownedRows, [], {}).length, 1);
assert.equal(ownedRows[0].pinned, undefined);
console.log("Testy obserwowanych: bez pozycji, zamknięte pozycje, bez duplikatów i brak kursu OK");
