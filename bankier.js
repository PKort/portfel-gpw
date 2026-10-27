import { priceToUnits } from "./database.js";

function warsawTimestamp(text) {
  const match = text.match(/\b(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?\b/);
  if (!match) throw new Error("Bankier.pl: brak daty notowania.");
  const [, y, m, d, h, min, sec = '00'] = match;
  const expected = `${y}-${m}-${d} ${h}:${min}:${sec}`;
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const base = Date.UTC(+y, +m - 1, +d, +h, +min, +sec);
  const candidates = [1, 2].map(offset => base - offset * 3600000).filter(time => format.format(time) === expected);
  if (candidates.length !== 1) throw new Error("Bankier.pl: nieprawidłowa lub niejednoznaczna data notowania.");
  return candidates[0];
}
const clean = text => text.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/\u00a0|\u202f/g, ' ').trim();

export function parseBankierQuote(html, symbol, currency, now = Date.now(), expectedIsin = null) {
  if (typeof html !== 'string' || html.length > 4_000_000) throw new Error("Bankier.pl: nieprawidłowa odpowiedź.");
  const start = html.search(/\bid=["']quotes-profile-header-box["']/i);
  if (start < 0) throw new Error("Bankier.pl: brak danych instrumentu lub zmieniony format strony.");
  const section = html.slice(start, start + 30000);
  const attributes = section.slice(0, section.indexOf('>'));
  const actualSymbol = attributes.match(/\bdata-symbol=["']([^"']+)["']/i)?.[1];
  const isin = attributes.match(/\bdata-isin=["']([^"']+)["']/i)?.[1];
  if (actualSymbol?.toUpperCase() !== symbol.toUpperCase() || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin ?? '') || (expectedIsin && expectedIsin !== isin)) throw new Error("Bankier.pl: niezgodny symbol lub ISIN instrumentu.");
  const priceText = clean(section.match(/<div\b[^>]*class=["'][^"']*\bo-quotes-profile-header-box__price\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '');
  if (currency !== 'PLN' || !/^(?:\d[\d ]*)(?:,\d{1,6})?\s*(?:zł|PLN)$/.test(priceText)) throw new Error("Bankier.pl: brak poprawnej ceny w PLN.");
  const price = Number(priceText.replace(/zł|PLN|\s/g, '').replace(',', '.'));
  priceToUnits(price);
  const dateText = clean(section.match(/<span\b[^>]*class=["'][^"']*\s?-date\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
  const quotedAt = warsawTimestamp(dateText);
  if (quotedAt > now + 60000) throw new Error("Bankier.pl: czas notowania jest w przyszłości.");
  return { price, currency, priceType: 'last', quotedAt, dedupKey: `${symbol.toUpperCase()}:${quotedAt}:${priceToUnits(price)}` };
}

export async function fetchBankierQuote(symbol, currency, { fetchImpl = fetch, now = Date.now(), isin = null } = {}) {
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/i.test(symbol)) throw new Error("Bankier.pl: nieprawidłowy alias instrumentu.");
  let response;
  try {
    response = await fetchImpl(`https://www.bankier.pl/inwestowanie/profile/quote.html?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'text/html' } });
  } catch { throw new Error("Bankier.pl: błąd połączenia lub przekroczony czas odpowiedzi."); }
  if (!response.ok) {
    const error = new Error(`Bankier.pl: HTTP ${response.status}.`);
    if ([401, 403, 429].includes(response.status)) error.backoff = true;
    throw error;
  }
  return parseBankierQuote(await response.text(), symbol, currency, now, isin);
}
