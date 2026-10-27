import { priceToUnits } from "./database.js";

export function yahooSymbol(ticker) {
  return `${ticker.toUpperCase()}.WA`;
}

export function parseYahooQuote(payload, symbol, currency, now = Date.now()) {
  const result = payload?.chart?.result;
  if (payload?.chart?.error || !Array.isArray(result) || result.length !== 1) throw new Error("Yahoo Finance: brak notowania instrumentu.");
  const meta = result[0]?.meta;
  if (meta?.symbol?.toUpperCase() !== symbol.toUpperCase() || meta.currency !== currency || meta.exchangeName !== "WSE") {
    throw new Error("Yahoo Finance: niezgodny symbol, waluta lub rynek instrumentu.");
  }
  const price = meta.regularMarketPrice;
  const quotedAt = meta.regularMarketTime * 1000;
  priceToUnits(price);
  if (!Number.isSafeInteger(quotedAt) || quotedAt <= 0 || quotedAt > now + 60_000) throw new Error("Yahoo Finance: nieprawidłowy czas notowania.");
  return { price, quotedAt, currency, priceType: "last", dedupKey: `${symbol.toUpperCase()}:${quotedAt}:${priceToUnits(price)}` };
}

export async function fetchYahooQuote(symbol, currency, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}\.WA$/i.test(symbol)) throw new Error("Podaj symbol GPW Yahoo Finance zakończony .WA.");
  let response;
  try {
    response = await fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`, {
      signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" }, redirect: "error",
    });
  } catch { throw new Error("Yahoo Finance: błąd połączenia lub przekroczony czas odpowiedzi."); }
  if (!response.ok) {
    const error = new Error(response.status === 404
      ? `Yahoo Finance: nie znaleziono symbolu ${symbol} (HTTP 404). Sprawdź symbol dostawcy w tabeli Aktywa; może różnić się od głównego tickera.`
      : `Yahoo Finance: HTTP ${response.status}.`);
    // Avoid retry storms when the provider limits requests or denies access.
    if ([401, 403, 429].includes(response.status)) error.backoff = true;
    throw error;
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Yahoo Finance: odpowiedź nie jest poprawnym JSON."); }
  return parseYahooQuote(payload, symbol, currency, now);
}
