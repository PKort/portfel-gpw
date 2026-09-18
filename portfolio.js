export function calculatePortfolio(transactions, quotes = {}) {
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

    let remaining = transaction.quantity;
    let cost = 0;
    while (remaining > 1e-9) {
      const lot = tickerLots[0];
      const used = Math.min(remaining, lot.quantity);
      cost += used * lot.unitCost;
      lot.quantity -= used;
      remaining -= used;
      if (lot.quantity <= 1e-9) tickerLots.shift();
    }
    const proceeds = transaction.quantity * transaction.price - transaction.fee;
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

  return positions.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function formatQuantity(value) {
  return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 6 }).format(value);
}
