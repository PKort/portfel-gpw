import { normalizeProviderSymbol } from './providers.js';
import { priceToUnits } from './database.js';

const baseUrl = 'https://bossaapi.statica.pl/v1';

function validateInfo(info, feed) {
  const symbol = normalizeProviderSymbol('bossa', feed.sourceSymbol);
  const isin = symbol.slice(4);
  if (info?.source !== 'GPW' || info.isin !== isin || (feed.isin && feed.isin !== isin) ||
      info.curr !== feed.currency || feed.currency !== 'PLN' || !['1', 1].includes(info.mult)) {
    throw new Error('bossaAPI: niezgodny rynek, ISIN, waluta lub nieobsługiwany mnożnik instrumentu.');
  }
  return symbol;
}

export function parseBossaQuote(payload, info, feed, now = Date.now()) {
  const symbol = validateInfo(info, feed);
  const data = payload?.[symbol];
  if (payload?.op !== 'data' || !data) throw new Error('bossaAPI: brak danych instrumentu w odpowiedzi.');
  const price = data.p;
  const quotedAt = data.t * 1000;
  priceToUnits(price);
  if (typeof data.t !== 'number' || !Number.isSafeInteger(quotedAt) || quotedAt <= 0 || quotedAt > now + 60_000) {
    throw new Error('bossaAPI: nieprawidłowy czas ostatniej transakcji.');
  }
  return { price, quotedAt, currency: feed.currency, priceType: 'last', dedupKey: `${symbol}:${quotedAt}:${priceToUnits(price)}` };
}

// One client per collector; the server loads credentials from .env at startup.
export function createBossaClient({ apiKey = process.env.BOSSA_QUOTES_API_KEY, fetchImpl = fetch, readKey = () => apiKey, now = Date.now } = {}) {
  const metadata = new Map();
  let cachedKey;
  async function request(path, key) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/${path}`, {
        headers: { Accept: 'application/json', Authorization: key }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new Error('bossaAPI: błąd połączenia lub przekroczony czas odpowiedzi.'); }
    let payload;
    try { payload = await response.json(); } catch {
      if (response.ok) throw new Error('bossaAPI: odpowiedź nie jest poprawnym JSON.');
    }
    if (!response.ok || payload?.op === 'error') {
      const code = response.ok ? Number(payload.code) : response.status;
      const descriptions = { 400: 'niepoprawne zapytanie', 401: 'brak dostępu lub wygasły klucz — sprawdź BOSSA_QUOTES_API_KEY w .env', 403: 'brak uprawnień do danych', 404: 'brak danych instrumentu', 429: 'przekroczony limit zapytań', 502: 'źródło danych jest niedostępne' };
      // Provider text and network errors can contain credentials. Never persist them.
      const error = new Error(`bossaAPI: ${descriptions[code] ?? 'błąd źródła danych'} (kod ${Number.isInteger(code) ? code : 'nieznany'}).`);
      if ([401, 403].includes(code)) error.backoffMs = 60 * 60_000;
      if (code === 429) {
        error.backoffMs = 60_000;
        const retry = response.headers?.get('retry-after');
        const delay = retry && (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now());
        if (Number.isFinite(delay) && delay > 0) error.backoffMs = Math.max(error.backoffMs, delay);
        if (path !== 'limits') {
          try {
            const limits = await request('limits', key);
            if (limits?.op === 'limits' && limits.month?.remaining === 0) {
              const date = new Date(now());
              // A conservative margin avoids assuming the provider's reset timezone.
              error.backoffMs = Math.max(error.backoffMs, Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 12) - now());
              error.message = 'bossaAPI: wyczerpany miesięczny limit punktów. Pobieranie wstrzymane do następnego miesiąca.';
            }
          } catch { /* A failed limits request must not cause a retry storm. */ }
        }
      }
      throw error;
    }
    return payload;
  }
  async function fetchBatch(feeds) {
    if (!feeds.length) return new Map();
    if (feeds.length > 20) throw new Error('bossaAPI: maksymalnie 20 instrumentów w zapytaniu.');
    let key;
    try { key = (await readKey())?.trim(); } catch {
      throw Object.assign(new Error('bossaAPI: nie można odczytać BOSSA_QUOTES_API_KEY. Sprawdź konfigurację .env.'), { backoffMs: 60_000 });
    }
    if (!key) throw Object.assign(new Error('bossaAPI: uzupełnij BOSSA_QUOTES_API_KEY w pliku .env i uruchom ponownie aplikację.'), { backoffMs: 60_000 });
    if (key === '0000' || /\s/.test(key)) throw Object.assign(new Error('bossaAPI: wymagany jest właściwy klucz notowań; klucz demo 0000 nie może służyć do wyceny.'), { backoffMs: 60_000 });
    if (key !== cachedKey) { metadata.clear(); cachedKey = key; }
    const results = new Map();
    const valid = [];
    for (const feed of feeds) {
      try { valid.push({ ...feed, sourceSymbol: normalizeProviderSymbol('bossa', feed.sourceSymbol) }); }
      catch (error) { results.set(feed.assetId, { error }); }
    }
    const missing = [...new Set(valid.filter(feed => !metadata.has(feed.sourceSymbol) || metadata.get(feed.sourceSymbol).expiresAt <= now()).map(feed => feed.sourceSymbol))];
    if (missing.length) {
      const info = await request(`info/${missing.join(',')}`, key);
      if (info?.op !== 'info') throw new Error('bossaAPI: nieprawidłowa odpowiedź z informacjami o instrumentach.');
      for (const symbol of missing) if (Object.hasOwn(info, symbol)) metadata.set(symbol, { info: info[symbol], expiresAt: now() + 24 * 60 * 60_000 });
    }
    const ready = [];
    for (const feed of valid) {
      try {
        // Validate identity and currency before spending points on a price request.
        validateInfo(metadata.get(feed.sourceSymbol)?.info, feed);
        ready.push(feed);
      } catch (error) { results.set(feed.assetId, { error }); }
    }
    if (ready.length) {
      const data = await request(`data/${[...new Set(ready.map(feed => feed.sourceSymbol))].join(',')}`, key);
      for (const feed of ready) {
        try { results.set(feed.assetId, { quote: parseBossaQuote(data, metadata.get(feed.sourceSymbol).info, feed, now()) }); }
        catch (error) { results.set(feed.assetId, { error }); }
      }
    }
    return results;
  }
  return { fetchBatch };
}
