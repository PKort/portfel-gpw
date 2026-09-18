import assert from "node:assert/strict";
import { calculatePortfolio } from "./portfolio.js";

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
console.log("Testy obliczeń FIFO: OK");
