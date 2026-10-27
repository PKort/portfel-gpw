export function calculatePortfolio(transactions, quotes = {}, defaultMethod = "FIFO") {
  return calculatePortfolioDetails(transactions, quotes, defaultMethod).positions;
}

export function calculatePortfolioDetails(transactions, quotes = {}, defaultMethod = "FIFO") {
  if (!["FIFO", "AVP"].includes(defaultMethod)) throw new Error("Nieprawidłowa metoda wyceny.");
  const saleResults = new Map();
  const lots = new Map();
  const realizedByTicker = new Map();
  const ordered = [...transactions].sort((a, b) =>
    a.date.localeCompare(b.date) || a.createdAt - b.createdAt
  );

  for (const transaction of ordered) {
    const ticker = transaction.ticker.toUpperCase();
    const tickerLots = lots.get(ticker) ?? [];
    lots.set(ticker, tickerLots);

    if (transaction.type === "BUY") {
      tickerLots.push({
        quantity: transaction.quantity,
        unitCost: transaction.price + transaction.fee / transaction.quantity,
      });
      continue;
    }

    const owned = tickerLots.reduce((sum, lot) => sum + lot.quantity, 0);
    if (transaction.quantity > owned + 1e-9) {
      throw new Error(`Sprzedaż ${ticker}: dostępne ${formatQuantity(owned)}, próba sprzedaży ${formatQuantity(transaction.quantity)}.`);
    }

    const method = transaction.costMethod ?? defaultMethod;
    if (!["FIFO", "AVP"].includes(method)) throw new Error("Nieprawidłowa metoda wyceny.");
    const averageAcquisitionCost = owned ? tickerLots.reduce((sum, lot) => sum + lot.quantity * lot.unitCost, 0) / owned : 0;
    let cost = 0;
    if (method === "AVP") {
      cost = averageAcquisitionCost * transaction.quantity;
      // AVP pools the remaining shares at their weighted acquisition cost.
      tickerLots.length = 0;
      if (owned - transaction.quantity > 1e-9) tickerLots.push({ quantity: owned - transaction.quantity, unitCost: averageAcquisitionCost });
    } else {
      let remaining = transaction.quantity;
      while (remaining > 1e-9) {
        const lot = tickerLots[0];
        const used = Math.min(remaining, lot.quantity);
        cost += used * lot.unitCost;
        lot.quantity -= used;
        remaining -= used;
        if (lot.quantity <= 1e-9) tickerLots.shift();
      }
    }
    const proceeds = transaction.quantity * transaction.price - transaction.fee;
    saleResults.set(transaction.id, { method, averageAcquisitionCost: cost / transaction.quantity, profit: proceeds - cost });
    realizedByTicker.set(ticker, (realizedByTicker.get(ticker) ?? 0) + proceeds - cost);
  }

  const tickers = new Set([...lots.keys(), ...realizedByTicker.keys()]);
  const positions = [...tickers].map((ticker) => {
    const tickerLots = lots.get(ticker) ?? [];
    const quantity = tickerLots.reduce((sum, lot) => sum + lot.quantity, 0);
    const cost = tickerLots.reduce((sum, lot) => sum + lot.quantity * lot.unitCost, 0);
    const quote = Number(quotes[ticker] ?? 0);
    const marketValue = quantity * quote;
    return {
      ticker,
      quantity,
      cost,
      averageCost: quantity ? cost / quantity : 0,
      quote,
      marketValue,
      unrealized: marketValue - cost,
      realized: realizedByTicker.get(ticker) ?? 0,
    };
  });

  return { positions: positions.sort((a, b) => a.ticker.localeCompare(b.ticker)), saleResults };
}

export function formatQuantity(value) {
  return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 6 }).format(value);
}

// Round each transaction's settlement to grosze before summing cash flows.
export function transactionCashCents(transaction) {
  const gross = transaction.quantity * transaction.price;
  const amount = transaction.type === "BUY" ? -(gross + transaction.fee) : gross - transaction.fee;
  const cents = Math.sign(amount) * Math.round((Math.abs(amount) + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) throw Object.assign(new Error("Przekroczony zakres kwoty transakcji."), { status: 400 });
  return cents;
}

export function calculateOperationHistory(transactions, cashOperations, currentCashBalance) {
  const operations = [
    ...transactions.map(item => ({ ...item, key: `STOCK/${item.id}`, isStock: true, cashChangeCents: transactionCashCents(item) })),
    ...cashOperations.map(item => ({ ...item, key: `${item.type}/${item.id}`, isStock: false,
      cashChangeCents: Math.round(item.amount * 100) * (item.type === "WITHDRAWAL" ? -1 : 1) })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  // The residual includes the opening balance and any explicit balance adjustment.
  let balanceCents = Math.round(currentCashBalance * 100) - operations.reduce((sum, item) => sum + item.cashChangeCents, 0);
  return operations.map(item => {
    balanceCents += item.cashChangeCents;
    return { ...item, cashBalanceAfter: balanceCents / 100 };
  }).reverse();
}

export function calculateTotalReturn(marketValue, cashBalance, cashOperations) {
  const depositsCents = cashOperations.filter(item => item.type === "DEPOSIT")
    .reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  const totalDeposits = depositsCents / 100;
  return { totalDeposits, returnRate: depositsCents > 0 ? (marketValue + cashBalance) / totalDeposits - 1 : null };
}
